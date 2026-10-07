/**
 * 试玩场景：把当前网格渲染成游戏世界，用真实 Platformer 物理 + 游戏按键操作。
 * 逻辑与 GameScene 对齐（机关判定、移动平台、检查点、传送门触发），不含存档/HUD/UI。
 * 通关或按 Esc 返回编辑器。
 */

import Phaser from 'phaser';
import { CAMERA, COLORS, PLAYER, TILE } from '../core/config.ts';
import { Input, actionFor } from '../core/controls.ts';
import { Platformer } from '../core/platformer.ts';
import type { Rect } from '../core/platformer.ts';
import { standPos } from '../core/map-format.ts';
import { paintPlayTile } from './tile-painter.ts';

interface Mover {
  rect: Rect;
  gfx: Phaser.GameObjects.Rectangle;
  axis: 'x' | 'y';
  origin: number;
  range: number;
  speed: number;
  t: number;
  dx: number;
  /** 上一帧是否载着玩家（持续乘坐判定用） */
  carrying?: boolean;
}
interface Coin {
  sprite: Phaser.GameObjects.Rectangle;
  taken: boolean;
}
interface Checkpoint {
  x: number;
  y: number;
  tileX: number;
  tileY: number;
  flag: Phaser.GameObjects.Rectangle;
  activated: boolean;
}

export class PlayScene extends Phaser.Scene {
  private rows: string[] = [];
  private w = 0;
  private h = 0;

  private player!: Platformer;
  private playerGfx!: Phaser.GameObjects.Container;
  private ctl = new Input();
  private coins: Coin[] = [];
  private checkpoints: Checkpoint[] = [];
  private movers: Mover[] = [];
  private exitRects: Phaser.Geom.Rectangle[] = [];
  private solids: boolean[][] = [];
  private platforms: boolean[][] = [];

  private respawnPoint = { x: 0, y: 0 };
  private deaths = 0;
  private elapsed = 0;
  private state: 'playing' | 'dead' | 'win' = 'playing';
  private cam!: Phaser.Cameras.Scene2D.Camera;

  constructor() {
    super('play');
  }

  init(data: { rows: string[] }) {
    this.rows = data.rows.map((r) => r);
    this.w = Math.max(0, ...this.rows.map((r) => r.length));
    this.h = this.rows.length;
    this.coins = [];
    this.checkpoints = [];
    this.movers = [];
    this.exitRects = [];
    this.ctl = new Input();
    this.deaths = 0;
    this.elapsed = 0;
    this.state = 'playing';
  }

  create() {
    this.buildCollisionGrids();
    this.buildTiles();
    this.buildEntities();
    this.buildPlayer();
    this.buildCamera();
    this.bindInput();

    this.events.emit('play:ready', {
      width: this.w,
      height: this.h,
      spawn: { ...this.respawnPoint },
    });
  }

  // ---------- 世界 ----------

  private at(x: number, y: number): string {
    return y >= 0 && y < this.h ? (this.rows[y][x] ?? '.') : '.';
  }

  private buildCollisionGrids() {
    this.solids = Array.from({ length: this.h }, (_, y) =>
      Array.from({ length: this.w }, (_, x) => this.at(x, y) === '#'),
    );
    this.platforms = Array.from({ length: this.h }, (_, y) =>
      Array.from({ length: this.w }, (_, x) => this.at(x, y) === '='),
    );
  }

  private rectHitsGrid(r: Rect, grid: boolean[][]) {
    const x0 = Math.floor(r.x / TILE);
    const y0 = Math.floor(r.y / TILE);
    const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
    const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (grid[y]?.[x]) return true;
    return false;
  }

  private isSolid = (r: Rect) => {
    // 只判定静态网格：移动平台是单向平台，不做实体碰撞（否则会被顶/压穿模）
    return this.rectHitsGrid(r, this.solids);
  };

  private oneWayTop = (r: Rect): number | null => {
    const x0 = Math.floor(r.x / TILE);
    const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
    const y0 = Math.floor(r.y / TILE);
    const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
    let top: number | null = null;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (this.platforms[y]?.[x]) {
          const t = y * TILE;
          if (top === null || t < top) top = t;
        }
    // 移动平台不参与单向落脚判定：落脚完全由 updateMovers 的载人判定负责
    // （单向实体碰撞已移除，平台体会从玩家身上扫过而不产生 push-out）
    return top;
  };

  // ---------- 视觉 ----------

