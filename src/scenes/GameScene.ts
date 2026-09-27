/**
 * 主游戏场景：把纯逻辑关卡数据渲染成 Phaser 世界。
 * 玩法物理全部由 Platformer（自研 AABB）驱动，不依赖 Arcade Physics。
 */

import Phaser from 'phaser';
import { CAMERA, COLORS, PLAYER, TILE } from '../core/config';
import { Input, actionFor } from '../core/controls';
import type { Rect } from '../core/platformer';
import { Platformer } from '../core/platformer';
import { Save } from '../core/save-data';
import type { RegisteredLevel } from '../levels/registry';
import { LevelRegistry } from '../levels/registry';

interface Coin {
  sprite: Phaser.GameObjects.Rectangle;
  taken: boolean;
}
interface Checkpoint {
  x: number;
  y: number;
  flag: Phaser.GameObjects.Rectangle;
  activated: boolean;
}
interface Mover {
  rect: Rect;
  gfx: Phaser.GameObjects.Rectangle;
  axis: 'x' | 'y';
  origin: number;
  range: number;
  speed: number;
  t: number;
  dx: number;
  dy: number;
}

export class GameScene extends Phaser.Scene {
  private level!: RegisteredLevel;
  private player!: Platformer;
  private playerGfx!: Phaser.GameObjects.Container;

  private ctl = new Input();
  private coins: Coin[] = [];
  private checkpoints: Checkpoint[] = [];
  private movers: Mover[] = [];
  private exitRects: Phaser.Geom.Rectangle[] = [];

  private elapsed = 0;
  private deaths = 0;
  private coinsTaken = 0;
  private state: 'menu' | 'playing' | 'paused' | 'dead' | 'win' = 'menu';
  private respawnPoint = { x: 0, y: 0 };

  private solids: boolean[][] = [];
  private platforms: boolean[][] = [];

  private cam!: Phaser.Cameras.Scene2D.Camera;

  constructor() {
    super('game');
  }

  init(data: { levelIndex?: number }) {
    const idx = data.levelIndex ?? 0;
    const lv = LevelRegistry.get(idx);
    if (!lv) throw new Error(`关卡 ${idx} 不存在`);
    this.level = lv;
    this.coins = [];
    this.checkpoints = [];
    this.movers = [];
    this.exitRects = [];
    this.ctl = new Input();
    this.elapsed = 0;
    this.deaths = 0;
    this.coinsTaken = 0;
    this.state = 'menu';
  }

  create() {
    this.buildCollisionGrids();
    this.buildTiles();
    this.buildEntities();
    this.buildPlayer();
    this.buildCamera();
    this.bindInput();

    // 粒子用小白块纹理
    if (!this.textures.exists('px')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff).fillRect(0, 0, 4, 4);
      g.generateTexture('px', 4, 4);
      g.destroy();
    }

