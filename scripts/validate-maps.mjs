/**
 * 地图校验脚本（薄壳）：核心规则见 src/core/validate.ts，与编辑器共用同一份。
 * 用法：node scripts/validate-maps.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGrid } from '../src/core/validate.ts';

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
  const r = validateGrid(rows);

  if (!r.ok) {
    failed = true;
    console.error(`✗ ${file} (${r.height}x${r.width})`);
    for (const e of r.issues) console.error(`    - ${e.msg}`);
  } else {
    console.log(`✓ ${file} (${r.height}x${r.width})  S:${r.spawns} E:${r.exits}`);
  }
}

process.exit(failed ? 1 : 0);
