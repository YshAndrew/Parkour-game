/**
 * 编辑器场景：网格瓦片渲染 + 鼠标绘制（放置/擦除/连续画）+ 相机（缩放/平移）+ 撤销。
 */

import Phaser from 'phaser';
import { TILE } from '../core/config.ts';
import { getCell, setCell, snapshotForUndo, undo, width, height, subscribe } from './state.ts';
import { paintGridTile } from './tile-painter.ts';

export class EditorScene extends Phaser.Scene {
  private gfx!: Phaser.GameObjects.Graphics;
  private chars = new Map<string, Phaser.GameObjects.Text>();
  private cursor!: Phaser.GameObjects.Rectangle;
  private cam!: Phaser.Cameras.Scene2D.Camera;
  private dirty = false;
  private tool = '#';
  private strokeActive = false;
  private erasing = false;
  private panning = false;
  private panStart = { x: 0, y: 0 };
  private lastCell = { x: -1, y: -1 };
  private unsub: (() => void) | null = null;

  constructor() {
    super('editor');
  }

  setTool(ch: string) {
    this.tool = ch;
    this.events.emit('editor:tool', ch);
  }

  create() {
    this.cam = this.cameras.main;
    this.cam.setBackgroundColor('#0e121d');
    this.cam.setZoom(2);
    this.updateBounds();

    this.gfx = this.add.graphics();
    this.cursor = this.add
      .rectangle(0, 0, TILE, TILE, 0xffffff, 0.16)
      .setStrokeStyle(1, 0xffffff, 0.9)
      .setDepth(10);

    this.input.mouse?.disableContextMenu();

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on('pointerup', () => this.onUp());
    this.input.on('wheel', (p: Phaser.Input.Pointer, _go: unknown, _dx: number, dy: number) =>
      this.onWheel(p, dy),
    );

    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        undo();
      }
      const step = 32;
      if (e.code === 'ArrowLeft') this.cam.scrollX = Math.max(0, this.cam.scrollX - step);
      if (e.code === 'ArrowRight') this.cam.scrollX += step;
      if (e.code === 'ArrowUp') this.cam.scrollY = Math.max(0, this.cam.scrollY - step);
      if (e.code === 'ArrowDown') this.cam.scrollY += step;
    });

    this.unsub = subscribe(() => {
      this.dirty = true;
      this.updateBounds();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.unsub?.());

    this.dirty = true;
    this.events.emit('editor:ready');
  }

  private updateBounds() {
    this.cam.setBounds(0, 0, Math.max(1, width()) * TILE, Math.max(1, height()) * TILE);
  }

  // ---------- 坐标 ----------

  private tileAt(pointer: Phaser.Input.Pointer): { x: number; y: number } | null {
    const p = this.cam.getWorldPoint(pointer.x, pointer.y);
    const x = Math.floor(p.x / TILE);
    const y = Math.floor(p.y / TILE);
    if (x < 0 || y < 0) return null;
    return { x, y };
  }

  private emitCursor() {
    const p = this.input.activePointer;
    const t = this.tileAt(p);
    this.events.emit('editor:cursor', t ? { x: t.x, y: t.y, ch: getCell(t.x, t.y) } : null);
  }

  // ---------- 输入 ----------

  private onDown(p: Phaser.Input.Pointer) {
    if (p.button === 1) {
      this.panning = true;
      this.panStart = { x: p.x, y: p.y };
      return;
    }
    if (p.button === 0) {
      snapshotForUndo();
      this.strokeActive = true;
      this.paint(this.tool);
    } else if (p.button === 2) {
      snapshotForUndo();
      this.erasing = true;
      this.erase();
    }
  }

  private onMove(p: Phaser.Input.Pointer) {
    this.emitCursor();
    if (this.panning) {
      const dx = p.x - this.panStart.x;
      const dy = p.y - this.panStart.y;
      this.panStart = { x: p.x, y: p.y };
      this.cam.scrollX = Math.max(0, this.cam.scrollX - dx / this.cam.zoom);
      this.cam.scrollY = Math.max(0, this.cam.scrollY - dy / this.cam.zoom);
      return;
    }
    if (this.strokeActive) this.paintLine(this.tool);
    else if (this.erasing) this.paintLine('.');
  }

  private onUp() {
    this.strokeActive = false;
    this.erasing = false;
    this.panning = false;
  }

  private onWheel(p: Phaser.Input.Pointer, dy: number) {
    const before = this.cam.getWorldPoint(p.x, p.y);
    const next = Phaser.Math.Clamp(this.cam.zoom * (dy > 0 ? 1 / 1.12 : 1.12), 0.5, 8);
    this.cam.setZoom(next);
    const after = this.cam.getWorldPoint(p.x, p.y);
    this.cam.scrollX += before.x - after.x;
    this.cam.scrollY += before.y - after.y;
    this.dirty = true;
  }

  // ---------- 绘制 ----------

  private paint(ch: string) {
    const p = this.input.activePointer;
    const t = this.tileAt(p);
    if (!t) return;
    this.lastCell = t;
    setCell(t.x, t.y, ch === '.' ? '.' : ch);
    this.dirty = true;
  }

  private erase() {
    this.paint('.');
  }

  /** 拖拽连画：从上一格到当前格走 Bresenham 直线，避免快速拖动漏格 */
  private paintLine(ch: string) {
    const p = this.input.activePointer;
    const t = this.tileAt(p);
    if (!t) return;
    const a = this.lastCell;
    if (a.x === t.x && a.y === t.y) {
      this.paint(ch);
      return;
    }
    const dx = Math.abs(t.x - a.x);
    const dy = Math.abs(t.y - a.y);
    const sx = a.x < t.x ? 1 : -1;
    const sy = a.y < t.y ? 1 : -1;
    let err = dx - dy;
    let x = a.x;
    let y = a.y;
    for (;;) {
      setCell(x, y, ch === '.' ? '.' : ch);
      if (x === t.x && y === t.y) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
    this.lastCell = t;
    this.dirty = true;
  }

  // ---------- 渲染 ----------

  update() {
    if (!this.dirty) return;
    this.dirty = false;
    this.redraw();

    // 光标格跟随
    const p = this.input.activePointer;
    const t = this.tileAt(p);
    if (t) {
      this.cursor.setPosition(t.x * TILE + TILE / 2, t.y * TILE + TILE / 2);
      this.cursor.setVisible(true);
    } else {
      this.cursor.setVisible(false);
    }
  }

  private redraw() {
    const gfx = this.gfx;
    gfx.clear();

    // 网格线（细暗线）
    gfx.lineStyle(1, 0x1a2133, 0.5);
    for (let x = 0; x <= width(); x++) gfx.lineBetween(x * TILE, 0, x * TILE, height() * TILE);
    for (let y = 0; y <= height(); y++) gfx.lineBetween(0, y * TILE, width() * TILE, y * TILE);

    // 瓦片色块
    const h = height();
    const w = width();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = getCell(x, y);
        if (ch !== '.' && ch !== ' ') paintGridTile(gfx, x, y, ch);
      }
    }

    // 字符叠加（复用 Text 对象池）
    const liveKeys = new Set<string>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = getCell(x, y);
        if (ch === '.' || ch === ' ') continue;
        const key = `${x},${y}`;
        liveKeys.add(key);
        let t = this.chars.get(key);
        if (!t) {
          t = this.add
            .text(x * TILE + TILE / 2, y * TILE + TILE / 2, ch, {
              fontFamily: 'Consolas, monospace',
              fontSize: '9px',
              color: '#ffffff',
            })
            .setOrigin(0.5)
            .setDepth(5);
          t.setStroke('#0b0e17', 2);
          this.chars.set(key, t);
        } else if (t.text !== ch) {
          t.setText(ch);
        }
      }
    }
    for (const [key, t] of this.chars) {
      if (!liveKeys.has(key)) {
        t.destroy();
        this.chars.delete(key);
      }
    }
  }
}