    this.events.emit('ready');
    this.game.events.emit('scene-ready');
  }

  // ---------- 碰撞查询（注入 Platformer 的 world） ----------

  private buildCollisionGrids() {
    const { width, height, grid } = this.level;
    this.solids = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => grid[y][x] === 'solid'),
    );
    this.platforms = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => grid[y][x] === 'platform'),
    );
  }

  private rectHitsGrid(r: Rect, grid: boolean[][]) {
    const x0 = Math.floor(r.x / TILE);
    const y0 = Math.floor(r.y / TILE);
    const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
    const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (grid[y]?.[x]) return true;
      }
    }
    return false;
  }

  private isSolid = (r: Rect) => {
    if (this.rectHitsGrid(r, this.solids)) return true;
    for (const m of this.movers) {
      if (r.x < m.rect.x + m.rect.w && r.x + r.w > m.rect.x && r.y < m.rect.y + m.rect.h && r.y + r.h > m.rect.y) {
        return true;
      }
    }
    return false;
  };

  private oneWayTop = (r: Rect): number | null => {
    const x0 = Math.floor(r.x / TILE);
    const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
    const y0 = Math.floor(r.y / TILE);
    const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
    let top: number | null = null;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (this.platforms[y]?.[x]) {
          const t = y * TILE;
          if (top === null || t < top) top = t;
        }
      }
    }
    return top;
  };

  // ---------- 视觉 ----------

  private buildTiles() {
    const { width, height, grid } = this.level;
    const gfx = this.add.graphics();

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const kind = grid[y][x];
        const px = x * TILE;
        const py = y * TILE;
        switch (kind) {
          case 'solid': {
            const above = grid[y - 1]?.[x];
            gfx.fillStyle(0x3e3f4a).fillRect(px, py, TILE, TILE);
            gfx.fillStyle(above === 'solid' ? 0x3e3f4a : 0x5c8a4d).fillRect(px, py, TILE, 3);
            gfx.fillStyle(0x2a2b33).fillRect(px, py + TILE - 2, TILE, 2);
            break;
          }
          case 'platform':
            gfx.fillStyle(0x6d6875).fillRect(px, py + 2, TILE, 4);
            gfx.fillStyle(0x9b8f9e).fillRect(px, py + 2, TILE, 1);
            break;
          case 'bridge':
            gfx.fillStyle(0x7a5c3e).fillRect(px, py + 6, TILE, 3);
            break;
          case 'spike':
            gfx.fillStyle(0xc0392b);
            for (let i = 0; i < 4; i++) {
              const sx = px + i * 4;
              gfx.fillTriangle(sx, py + TILE, sx + 2, py + 5, sx + 4, py + TILE);
            }
            break;
          case 'lava':
            gfx.fillStyle(0xe74c3c).fillRect(px, py + 4, TILE, TILE - 4);
            gfx.fillStyle(0xf39c12).fillRect(px + 2, py + 6, 3, 2).fillRect(px + 10, py + 9, 3, 2);
            break;
          case 'bounce':
            gfx.fillStyle(0x8ff0a4).fillRect(px, py + 10, TILE, 6);
            gfx.fillStyle(0x2ecc71).fillRect(px + 2, py + 12, TILE - 4, 2);
            break;
          case 'boost-right':
          case 'boost-left':
            gfx.fillStyle(0x3498db).fillRect(px, py + 12, TILE, 4);
            gfx.fillStyle(0x85c1e9).fillRect(px + 4, py + 13, 8, 2);
            break;
          default:
            break;
        }
      }
    }

    // 出口传送门
    for (const e of this.level.exits) {
      const portal = this.add.rectangle(e.x, e.y, 12, 20, 0x8ff0a4).setStrokeStyle(2, 0x2ecc71);
      this.tweens.add({
        targets: portal,
        scaleY: 1.15,
        alpha: 0.75,
        yoyo: true,
        repeat: -1,
        duration: 700,
        ease: 'Sine.easeInOut',
      });
      this.exitRects.push(new Phaser.Geom.Rectangle(e.x - 6, e.y - 10, 12, 20));
    }
  }

  private buildEntities() {
    for (const c of this.level.coins) {
      const rect = this.add.rectangle(c.x, c.y, 8, 8, 0xffd866).setStrokeStyle(1, 0xd4a017);
      this.tweens.add({ targets: rect, angle: 360, repeat: -1, duration: 1200, ease: 'Linear' });
      this.coins.push({ sprite: rect, taken: false });
    }

    for (let y = 0; y < this.level.height; y++) {
      for (let x = 0; x < this.level.width; x++) {
        const kind = this.level.grid[y][x];
        const px = x * TILE + TILE / 2;
        const py = y * TILE + TILE / 2;

        if (kind === 'checkpoint') {
          const flag = this.add.rectangle(px, py - 4, 10, 8, 0x95a5a6);
          this.add.rectangle(px, py + 4, 2, 10, 0x7f8c8d);
          this.checkpoints.push({ x: px, y: py, flag, activated: false });
        }

        if (kind === 'moving' || kind === 'moving-v') {
          const w = TILE * 2.5;
          const h = 10;
          const gfx = this.add.rectangle(px, py, w, h, 0x9b59b6).setStrokeStyle(2, 0x8e44ad);
          this.movers.push({
            rect: { x: px - w / 2, y: py - h / 2, w, h },
            gfx,
            axis: kind === 'moving' ? 'x' : 'y',
            origin: kind === 'moving' ? px : py,
            range: TILE * 2,
            speed: 1.6, // 角速度 rad/s
            t: 0,
            dx: 0,
            dy: 0,
          });
        }
      }
    }
  }

  private buildPlayer() {
    this.player = new Platformer(this.level.spawn.x, this.level.spawn.y);
    this.respawnPoint = { ...this.level.spawn };

    const body = this.add.rectangle(0, 0, PLAYER.width, PLAYER.height, 0xffcd75);
    const visor = this.add.rectangle(3, -4, 4, 3, 0x1a1c2c);
    this.playerGfx = this.add.container(0, 0, [body, visor]);
  }

  private buildCamera() {
    this.cam = this.cameras.main;
    this.cam.setBounds(0, 0, this.level.pixelWidth, this.level.pixelHeight);
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
      if (this.state !== 'playing' && this.state !== 'paused') return;
      const action = actionFor(e.code);
      if (action === 'pause') this.togglePause();
      if (action === 'restart' && this.state === 'playing') this.killPlayer();
    });
    this.input.keyboard!.on('keyup', (e: KeyboardEvent) => this.ctl.handleUp(e));
  }

  // ---------- 流程 ----------

  startLevel() {
    this.state = 'playing';
    this.elapsed = 0;
    this.deaths = 0;
    this.coinsTaken = 0;
    this.respawn(this.level.spawn.x, this.level.spawn.y);
  }

  private togglePause() {
    this.state = this.state === 'paused' ? 'playing' : 'paused';
    this.events.emit(this.state === 'paused' ? 'paused' : 'resumed');
  }

  /** 供 UI 暂停菜单“继续”按钮调用 */
  resumeGame() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.events.emit('resumed');
    }
  }

  private killPlayer() {
    if (this.state !== 'playing') return;
    this.state = 'dead';
    this.deaths++;
    this.events.emit('died', this.deaths);

    const p = this.add.particles(this.player.cx, this.player.cy, 'px', {
      speed: { min: 60, max: 180 },
      lifespan: 450,
      quantity: 14,
      scale: { start: 1.5, end: 0 },
      emitting: false,
    });
    p.setParticleTint(0xef7d8a);
    p.explode(14);
    this.cam.shake(120, 0.004);

    this.time.delayedCall(380, () => {
      p.destroy();
      this.respawn(this.respawnPoint.x, this.respawnPoint.y);
      this.state = 'playing';
    });
  }

  private respawn(x: number, y: number) {
    this.player.respawn(x, y);
    this.playerGfx.setPosition(this.player.cx, this.player.cy);
  }

  private win() {
    if (this.state !== 'playing') return;
    this.state = 'win';
    const ms = Math.floor(this.elapsed * 1000);
    Save.recordLevel(this.level.id, ms, this.deaths, this.coinsTaken, this.level.totalCoins);
    Save.unlock(this.level.index + 1);
    this.events.emit('win', {
      levelId: this.level.id,
      levelIndex: this.level.index,
      ms,
      deaths: this.deaths,
      coins: this.coinsTaken,
      totalCoins: this.level.totalCoins,
    });
  }

  // ---------- 帧循环 ----------

  update(_time: number, delta: number) {
    if (this.state !== 'playing') return;
    const dt = Math.min(delta / 1000, 1 / 30);
    this.elapsed += dt;

    // 移动平台先行，并载人
    this.updateMovers(dt);

    const inp = {
      left: this.ctl.down('left'),
      right: this.ctl.down('right'),
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

    if (this.player.cy > this.level.pixelHeight + 60) this.killPlayer();

    this.events.emit('tick', {
      ms: Math.floor(this.elapsed * 1000),
      deaths: this.deaths,
      coins: this.coinsTaken,
      totalCoins: this.level.totalCoins,
    });
  }

  private updateMovers(dt: number) {
    for (const m of this.movers) {
      m.t += dt;
      const off = Math.sin(m.t * m.speed) * m.range;
      const nx = m.axis === 'x' ? m.origin + off : m.rect.x + m.rect.w / 2;
      const ny = m.axis === 'y' ? m.origin + off : m.rect.y + m.rect.h / 2;
      m.dx = nx - (m.rect.x + m.rect.w / 2);
      m.dy = ny - (m.rect.y + m.rect.h / 2);
      m.rect.x = nx - m.rect.w / 2;
      m.rect.y = ny - m.rect.h / 2;
      m.gfx.setPosition(nx, ny);

      // 载人：玩家脚底贴着平台顶面
      const b = this.player.body;
      const feet = b.y + b.h;
      const onTop =
        feet >= m.rect.y - 3 &&
        feet <= m.rect.y + 5 &&
        b.x + b.w > m.rect.x &&
        b.x < m.rect.x + m.rect.w &&
        b.vy >= 0;
      if (onTop) {
        b.x += m.dx;
        b.y = m.rect.y - b.h;
        b.vy = 0;
        b.onGround = true;
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
        const kind = this.level.grid[y]?.[x];
        if (!kind) continue;
        const px = x * TILE;
        const py = y * TILE;

        if (kind === 'spike' && this.overlapsPlayer(px + 2, py + 8, TILE - 4, TILE - 8)) {
          this.killPlayer();
          return;
        }
        if (kind === 'lava' && this.overlapsPlayer(px, py + 4, TILE, TILE - 4)) {
          this.killPlayer();
          return;
        }
        if (kind === 'bounce' && this.overlapsPlayer(px, py + 10, TILE, 6) && b.vy >= 0) {
          b.vy = -620;
          b.onGround = false;
        }
        if (kind === 'boost-right' && this.overlapsPlayer(px, py + 12, TILE, 4)) {
          b.vx = Math.max(b.vx, PLAYER.maxRunSpeed * 1.6);
        }
        if (kind === 'boost-left' && this.overlapsPlayer(px, py + 12, TILE, 4)) {
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
        this.coinsTaken++;
      }
    }
  }

  private checkCheckpoints() {
    for (const cp of this.checkpoints) {
      if (cp.activated) continue;
      if (this.overlapsPlayer(cp.x - 8, cp.y - 12, 16, 24)) {
        cp.activated = true;
        cp.flag.setFillStyle(0x8ff0a4);
        this.respawnPoint = { x: cp.x, y: cp.y - 8 };
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
