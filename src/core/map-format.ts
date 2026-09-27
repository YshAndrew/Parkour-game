/**
 * 地图数据格式与解析器。
 *
 * 新地图 = 往 src/levels/maps/ 里丢一个 .ts 文件即可（见该目录下任意示例）。
 */

import { TILE } from './config';

/** 单个瓦片的符号表 */
export const LEGEND = {
  '#': 'solid', // 实心地面/墙
  '=': 'platform', // 单向平台（从下方可跳过）
  '-': 'bridge', // 装饰横木（无碰撞）
  '^': 'spike', // 尖刺（伤害）
  '~': 'lava', // 岩浆（立即死亡）
  o: 'coin', // 金币
  S: 'spawn', // 出生点
  E: 'exit', // 终点传送门
  C: 'checkpoint', // 检查点旗帜
  '>': 'boost-right', // 加速带
  '<': 'boost-left',
  B: 'bounce', // 弹跳板
  M: 'moving', // 移动平台（水平）
  m: 'moving-v', // 移动平台（垂直）
  '.': 'empty',
  ' ': 'empty',
} as const;

export type TileKind = (typeof LEGEND)[keyof typeof LEGEND];

export interface LevelMeta {
  id: string;
  name: string;
  author?: string;
  hint?: string; // 选关界面小提示
  theme?: 'forest' | 'cave' | 'sky'; // 备用主题字段
}

export interface LevelData {
  meta: LevelMeta;
  /** 每行字符串长度可不一致，解析时自动按最长行补齐 '.' */
  grid: string[];
}

export interface ParsedLevel extends LevelMeta {
  grid: TileKind[][];
  width: number; // 瓦片数
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  spawn: { x: number; y: number };
  exits: { x: number; y: number }[];
  coins: { x: number; y: number }[];
  totalCoins: number;
}

export function parseLevel(data: LevelData): ParsedLevel {
  const width = Math.max(...data.grid.map((r) => r.length));
  const height = data.grid.length;
  const grid: TileKind[][] = [];
  let spawn = { x: TILE * 1.5, y: TILE * 1.5 };
  const exits: { x: number; y: number }[] = [];
  const coins: { x: number; y: number }[] = [];

  for (let y = 0; y < height; y++) {
    const row: TileKind[] = [];
    for (let x = 0; x < width; x++) {
      const ch = data.grid[y][x] ?? '.';
      const kind = (LEGEND as Record<string, TileKind>)[ch] ?? 'empty';
      row.push(kind);
      if (kind === 'spawn') spawn = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
      if (kind === 'exit') exits.push({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 });
      if (kind === 'coin') coins.push({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 });
    }
    grid.push(row);
  }

  return {
    ...data.meta,
    grid,
    width,
    height,
    pixelWidth: width * TILE,
    pixelHeight: height * TILE,
    spawn,
    exits,
    coins,
    totalCoins: coins.length,
  };
}
