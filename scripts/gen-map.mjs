#!/usr/bin/env node
/**
 * Pixel Parkour 自动地图生成器（CLI 薄壳）
 * ===============================
 *
 * 生成核心已提升为共享模块 src/core/generator.ts（浏览器编辑器与 CLI 同一套逻辑）：
 *   - 构造式生成 + 理论可达性保证（坑宽 ≤ 6、尖刺宽 ≤ 4 且前后留平地、弹跳板落点安全）
 *   - 通过标准 = 结构校验 + 理论可达；仿真仅信息性报告（bot 对平地尖刺有决策死区，
 *     失败不代表地图不可通关）
 *   - 质量优先：最多尝试 6 个种子，优先挑 bot 零死亡的布局
 *
 * 用法：
 *   node scripts/gen-map.mjs                          # 默认难度 0.5，输出到 ../src/levels/maps
 *   node scripts/gen-map.mjs -d 0.85 -l 100 -n "熔岩试炼" -t cave
 *   node scripts/gen-map.mjs -d 0.3 --seed 42         # 同种子可复现
 *   node scripts/gen-map.mjs -d 0.7 -c 3              # 批量 3 张
 *   node scripts/gen-map.mjs --out-dir D:\game\src\levels\maps   # 指定输出目录
 *   node scripts/gen-map.mjs --no-simulate            # 只做结构 + 理论验证，不跑仿真
 */

import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMap, GEN_ROWS } from '../src/core/generator.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------- 生成 .ts 文件 ----------------

function nextDefaultFileName(outDir) {
  let max = 0;
  if (existsSync(outDir)) {
    for (const f of readdirSync(outDir).filter((f) => f.endsWith('.ts'))) {
      const m = f.match(/^(\d+)-/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return String(max + 1).padStart(2, '0') + '-auto.ts';
}

function buildLevelFile(result, theme) {
  const rows = result.rows.map((row) => `    '${row}',`).join('\n');
  return `import type { LevelData } from '../../core/map-format';

/**
 * 自动生成地图（生成器 v2，理论可通关保证）
 * 难度系数: ${result.diff.toFixed(2)}  坑宽上限: ${result.maxGap} 格  尖刺组宽上限: ${result.spikeW} 格
 * 随机种子: ${result.seed}  宽度: ${result.width} 列  行数: ${GEN_ROWS}
 * 生成命令: node scripts/gen-map.mjs -d ${result.diff} -l ${result.width} --seed ${result.seed}
 */
const level: LevelData = {
  meta: {
    id: '${result.id}',
    name: '${result.name}',
    hint: '${result.hint}',
    theme: '${theme}',
  },
  grid: [
${rows}
  ],
};

export default level;
`;
}

// ---------------- 参数解析 ----------------

function parseArgs(argv) {
  const args = { difficulty: 0.5, length: 80, count: 1, simulate: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-d':
      case '--difficulty':
        args.difficulty = parseFloat(next());
        break;
      case '-l':
      case '--length':
        args.length = parseInt(next(), 10);
        break;
      case '-n':
      case '--name':
        args.name = next();
        break;
      case '-t':
      case '--theme':
        args.theme = next();
        break;
      case '--seed':
        args.seed = parseInt(next(), 10);
        break;
      case '-o':
      case '--out':
        args.out = next();
        break;
      case '--out-dir':
        args.outDir = next();
        break;
      case '-c':
      case '--count':
        args.count = parseInt(next(), 10);
        break;
      case '--no-simulate':
        args.simulate = false;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        console.error(`未知参数: ${a}（用 --help 查看用法）`);
        process.exit(1);
    }
  }
  return args;
}

// ---------------- 主流程 ----------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Pixel Parkour 自动地图生成器 v2（理论可通关保证）

用法: node scripts/gen-map.mjs [选项]

选项:
  -d, --difficulty <0.05~1.0>  难度系数（默认 0.5）：控制冗余量
  -l, --length <列数>          地图宽度（默认 80，最小 48）
  -n, --name <名称>            关卡名（默认"自动生成·难度X"）
  -t, --theme <主题>           forest | cave | sky（默认 forest）
      --seed <整数>            随机种子，同种子可复现
  -o, --out <文件名>           输出文件名（默认自动编号，如 07-auto.ts）
      --out-dir <目录>         输出目录（默认 ../src/levels/maps；不存在则 ./maps-out）
  -c, --count <张数>           批量生成张数（默认 1）
      --no-simulate            关闭信息性仿真报告（通过标准不变：结构+理论可达）
  -h, --help                   显示帮助

难度系数与冗余（难度高 = 冗余低）:
  0.1~0.3  坑 1~3 格、尖刺窄(1格)而稀疏、助跑 7 格、单向/移动平台多、检查点密 —— 教学
  0.4~0.6  坑 3~5 格、尖刺 2 格、助跑 5 格，机关渐少 —— 标准
  0.7~1.0  坑 5~6 格、尖刺 3~4 格而密、助跑 3 格、辅助少 —— 极限跑跳

通过标准: 结构校验（S/E/落脚/坐实心）+ 理论可达性（坑宽≤6、尖刺宽≤4且前后
平地≥runway、弹跳板落点安全）。仿真（simulate）仅作信息性报告——bot 对平地
尖刺有决策局限（固定步长起跳），失败不代表地图不可通关。
`);
    return;
  }

  const diff = Math.min(1, Math.max(0.05, args.difficulty));
  const baseSeed = args.seed ?? Math.floor(Math.random() * 1e9);

  // 输出目录解析
  let outDir = args.outDir ? resolve(args.outDir) : null;
  if (!outDir) {
    const candidates = [join(SCRIPT_DIR, '../src/levels/maps'), join(SCRIPT_DIR, 'src/levels/maps')];
    outDir = candidates.find((p) => existsSync(p)) ?? resolve('maps-out');
  }

  const theme = args.theme || 'forest';
  let failed = 0;
  for (let i = 0; i < args.count; i++) {
    const seed = baseSeed + i * 7919;
    const result = generateMap({ difficulty: diff, width: args.length, seed, simulate: args.simulate });

    if (!result) {
      failed++;
      console.error(`✗ 生成失败 ${args.out || 'auto'}: 连续 6 次结构/理论校验未过，请调整参数重试。`);
      continue;
    }

    const outName = args.out || nextDefaultFileName(outDir);
    const name = args.name || result.name;
    const outPath = join(outDir, outName);
    const ts = buildLevelFile({ ...result, name }, theme);
    writeFileSync(outPath, ts, 'utf8');

    // 报告
    let simMsg = '仿真: 未运行';
    if (result.simulate) {
      simMsg = result.botOk
        ? `仿真: bot 零死亡通关`
        : `仿真: bot ${result.simulate.deaths} 死（推进到 x=${Math.round(result.simulate.maxX)}，bot 决策局限，理论仍可通关）`;
    }
    console.log(`✓ ${outName}  结构: 通过  理论: 通过  ${simMsg}`);
    console.log(`✓ 已生成 ${outName}  难度=${diff.toFixed(2)}  尺寸=${GEN_ROWS}x${result.width}  种子=${result.seed}`);
  }

  if (failed > 0) process.exit(1);
  console.log(`\n完成：${args.count - failed}/${args.count} 张，全部通过结构 + 理论可达性验证。`);
}

main();
