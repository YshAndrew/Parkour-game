/**
 * 共享关卡世界：把「碰撞网格 + 实体 + 玩家 + 机关判定 + 死亡/通关流程」从
 * GameScene（正式游玩）与 PlayScene（编辑器试玩）中抽出来，两处共用同一份逻辑，
 * 保证手感与判定口径完全一致（编辑器所见即所得）。
 *
 * 设计：
 *  - 只持有 Phaser 场景引用用于创建显示对象/补间；玩法状态与判定全部收敛在本类内。
 *  - 场景通过 hooks 回调接收事件（死亡/通关/每帧 tick），自行决定保存、HUD、粒子等表现层。
 *  - state 只含 playing / dead / win；暂停/菜单等 UI 态仍由场景自行管理。
 */

import Phaser from 'phaser';
import { PLAYER, TILE } from '../core/config';
import { Input } from '../core/controls';
import { Platformer } from '../core/platformer';
import type { Rect } from '../core/platformer';
import { standPos } from '../core/map-format';
import type { ParsedLevel } from '../core/map-format';

export interface Coin {
  sprite: Phaser.GameObjects.Rectangle;
  taken: boolean;
}
export interface Checkpoint {
  x: number;
  y: number;
  tileX: number;
  tileY: number;
  flag: Phaser.GameObjects.Rectangle;
  activated: boolean;
}
export interface Mover {
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

export type WorldState = 'playing' | 'dead' | 'win';

export interface WorldHooks {
  /** 玩家死亡时回调（deaths = 累计死亡数） */
  onDied?: (deaths: number) => void;
  /** 通关时回调（毫秒 / 死亡 / 本关金币 / 金币总数） */
  onWin?: (ms: number, deaths: number, coins: number, totalCoins: number) => void;
  /** 每帧推进回调 */
  onTick?: (ms: number, deaths: number, coins: number, totalCoins: number) => void;
}

/** 死亡后自动重生的延迟（秒） */
const DEATH_RESPAWN_S = 0.38;

export class LevelWorld {
  /** 由 buildPlayer() 在构造函数中初始化（useDefineForClassFields 下无法在方法内写 readonly） */
  player!: Platformer;
  playerGfx!: Phaser.GameObjects.Container;
  readonly ctl = new Input();

  coins: Coin[] = [];
  checkpoints: Checkpoint[] = [];
  movers: Mover[] = [];
  private exitRects: Phaser.Geom.Rectangle[] = [];
  private solids: boolean[][] = [];
  private platforms: boolean[][] = [];

  state: WorldState = 'playing';
  elapsed = 0;
  deaths = 0;
  coinsTaken = 0;

  /** 当前帧的 hooks（update 每帧写入；供键盘等场景外部调用 kill 时取用） */
  private hooks: WorldHooks = {};
  private respawnPoint = { x: 0, y: 0 };
  private deadTimer = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly level: ParsedLevel,
  ) {
    this.buildCollisionGrids();
    this.buildEntities();
    this.buildPlayer();
  }

  /** 当前复活点（初始为出生点，踩检查点后更新） */
  get spawn() {
    return { ...this.respawnPoint };
  }

  get totalCoins() {
    return this.level.totalCoins;
  }

  /** 开始/重开一关：清零统计并从出生点复活 */
  start() {
    this.elapsed = 0;
    this.deaths = 0;
    this.coinsTaken = 0;
    this.respawn(this.level.spawn.x, this.level.spawn.y);
  }

