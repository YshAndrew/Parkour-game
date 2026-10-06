/**
 * 关卡可通关性校验脚本（薄壳）：核心仿真见 src/core/simulate.ts。
 * 在 Node 里用与游戏完全一致的物理（真实 Platformer 类）+ 前瞻 bot 跑每张图，
 * 确认能零死亡触达终点。编辑器内嵌的同款检查与此脚本输出一致。
 *
 * 用法：node scripts/simulate.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateGrid } from '../src/core/simulate.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/levels/maps');
let failed = false;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
  const src = readFileSync(join(dir, file), 'utf8');
  const gridMatch = src.match(/grid:\s*\[([\s\S]*?)\]/);
  if (!gridMatch) {
    console.error(`✗ ${file}: 找不到 grid`);
    failed = true;
    continue;
  }
  const rows = [...gridMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const r = simulateGrid(rows);

  if (r.spawnEmbedded) {
    console.log(`✗ ${file}  出生点嵌在方块里`);
    failed = true;
    continue;
  }
  const ok = r.reached && r.deaths === 0;
  console.log(
    `${ok ? '✓' : '✗'} ${file}  到达终点=${r.reached}  死亡=${r.deaths}  推进到 x=${Math.round(r.maxX)}`,
  );
  if (!ok) {
    failed = true;
    console.log(`    bot 轨迹(x): ${r.trace.slice(0, 40).join(' ')}`);
  }
}

process.exit(failed ? 1 : 0);