  private buildTiles() {
    const gfx = this.add.graphics();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        paintPlayTile(gfx, x, y, this.at(x, y), this.rows);
      }
    }

    // 出口传送门（与 GameScene 一致：偏高门 + 触发框）
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.at(x, y) !== 'E') continue;
        const e = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
        const portal = this.add.rectangle(e.x, e.y - 4, 12, 28, 0x8ff0a4).setStrokeStyle(2, 0x2ecc71);
        this.add.rectangle(e.x, e.y - 4, 4, 20, 0x2ecc71);
        this.tweens.add({
          targets: portal,
          scaleY: 1.1,
          alpha: 0.7,
          yoyo: true,
          repeat: -1,
          duration: 700,
          ease: 'Sine.easeInOut',
        });
        this.exitRects.push(new Phaser.Geom.Rectangle(e.x - 6, e.y - 20, 12, 30));
      }
    }
  }

  private buildEntities() {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const ch = this.at(x, y);
        const px = x * TILE + TILE / 2;
        const py = y * TILE + TILE / 2;

        if (ch === 'o') {
          const rect = this.add.rectangle(px, py, 8, 8, 0xffd866).setStrokeStyle(1, 0xd4a017);
          this.tweens.add({ targets: rect, angle: 360, repeat: -1, duration: 1200, ease: 'Linear' });
          this.coins.push({ sprite: rect, taken: false });
        }
        if (ch === 'C') {
          const flag = this.add.rectangle(px, py - 4, 10, 8, 0x95a5a6);
          this.add.rectangle(px, py + 4, 2, 10, 0x7f8c8d);
          this.checkpoints.push({ x: px, y: py, tileX: x, tileY: y, flag, activated: false });
        }
        if (ch === 'M' || ch === 'm') {
          const w = TILE * 2.5;
          const h = 10;
          const gfx = this.add.rectangle(px, py, w, h, 0x9b59b6).setStrokeStyle(2, 0x8e44ad);
          this.movers.push({
            rect: { x: px - w / 2, y: py - h / 2, w, h },
            gfx,
            axis: ch === 'M' ? 'x' : 'y',
            origin: ch === 'M' ? px : py,
            range: TILE * 2,
            speed: 1.6,
            t: 0,
            dx: 0,
          });
        }
      }
    }
  }

  private buildPlayer() {
    let sx = 1;
    let sy = 1;
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++)
        if (this.at(x, y) === 'S') {
          sx = x;
          sy = y;
        }
    this.respawnPoint = standPos(sx, sy);

    this.player = new Platformer(this.respawnPoint.x, this.respawnPoint.y);
    const body = this.add.rectangle(0, 0, PLAYER.width, PLAYER.height, 0xffcd75);
    const visor = this.add.rectangle(3, -4, 4, 3, 0x1a1c2c);
    this.playerGfx = this.add.container(0, 0, [body, visor]);
  }

  private buildCamera() {
    this.cam = this.cameras.main;
    this.cam.setBounds(0, 0, this.w * TILE, this.h * TILE);
    this.cam.setBackgroundColor(COLORS.skyTop);
    this.cam.setZoom(2);
    this.cam.startFollow(this.playerGfx, false, CAMERA.lerp, CAMERA.lerp);
    this.cam.setDeadzone(CAMERA.deadzoneX * 4, CAMERA.deadzoneY * 4);
    this.cam.setFollowOffset(-CAMERA.ahead, 0);
  }

  // ---------- 输入 ----------

  private bindInput() {
    this.input.keyboard!.on('keydown', (e: KeyboardEvent) => {
      if (actionFor(e.code)) e.preventDefault();
      this.ctl.handleDown(e);
      const action = actionFor(e.code);
      if (action === 'pause' && this.state === 'playing') this.exitToEditor();
      if (action === 'restart' && this.state === 'playing') this.killPlayer();
    });
    this.input.keyboard!.on('keyup', (e: KeyboardEvent) => this.ctl.handleUp(e));
  }

  private exitToEditor() {
    if (this.state === 'win') return;
    this.events.emit('play:exit');
  }

  // ---------- 流程 ----------

  private killPlayer() {
    if (this.state !== 'playing') return;
    this.state = 'dead';
    this.deaths++;
    this.events.emit('play:died', this.deaths);
    this.time.delayedCall(420, () => {
      this.player.respawn(this.respawnPoint.x, this.respawnPoint.y);
      this.playerGfx.setPosition(this.player.cx, this.player.cy);
      this.state = 'playing';
    });
  }

  private win() {
    if (this.state !== 'playing') return;
    this.state = 'win';
    this.events.emit('play:win', { deaths: this.deaths, ms: Math.floor(this.elapsed * 1000) });
  }

  // ---------- 帧循环 ----------

  update(_time: number, delta: number) {
    if (this.state !== 'playing') return;
    const dt = Math.min(delta / 1000, 1 / 30);
    this.elapsed += dt;

    this.updateMovers(dt);

    const inp = {
      left: this.ctl.down('left'),
      right: this.ctl.down('right'),
      up: this.ctl.down('up'),
      jumpHeld: this.ctl.down('jump'),
      jumpPressed: this.ctl.just('jump'),
      dashPressed: this.ctl.just('dash'),
      down: this.ctl.down('down'),
    };
    this.ctl.clearJust();

    this.player.step(inp, dt, { isSolid: this.isSolid, oneWayTop: this.oneWayTop });

    this.playerGfx.setPosition(this.player.cx, this.player.cy);
    this.playerGfx.setScale(this.player.facing, 1);

    const bodyRect = this.playerGfx.first as Phaser.GameObjects.Rectangle;
    if (this.player.state === 'dash') bodyRect.setFillStyle(0x8ff0a4);
    else if (this.player.state === 'wall-slide') bodyRect.setFillStyle(0xf39c12);
    else bodyRect.setFillStyle(0xffcd75);

    this.checkHazards();
    this.checkCoins();
    this.checkCheckpoints();
    this.checkExit();

    if (this.player.cy > this.h * TILE + 60) this.killPlayer();

    this.events.emit('play:tick', {
      ms: Math.floor(this.elapsed * 1000),
      deaths: this.deaths,
    });
  }

  private updateMovers(dt: number) {
    for (const m of this.movers) {
      m.t += dt;
      const off = Math.sin(m.t * m.speed) * m.range;
      const nx = m.axis === 'x' ? m.origin + off : m.rect.x + m.rect.w / 2;
      const ny = m.axis === 'y' ? m.origin + off : m.rect.y + m.rect.h / 2;
      m.dx = nx - (m.rect.x + m.rect.w / 2);
      m.rect.x = nx - m.rect.w / 2;
      m.rect.y = ny - m.rect.h / 2;
      m.gfx.setPosition(nx, ny);

      const b = this.player.body;
      const feet = b.y + b.h;
      const wasCarried = m.carrying === true;
      const horizontallyOn = b.x + b.w > m.rect.x && b.x < m.rect.x + m.rect.w;
      const centerOver = b.x + b.w / 2 > m.rect.x && b.x + b.w / 2 < m.rect.x + m.rect.w;
      const onTop =
        feet >= m.rect.y - 3 &&
        feet <= m.rect.y + 5 &&
        horizontallyOn &&
        b.vy >= 0 &&
        (wasCarried || (!b.onGround && b.vy > 60 && centerOver));
      if (onTop) {
        b.x += m.dx;
        b.y = m.rect.y - b.h;
        b.vy = 0;
        b.onGround = true;
        m.carrying = true;
      } else {
        m.carrying = false;
      }
    }
  }

  private overlapsPlayer(x: number, y: number, w: number, h: number) {
    const b = this.player.body;
    return b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y;
  }

  private checkHazards() {
    const b = this.player.body;
    const x0 = Math.floor(b.x / TILE);
    const y0 = Math.floor(b.y / TILE);
    const x1 = Math.floor((b.x + b.w) / TILE);
    const y1 = Math.floor((b.y + b.h) / TILE);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ch = this.at(x, y);
        if (!ch || ch === '.') continue;
        const px = x * TILE;
        const py = y * TILE;

        if (ch === '^' && this.overlapsPlayer(px + 2, py + 8, TILE - 4, TILE - 8)) {
          this.killPlayer();
          return;
        }
        if (ch === '~' && this.overlapsPlayer(px, py + 4, TILE, TILE - 4)) {
          this.killPlayer();
          return;
        }
        if (ch === 'B' && this.overlapsPlayer(px, py + 10, TILE, 6) && b.vy >= 0) {
          b.vy = -620;
          b.onGround = false;
        }
        if (ch === '>' && this.overlapsPlayer(px, py + 12, TILE, 4)) {
          b.vx = Math.max(b.vx, PLAYER.maxRunSpeed * 1.6);
        }
        if (ch === '<' && this.overlapsPlayer(px, py + 12, TILE, 4)) {
          b.vx = Math.min(b.vx, -PLAYER.maxRunSpeed * 1.6);
        }
      }
    }
  }

  private checkCoins() {
    for (const c of this.coins) {
      if (c.taken) continue;
      const r = c.sprite.getBounds();
      if (this.overlapsPlayer(r.x, r.y, r.width, r.height)) {
        c.taken = true;
        this.tweens.add({
          targets: c.sprite,
          y: c.sprite.y - 14,
          alpha: 0,
          duration: 220,
          onComplete: () => c.sprite.destroy(),
        });
      }
    }
  }

  private checkCheckpoints() {
    for (const cp of this.checkpoints) {
      if (cp.activated) continue;
      if (this.overlapsPlayer(cp.x - 8, cp.y - 12, 16, 24)) {
        cp.activated = true;
        cp.flag.setFillStyle(0x8ff0a4);
        this.respawnPoint = standPos(cp.tileX, cp.tileY);
      }
    }
  }

  private checkExit() {
    for (const r of this.exitRects) {
      if (this.overlapsPlayer(r.x, r.y, r.width, r.height)) {
        this.win();
        return;
      }
    }
  }
}