  // ---------- 碰撞 ----------

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
    // 只判定静态网格：移动平台是单向平台，不做实体碰撞（否则会被顶/压穿模）
    return this.rectHitsGrid(r, this.solids);
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
    // 移动平台不参与单向落脚判定：落脚完全由 updateMovers 的载人判定负责
    // （单向实体碰撞已移除，平台体会从玩家身上扫过而不产生 push-out）
    return top;
  };

  // ---------- 实体 ----------

  private buildEntities() {
    // 金币
    for (const c of this.level.coins) {
      const rect = this.scene.add.rectangle(c.x, c.y, 8, 8, 0xffd866).setStrokeStyle(1, 0xd4a017);
      this.scene.tweens.add({ targets: rect, angle: 360, repeat: -1, duration: 1200, ease: 'Linear' });
      this.coins.push({ sprite: rect, taken: false });
    }

    // 检查点 / 移动平台
    for (let y = 0; y < this.level.height; y++) {
      for (let x = 0; x < this.level.width; x++) {
        const kind = this.level.grid[y][x];
        const px = x * TILE + TILE / 2;
        const py = y * TILE + TILE / 2;

        if (kind === 'checkpoint') {
          const flag = this.scene.add.rectangle(px, py - 4, 10, 8, 0x95a5a6);
          this.scene.add.rectangle(px, py + 4, 2, 10, 0x7f8c8d);
          this.checkpoints.push({ x: px, y: py, tileX: x, tileY: y, flag, activated: false });
        }

        if (kind === 'moving' || kind === 'moving-v') {
          const w = TILE * 2.5;
          const h = 10;
          const gfx = this.scene.add.rectangle(px, py, w, h, 0x9b59b6).setStrokeStyle(2, 0x8e44ad);
          this.movers.push({
            rect: { x: px - w / 2, y: py - h / 2, w, h },
            gfx,
            axis: kind === 'moving' ? 'x' : 'y',
            origin: kind === 'moving' ? px : py,
            range: TILE * 2,
            speed: 1.6, // 角速度 rad/s
            t: 0,
            dx: 0,
          });
        }
      }
    }

    // 出口传送门（做成偏高的门，避免玩家跳着过去时“擦肩而过”）
    for (const e of this.level.exits) {
      const portal = this.scene.add.rectangle(e.x, e.y - 4, 12, 28, 0x8ff0a4).setStrokeStyle(2, 0x2ecc71);
      this.scene.add.rectangle(e.x, e.y - 4, 4, 20, 0x2ecc71);
      this.scene.tweens.add({
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

  private buildPlayer() {
    this.player = new Platformer(this.level.spawn.x, this.level.spawn.y);
    this.respawnPoint = { ...this.level.spawn };

    const body = this.scene.add.rectangle(0, 0, PLAYER.width, PLAYER.height, 0xffcd75);
    const visor = this.scene.add.rectangle(3, -4, 4, 3, 0x1a1c2c);
    this.playerGfx = this.scene.add.container(0, 0, [body, visor]);
  }

  private respawn(x: number, y: number) {
    this.player.respawn(x, y);
    this.playerGfx.setPosition(this.player.cx, this.player.cy);
  }

  // ---------- 流程 ----------

  /** 请求死亡（触雷/掉出地图/R 键重开等）：立即进入 dead 态，计时后自动复活 */
  kill() {
    if (this.state !== 'playing') return;
    this.state = 'dead';
    this.deaths++;
    this.deadTimer = DEATH_RESPAWN_S;
    this.hooks.onDied?.(this.deaths);
  }

  // ---------- 帧循环 ----------

  update(dt: number, hooks: WorldHooks = {}) {
    this.hooks = hooks;

    if (this.state === 'dead') {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        this.respawn(this.respawnPoint.x, this.respawnPoint.y);
        this.state = 'playing';
      }
      return;
    }
    if (this.state !== 'playing') return;
    this.elapsed += dt;

    // 移动平台先行，并载人
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

    if (this.player.cy > this.level.pixelHeight + 60) this.kill();

    hooks.onTick?.(Math.floor(this.elapsed * 1000), this.deaths, this.coinsTaken, this.level.totalCoins);
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

      // 载人：只有“正在乘坐本平台”或“正下落落在平台上”才算踩上，防止平台从下方/侧向
      // 顶进角色时把站地上的玩家“偷”上平台（头顶穿模的根因）。
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
        const kind = this.level.grid[y]?.[x];
        if (!kind) continue;
        const px = x * TILE;
        const py = y * TILE;

        if (kind === 'spike' && this.overlapsPlayer(px + 2, py + 8, TILE - 4, TILE - 8)) {
          this.kill();
          return;
        }
        if (kind === 'lava' && this.overlapsPlayer(px, py + 4, TILE, TILE - 4)) {
          this.kill();
          return;
        }
        if (kind === 'bounce' && this.overlapsPlayer(px, py + 10, TILE, 6) && b.vy >= 0) {
          b.vy = PLAYER.bounceVy;
          b.onGround = false;
        }
        if (kind === 'boost-right' && this.overlapsPlayer(px, py + 12, TILE, 4)) {
          b.vx = Math.max(b.vx, PLAYER.maxRunSpeed * PLAYER.boostMult);
        }
        if (kind === 'boost-left' && this.overlapsPlayer(px, py + 12, TILE, 4)) {
          b.vx = Math.min(b.vx, -PLAYER.maxRunSpeed * PLAYER.boostMult);
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
        this.scene.tweens.add({
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
        // 站在旗帜所在格的底面上，避免脚底嵌入下方方块
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

  private win() {
    if (this.state !== 'playing') return;
    this.state = 'win';
    const ms = Math.floor(this.elapsed * 1000);
    this.hooks.onWin?.(ms, this.deaths, this.coinsTaken, this.level.totalCoins);
  }
}
