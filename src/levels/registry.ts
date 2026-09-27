/**
 * 地图自动注册中心。
 *
 * ✨ 添加新地图的方法（两步）：
 * 1. 在 src/levels/maps/ 下新建一个 `.ts` 文件，参照 `01-tutorial.ts` 的格式。
 * 2. 保存即可。Vite 的 import.meta.glob 会自动注册，无需改任何其他文件。
 *
 * 排序规则：按文件名字典序，建议文件名前缀编号（01-xxx.ts、02-xxx.ts）。
 */

import type { LevelData } from '../core/map-format';
import { parseLevel } from '../core/map-format';

// eager: true 让 Vite 在启动时同步收集所有地图模块
const modules = import.meta.glob<{ default: LevelData }>('./maps/*.ts', { eager: true });

const levels = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, mod], index) => {
    const parsed = parseLevel(mod.default);
    return { ...parsed, index, sourcePath: path };
  });

export type RegisteredLevel = (typeof levels)[number];

export const LevelRegistry = {
  all: levels,

  get(index: number) {
    return levels[index];
  },

  find(id: string) {
    return levels.find((l) => l.id === id);
  },

  count() {
    return levels.length;
  },
};
