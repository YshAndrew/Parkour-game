/**
 * 主游戏场景：把纯逻辑关卡数据渲染成 Phaser 世界。
 * 玩法物理全部由 Platformer（自研 AABB）驱动，不依赖 Arcade Physics。
 * 实体/判定/流程复用 LevelWorld，本场景只负责瓦片视觉、相机、输入与 UI 事件。
 */

import Phaser from 'phaser';
import { CAMERA, COLORS, TILE } from '../core/config';
import { actionFor } from '../core/controls';
import type { LevelData } from '../core/map-format';
import { parseLevel } from '../core/map-format';
import { Save } from '../core/save-data';
import type { RegisteredLevel } from '../levels/registry';
import { LevelRegistry } from '../levels/registry';
import { LevelWorld } from './LevelWorld';

export class GameScene extends Phaser.Scene {
  private level!: RegisteredLevel;
  /** 无限模式：由外部动态传入 LevelData（不写存档、不解锁） */
  private isInfinity = false;
  private world!: LevelWorld;

  private state: 'menu' | 'playing' | 'paused' | 'win' = 'menu';

  private cam!: Phaser.Cameras.Scene2D.Camera;

  constructor() {
    super('game');
  }

  init(data: { levelIndex?: number; level?: LevelData }) {
    if (data.level) {
      // 无限模式：动态关卡（生成器产出），index 用 -1 占位
      this.isInfinity = true;
      this.level = { ...parseLevel(data.level), index: -1, sourcePath: 'infinity' };
    } else {
      this.isInfinity = false;
      const idx = data.levelIndex ?? 0;
      const lv = LevelRegistry.get(idx);
      if (!lv) throw new Error(`关卡 ${idx} 不存在`);
      this.level = lv;
    }
    this.state = 'menu';
  }

  create() {
    this.buildTiles();
    this.world = new LevelWorld(this, this.level);
    this.buildCamera();
    this.bindInput();

    // 粒子用小白块纹理
    if (!this.textures.exists('px')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff).fillRect(0, 0, 4, 4);
      g.generateTexture('px', 4, 4);
      g.destroy();
    }

    // 注意：事件名必须避开 Phaser 内置场景事件（如 'ready'/'pause'/'resume'），
    // 否则会在 init() 之前就被触发，导致关卡状态被重置。统一加 game: 前缀。
    this.events.emit('game:ready');
    this.game.events.emit('game:scene-ready');
  }

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
    // 出口传送门由 LevelWorld 统一创建（与试玩场景共用同一份视觉）
  }

  private buildCamera() {
    this.cam = this.cameras.main;
    this.cam.setBounds(0, 0, this.level.pixelWidth, this.level.pixelHeight);
    this.cam.setBackgroundColor(COLORS.skyTop);
    this.cam.setZoom(2);
    this.cam.startFollow(this.world.playerGfx, false, CAMERA.lerp, CAMERA.lerp);
    this.cam.setDeadzone(CAMERA.deadzoneX * 4, CAMERA.deadzoneY * 4);
    this.cam.setFollowOffset(-CAMERA.ahead, 0);
  }

  // ---------- 输入 ----------

  private bindInput() {
    this.input.keyboard!.on('keydown', (e: KeyboardEvent) => {
      const action = actionFor(e.code);
      if (action) e.preventDefault();
      this.world.ctl.handleDown(e);
      if (this.state !== 'playing' && this.state !== 'paused') return;
      if (action === 'pause') this.togglePause();
      if (action === 'restart' && this.world.state === 'playing') this.world.kill();
    });
    this.input.keyboard!.on('keyup', (e: KeyboardEvent) => this.world.ctl.handleUp(e));
  }

  // ---------- 流程 ----------

  startLevel() {
    this.state = 'playing';
    this.world.start();
  }

  private togglePause() {
    this.state = this.state === 'paused' ? 'playing' : 'paused';
    this.events.emit(this.state === 'paused' ? 'game:paused' : 'game:resumed');
  }

  /** 供 UI 暂停菜单“继续”按钮调用 */
  resumeGame() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.events.emit('game:resumed');
    }
  }

  private onWorldDied(deaths: number) {
    this.events.emit('game:died', deaths);

    const p = this.add.particles(this.world.player.cx, this.world.player.cy, 'px', {
      speed: { min: 60, max: 180 },
      lifespan: 450,
      quantity: 14,
      scale: { start: 1.5, end: 0 },
      emitting: false,
    });
    p.setParticleTint(0xef7d8a);
    p.explode(14);
    this.cam.shake(120, 0.004);
    // 粒子 400ms 后清理（LevelWorld 在 0.38s 后自动复活，顺序一致）
    this.time.delayedCall(400, () => p.destroy());
  }

  private onWorldWin(ms: number, deaths: number, coins: number, totalCoins: number) {
    if (this.state !== 'playing') return;
    this.state = 'win';
    if (!this.isInfinity) {
      Save.recordLevel(this.level.id, ms, deaths, coins, totalCoins);
      Save.unlock(this.level.index + 1);
    }
    this.events.emit('game:win', {
      levelId: this.level.id,
      levelIndex: this.level.index,
      ms,
      deaths,
      coins,
      totalCoins,
      isInfinity: this.isInfinity,
    });
  }

  // ---------- 帧循环 ----------

  update(_time: number, delta: number) {
    if (this.state !== 'playing') return;
    const dt = Math.min(delta / 1000, 1 / 30);
    this.world.update(dt, {
      onDied: (deaths) => this.onWorldDied(deaths),
      onWin: (ms, deaths, coins, totalCoins) => this.onWorldWin(ms, deaths, coins, totalCoins),
      onTick: (ms, deaths, coins, totalCoins) => {
        this.events.emit('game:tick', { ms, deaths, coins, totalCoins });
      },
    });
  }
}
