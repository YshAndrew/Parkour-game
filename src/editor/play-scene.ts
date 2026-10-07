/**
 * 试玩场景：把当前网格渲染成游戏世界，用真实 Platformer 物理 + 游戏按键操作。
 * 实体/判定/流程复用 LevelWorld（与 GameScene 同一份逻辑），本场景只负责
 * 瓦片视觉、相机、输入与"返回编辑器"流程。不含存档/HUD/UI。
 * 通关或按 Esc 返回编辑器。
 */

import Phaser from 'phaser';
import { CAMERA, COLORS, TILE } from '../core/config.ts';
import { actionFor } from '../core/controls.ts';
import type { LevelData } from '../core/map-format.ts';
import { parseLevel } from '../core/map-format.ts';
import { LevelWorld } from '../scenes/LevelWorld.ts';
import { paintPlayTile } from './tile-painter.ts';

export class PlayScene extends Phaser.Scene {
  private rows: string[] = [];
  private w = 0;
  private h = 0;

  private world!: LevelWorld;
  private cam!: Phaser.Cameras.Scene2D.Camera;

  constructor() {
    super('play');
  }

  init(data: { rows: string[] }) {
    this.rows = data.rows.map((r) => r);
    this.w = Math.max(0, ...this.rows.map((r) => r.length));
    this.h = this.rows.length;
  }

  create() {
    // 先画瓦片底图，再建实体（与 GameScene 渲染层级一致：实体/玩家在瓦片之上）
    this.buildTiles();
    // 与 GameScene 同一份解析逻辑；rows 来自编辑器，meta 无实际意义
    const level: LevelData = { meta: { id: 'editor-play', name: '' }, grid: this.rows };
    this.world = new LevelWorld(this, parseLevel(level));
    this.buildCamera();
    this.bindInput();

    this.events.emit('play:ready', {
      width: this.w,
      height: this.h,
      spawn: this.world.spawn,
    });
  }

  // ---------- 视觉 ----------

  private buildTiles() {
    const gfx = this.add.graphics();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        paintPlayTile(gfx, x, y, this.rows[y][x] ?? '.', this.rows);
      }
    }
    // 出口传送门由 LevelWorld 统一创建（与游戏场景共用同一份视觉）
  }

  private buildCamera() {
    this.cam = this.cameras.main;
    this.cam.setBounds(0, 0, this.w * TILE, this.h * TILE);
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
      if (action === 'pause' && this.world.state === 'playing') this.exitToEditor();
      if (action === 'restart' && this.world.state === 'playing') this.world.kill();
    });
    this.input.keyboard!.on('keyup', (e: KeyboardEvent) => this.world.ctl.handleUp(e));
  }

  private exitToEditor() {
    if (this.world.state === 'win') return;
    this.events.emit('play:exit');
  }

  // ---------- 帧循环 ----------

  update(_time: number, delta: number) {
    const dt = Math.min(delta / 1000, 1 / 30);
    this.world.update(dt, {
      onDied: (deaths) => this.events.emit('play:died', deaths),
      onWin: (ms, deaths) => {
        this.events.emit('play:win', { deaths, ms });
      },
      onTick: (ms, deaths) => {
        this.events.emit('play:tick', { ms, deaths });
      },
    });
  }
}
