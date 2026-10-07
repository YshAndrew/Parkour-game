#!/usr/bin/env node
/**
 * 自动生成器压力回归：多难度批量生成，断言
 *   1) 生成必定成功（结构 + 理论可达）
 *   2) 平台带存在高度变化（不再是一条直线）
 *
 * 用法：node scripts/stress-gen.mjs
 */
import { generateMap } from '../src/core/generator.ts';

const DIFFS = [0.1, 0.3, 0.5, 0.7, 1.0];
const PER_DIFF = 20;
const LAVA_ROW = 15; // 平台带只统计岩浆之上的 '#' 行

let failed = 0;

for (const d of DIFFS) {
  let ok = 0;
  let vary = 0;
  let zeroHeight = 0;
  for (let i = 0; i < PER_DIFF; i++) {
    const seed = 1000 + i * 7919;
    const res = generateMap({ difficulty: d, width: 80, seed, simulate: false });
    if (!res) {
      failed++;
      console.log(`✗ 难度 ${d} 种子 ${seed}: 生成失败（6 次结构/理论未过）`);
      continue;
    }
    ok++;
    // 统计岩浆之上的平台带行数（基岩在 16/17 行，不计入）
    const bandRows = new Set();
    res.rows.forEach((row, y) => {
      if (y <= LAVA_ROW && row.includes('#')) bandRows.add(y);
    });
    if (bandRows.size > 1) vary++;
    if (bandRows.size === 0) zeroHeight++;
  }
  const status = ok === PER_DIFF ? '✓' : '✗';
  console.log(`${status} 难度 ${d.toFixed(2)}: ${ok}/${PER_DIFF} 生成通过，${vary}/${PER_DIFF} 存在高度变化${zeroHeight ? `，${zeroHeight} 张无平台带(!)` : ''}`);
  if (ok !== PER_DIFF || vary === 0 || zeroHeight > 0) failed++;
}

if (failed === 0) {
  console.log('\n✓ 全部通过：生成稳定，且各难度均有高度起伏（非直线）');
} else {
  console.log(`\n✗ ${failed} 项失败`);
}
process.exit(failed ? 1 : 0);
