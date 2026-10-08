/**
 * 瓦片渲染：编辑器网格视图与试玩视图共用。
 *  - tileColor：编辑模式每个字符的色块颜色（编辑器场景按颜色批量绘制）
 *  - paintPlayTile：试玩模式，与 GameScene 视觉一致
 */

import Phaser from 'phaser';
import { TILE } from '../core/config.ts';

/** 编辑模式每个字符的色块颜色 */
export function tileColor(ch: string): number {
  switch (ch) {
    case '#':
      return 0x3e3f4a;
    case '=':
      return 0x6d6875;
    case '-':
      return 0x7a5c3e;
    case '^':
      return 0xc0392b;
    case '~':
      return 0xe74c3c;
    case 'o':
      return 0xffd866;
    case 'S':
      return 0x8ff0a4;
    case 'E':
      return 0x2ecc71;
    case 'C':
      return 0x95a5a6;
    case 'B':
      return 0x27ae60;
    case '>':
    case '<':
      return 0x3498db;
    case 'M':
    case 'm':
      return 0x9b59b6;
    default:
      return 0;
  }
}

/** 试玩模式：与 GameScene.buildTiles 一致的画法（rows 用于查上方是否实心） */
export function paintPlayTile(
  gfx: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  ch: string,
  rows: string[],
) {
  const px = x * TILE;
  const py = y * TILE;
  const above = y - 1 >= 0 ? (rows[y - 1][x] ?? '.') : '.';
  switch (ch) {
    case '#': {
      gfx.fillStyle(0x3e3f4a).fillRect(px, py, TILE, TILE);
      gfx.fillStyle(above === '#' ? 0x3e3f4a : 0x5c8a4d).fillRect(px, py, TILE, 3);
      gfx.fillStyle(0x2a2b33).fillRect(px, py + TILE - 2, TILE, 2);
      break;
    }
    case '=':
      gfx.fillStyle(0x6d6875).fillRect(px, py + 2, TILE, 4);
      gfx.fillStyle(0x9b8f9e).fillRect(px, py + 2, TILE, 1);
      break;
    case '-':
      gfx.fillStyle(0x7a5c3e).fillRect(px, py + 6, TILE, 3);
      break;
    case '^':
      gfx.fillStyle(0xc0392b);
      for (let i = 0; i < 4; i++) {
        const sx = px + i * 4;
        gfx.fillTriangle(sx, py + TILE, sx + 2, py + 5, sx + 4, py + TILE);
      }
      break;
    case '~':
      gfx.fillStyle(0xe74c3c).fillRect(px, py + 4, TILE, TILE - 4);
      gfx.fillStyle(0xf39c12).fillRect(px + 2, py + 6, 3, 2).fillRect(px + 10, py + 9, 3, 2);
      break;
    case 'B':
      gfx.fillStyle(0x8ff0a4).fillRect(px, py + 10, TILE, 6);
      gfx.fillStyle(0x2ecc71).fillRect(px + 2, py + 12, TILE - 4, 2);
      break;
    case '>':
    case '<':
      gfx.fillStyle(0x3498db).fillRect(px, py + 12, TILE, 4);
      gfx.fillStyle(0x85c1e9).fillRect(px + 4, py + 13, 8, 2);
      break;
    default:
      break;
  }
}

/** 将解析后的 TileKind 网格还原成字符行（用于“载入现有关卡”） */
import type { TileKind } from '../core/map-format.ts';

const KIND_TO_CHAR: Record<TileKind, string> = {
  solid: '#',
  platform: '=',
  bridge: '-',
  spike: '^',
  lava: '~',
  coin: 'o',
  spawn: 'S',
  exit: 'E',
  checkpoint: 'C',
  'boost-right': '>',
  'boost-left': '<',
  bounce: 'B',
  moving: 'M',
  'moving-v': 'm',
  empty: '.',
};

export function kindsToRows(grid: TileKind[][]): string[] {
  return grid.map((row) => row.map((k) => KIND_TO_CHAR[k] ?? '.').join(''));
}
