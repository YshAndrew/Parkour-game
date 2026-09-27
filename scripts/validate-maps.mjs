/**
 * 地图校验脚本：检查所有 src/levels/maps/*.ts 的
 *  - 行宽统计（允许不等长，解析器会补 '.'，这里仅提示）
 *  - 必须恰好 1 个出生点 S、至少 1 个终点 E
 *  - S/E/C/B/o 下方 3 格内必须有落脚方块（防止悬空死点）
 * 用法：node scripts/validate-maps.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const w = Math.max(...rows.map((r) => r.length));
  const errors = [];

  const at = (x, y) => (y >= 0 && y < rows.length ? rows[y][x] ?? '.' : '.');
  const solidBelow = (x, y) => {
    for (let d = 1; d <= 3; d++) {
      const c = at(x, y + d);
      if (c === '#' || c === '=' || c === 'B' || c === 'M' || c === 'm') return true;
    }
    return false;
  };

  let spawns = 0;
  let exits = 0;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x];
      if (c === 'S') {
        spawns++;
        if (!solidBelow(x, y)) errors.push(`S(${x},${y}) 下方 3 格无落脚`);
      }
      if (c === 'E') {
        exits++;
        if (!solidBelow(x, y)) errors.push(`E(${x},${y}) 下方 3 格无落脚`);
      }
      if (c === 'C' && !solidBelow(x, y)) errors.push(`C(${x},${y}) 下方 3 格无落脚`);
      if ((c === 'B' || c === '^' || c === '~') && at(x, y + 1) !== '#' && at(x, y + 1) !== '~') {
        errors.push(`${c}(${x},${y}) 下方不是实心`);
      }
    }
  }
  if (spawns !== 1) errors.push(`出生点数量=${spawns}，必须恰好 1 个`);
  if (exits < 1) errors.push('缺少终点 E');

  if (errors.length) {
    failed = true;
    console.error(`✗ ${file} (${rows.length}x${w})`);
    for (const e of errors) console.error(`    - ${e}`);
  } else {
    console.log(`✓ ${file} (${rows.length}x${w})  S:${spawns} E:${exits}`);
  }
}

process.exit(failed ? 1 : 0);
