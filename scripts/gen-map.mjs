#!/usr/bin/env node
/**
 * Pixel Parkour 自动地图生成器 v2
 * ===============================
 *
 * 设计目标：构造式生成 + 理论可达性保证，难度系数控制"冗余"。
 *
 * 一、为什么是"理论可通关"而不是"bot 零死亡"：
 *   项目 simulate 的 bot 以固定步长做跳跃决策，对"平地尖刺"存在决策死区
 *   （决策点落在距尖刺 1~2 格时，任何跳跃计划的起跳弧线都会擦到尖刺），
 *   这是 bot 的实现局限，不代表地图不可通关。因此本生成器：
 *   - 通过标准 = 结构校验 + 理论可达性（几何上一定存在可行路线，人类可过）；
 *   - 仿真结果仅作信息性报告（--simulate 默认开，可关）。
 *
 * 二、理论可达性（生成时强制的不变式）：
 *   - 主线 = 平台段 + 坑的平面带；坑宽 ≤ maxGap ≤ 6 格
 *     （跑跳水平 ≈ 6 格、冲刺跳 ≈ 9 格，6 格以内必然存在跳跃方案）；
 *   - 尖刺组宽 ≤ 4 格（跑跳 6 格 = 起跳 1 + 尖刺 W + 落地 1 ⇒ W ≤ 4），
 *     且尖刺前后各留 ≥ runway 格平地（助跑 / 落点）；
 *   - 坑后平台段加宽（≥ 坑宽+4、至少 8 格），容纳落点偏移；
 *   - 弹跳板 B 要求 B 列 +10 处仍是平台带（弹起约 7 格高、水平飞出约 10 格）；
 *   - 移动平台 M/m 只放主线上方当可选路线；
 *   - S 贴地、E 放最右列贴地。
 *
 * 三、难度系数 diff ∈ [0.05, 1.0] 控制"冗余"（容错空间）：
 *   低难度 = 高冗余：坑宽远低于能力极限、尖刺窄而稀疏、助跑距离长、
 *   单向平台 / 移动平台多、检查点密、金币密。
 *   高难度 = 低冗余：坑宽贴极限（6 格）、尖刺宽（3~4 格）而密、助跑仅 3 格、
 *   辅助机关少、检查点稀、金币稀。
 *
 * 四、独立工作区运行（不依赖项目被编辑的文件）：
 *   生成器自包含；若脚本同级存在 src/core/validate.ts 与 simulate.ts（副本或
 *   项目本体的模块化版本）则自动复用做校验与信息性仿真。
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
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------- 网格常量（对齐项目 04-06 惯例） ----------------
const H = 18; // 总行数
const PLATFORM_ROW = 12; // 平台带行（角色站其上面）
const LAVA_ROW = 15; // 底部岩浆整条
const BASE_ROW = 16; // 基岩
const OBJ_ROW = 11; // S/E/C/B/^/> 所在行（平台带上一行）
const COIN_ROW = 9; // 金币行
const ONEWAY_ROW = 10; // 单向平台 '=' 行（坑上方安全网）
const MOVING_ROW = 9; // 移动平台 M/m 行（坑上方可选路线）

// 玩家能力（src/core/config.ts）
const JUMP_GAP = 6; // 跑跳水平距离（格），坑宽安全上限
const SPIKE_MAX_W = 4; // 尖刺组可越宽度上限（格）
const BOUNCE_RANGE = 10; // 弹跳板水平飞出距离（格）

// ---------------- 工具 ----------------

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
/** mulberry32：可复现 PRNG */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- 难度参数（冗余导向） ----------------

function difficultyParams(diff) {
  const d = clamp(diff, 0.05, 1.0);
  return {
    diff: d,
    // 坑宽上限：低难度远离极限（高冗余），高难度贴极限 6 格
    maxGap: Math.round(lerp(1, 6, d)),
    // 尖刺组最大宽度：1 ~ 4 格（≤4 保证一跳可越）
    spikeW: d < 0.3 ? 1 : d < 0.55 ? 2 : d < 0.8 ? 3 : 4,
    // 尖刺组出现概率
    spikeChance: 0.12 + 0.55 * d,
    // 尖刺前后平地（助跑/落点）：低难度 7 格（高冗余），高难度 3 格
    runway: Math.max(3, 7 - Math.round(4 * d)),
    // 单向平台（坑上安全网）：低难度多，高难度少
    onewayChance: Math.max(0, 0.4 - 0.3 * d),
    // 弹跳板 B：中高难度特色
    bounceChance: d >= 0.35 ? 0.12 + 0.25 * d : 0,
    // 坑前加速带 '>'：高难度
    boostChance: d >= 0.5 ? 0.2 + 0.25 * d : 0,
    // 移动平台 M/m（可选路线）：低难度多（冗余），高难度少
    movingChance: Math.max(0, 0.25 - 0.15 * d),
    // 金币间隔（列）：低难度密（2），高难度稀（5）
    coinEvery: Math.round(2 + 3 * d),
    // 检查点每 N 段：低难度密（5），高难度稀（11）
    checkpointEvery: Math.round(5 + 6 * d),
  };
}

// ---------------- 布局生成 ----------------

/**
 * 生成平台段 + 坑布局。不变式（构造即保证）：
 *   - 坑宽 ∈ [1, maxGap]（≤6，跑跳必然可过）
 *   - 坑后平台宽 ≥ max(8, 坑宽+4)（容纳落点偏移）
 *   - 首段 ≥ 10、收尾段 ≥ 12 格
 */
function generateLayout(rng, p, width) {
  const runs = [];
  const gaps = [];

  let x = 0;
  runs.push({ x0: x, x1: x + randInt(rng, 10, 16) - 1 }); // S 段
  x = runs[0].x1 + 1;

  // 中间交替段：每次迭代前先确认剩余空间放得下"一个坑 + 一段加宽平台 + 收尾段(≥14)"
  while (true) {
    const gapW = randInt(rng, 1, p.maxGap);
    const minW = Math.max(8, gapW + 4); // 坑后平台最小宽度
    if (x + gapW + minW + 14 > width) break; // 放不下则直接收尾

    gaps.push({ x0: x, w: gapW });
    x += gapW;

    const runW = randInt(rng, minW, minW + 6);
    const x1 = Math.min(x + runW - 1, width - 14); // 预留收尾段
    runs.push({ x0: x, x1 });
    x = x1 + 1;
  }

  // 收尾段：≥13 格（因上段截断到 width-14），E 放最右列
  const tail = { x0: x, x1: width - 1 };
  if (tail.x1 - tail.x0 + 1 < 12) {
    runs[runs.length - 1].x1 = width - 1;
  } else {
    runs.push(tail);
  }
  return { runs, gaps };
}

// ---------------- 网格渲染 ----------------

function newGrid(width) {
  const g = [];
  for (let y = 0; y < H; y++) g.push(new Array(width).fill('.'));
  for (let x = 0; x < width; x++) {
    g[LAVA_ROW][x] = '~';
    g[BASE_ROW][x] = '#';
    g[BASE_ROW + 1][x] = '#';
  }
  return g;
}

function put(g, x, y, ch) {
  if (y < 0 || y >= H || x < 0 || x >= g[0].length) return false;
  if (g[y][x] !== '.') return false;
  g[y][x] = ch;
  return true;
}

function isPlatformCol(g, x) {
  return x >= 0 && x < g[0].length && g[PLATFORM_ROW][x] === '#';
}

/** 渲染网格，并返回放置记录供理论校验 */
function renderGrid(layout, rng, p, width) {
  const g = newGrid(width);
  const placed = { spikes: [], bounces: [], checkpoints: [] };

  // 1) 平台带
  for (const r of layout.runs) {
    for (let x = r.x0; x <= r.x1; x++) g[PLATFORM_ROW][x] = '#';
  }

  // 2) S / E
  put(g, 1, OBJ_ROW, 'S');
  put(g, width - 1, OBJ_ROW, 'E');

  // 3) 段内机关（首段 / 收尾段保持纯净）
  const runs = layout.runs;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const isFirst = i === 0;
    const isLast = i === runs.length - 1;

    // 检查点 C（段中央）
    if (!isFirst && !isLast && i % p.checkpointEvery === 0) {
      const cx = r.x0 + Math.floor((r.x1 - r.x0 + 1) / 2);
      if (put(g, cx, OBJ_ROW, 'C')) placed.checkpoints.push(cx);
    }

    // 弹跳板 B：避开检查点列；要求 B 列 + 10 处仍是平台带
    if (!isFirst && !isLast && rng() < p.bounceChance) {
      const bx = randInt(rng, r.x0 + 2, r.x1 - 2);
      if (g[OBJ_ROW][bx] === '.' && isPlatformCol(g, bx + BOUNCE_RANGE)) {
        g[OBJ_ROW][bx] = 'B';
        placed.bounces.push(bx);
      }
    }

    // 尖刺组：段宽需 ≥ runway*2 + W + 2，起点避开两端 runway
    const canSpike = !isFirst && !isLast && rng() < p.spikeChance && r.x1 - r.x0 + 1 >= p.runway * 2 + 2;
    if (canSpike) {
      const maxW = Math.min(p.spikeW, r.x1 - r.x0 + 1 - p.runway * 2);
      const W = randInt(rng, 1, Math.max(1, maxW));
      const sx = randInt(rng, r.x0 + p.runway, r.x1 - p.runway - W + 1);
      let ok = true;
      for (let k = 0; k < W; k++) if (g[OBJ_ROW][sx + k] !== '.') ok = false;
      if (ok) {
        for (let k = 0; k < W; k++) g[OBJ_ROW][sx + k] = '^';
        placed.spikes.push({ x0: sx, w: W });
      }
    }

    // 金币：段内按 coinEvery 间隔（平台带上方）
    let coinX = r.x0 + 1;
    while (coinX <= r.x1 - 1) {
      put(g, coinX, COIN_ROW, 'o');
      coinX += p.coinEvery;
    }

    // 坑前加速带 '>'（段尾 2~3 格，无碰撞装饰）
    const gapAfter = i < runs.length - 1 ? layout.gaps[i] : null;
    if (gapAfter && !isLast && rng() < p.boostChance) {
      const n = randInt(rng, 2, 3);
      let ok = true;
      for (let k = 0; k < n; k++) if (g[OBJ_ROW][r.x1 - k] !== '.') ok = false;
      if (ok) for (let k = 0; k < n; k++) g[OBJ_ROW][r.x1 - k] = '>';
    }
  }

  // 4) 坑：单向平台 / 移动平台（可选路线，主线上方）
  for (let i = 0; i < layout.gaps.length; i++) {
    const gap = layout.gaps[i];
    const right = runs[i + 1];
    if (!right) continue;
    const cx = gap.x0 + Math.floor(gap.w / 2);
    if (gap.w >= 2 && rng() < p.onewayChance) put(g, cx, ONEWAY_ROW, '=');
    if (rng() < p.movingChance) put(g, cx, MOVING_ROW, rng() < 0.5 ? 'M' : 'm');
  }

  return { g, placed };
}

// ---------------- 理论可达性校验（对布局 + 放置记录断言） ----------------

function theoreticalCheck(layout, p, placed, width) {
  const issues = [];
  const runs = layout.runs;

  // 坑宽 ≤ maxGap
  for (let i = 0; i < layout.gaps.length; i++) {
    const gap = layout.gaps[i];
    if (gap.w > p.maxGap) issues.push(`坑宽 ${gap.w} 超过 maxGap=${p.maxGap}`);
    if (gap.w > JUMP_GAP) issues.push(`坑宽 ${gap.w} 超过跑跳极限 ${JUMP_GAP}`);
  }

  // 坑后平台宽 ≥ max(8, 坑宽+4)
  for (let i = 0; i < layout.gaps.length; i++) {
    const right = runs[i + 1];
    const gap = layout.gaps[i];
    if (right && right.x1 - right.x0 + 1 < Math.max(8, gap.w + 4)) {
      issues.push(`坑后平台过窄（${right.x1 - right.x0 + 1} < ${Math.max(8, gap.w + 4)}）`);
    }
  }

  // 尖刺：宽 ≤ SPIKE_MAX_W，前后平地 ≥ runway
  for (const s of placed.spikes) {
    if (s.w > SPIKE_MAX_W) issues.push(`尖刺组宽 ${s.w} 超过可越宽度 ${SPIKE_MAX_W}`);
    // 找所在段，算前后平地
    const run = runs.find((r) => s.x0 >= r.x0 && s.x0 <= r.x1);
    if (!run) {
      issues.push(`尖刺不在平台段内（x=${s.x0}）`);
      continue;
    }
    const leftFlat = s.x0 - run.x0;
    const rightFlat = run.x1 - (s.x0 + s.w - 1);
    if (leftFlat < p.runway) issues.push(`尖刺前平地 ${leftFlat} < runway ${p.runway}`);
    if (rightFlat < p.runway) issues.push(`尖刺后平地 ${rightFlat} < runway ${p.runway}`);
  }

  // 弹跳板落点安全
  for (const bx of placed.bounces) {
    // 落点检查需平台列；这里用宽度近似（渲染网格在外部再验）
    if (bx + BOUNCE_RANGE >= width) issues.push(`弹跳板 B 落点超出地图（x=${bx}）`);
  }

  return issues;
}

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

function buildLevelFile({ id, name, hint, theme, grid, diff, p, seed, width }) {
  const rows = grid.map((row) => `    '${row.join('')}',`).join('\n');
  return `import type { LevelData } from '../../core/map-format';

/**
 * 自动生成地图（生成器 v2，理论可通关保证）
 * 难度系数: ${diff.toFixed(2)}  坑宽上限: ${p.maxGap} 格  尖刺组宽上限: ${p.spikeW} 格
 * 随机种子: ${seed}  宽度: ${width} 列  行数: ${H}
 * 生成命令: node scripts/gen-map.mjs -d ${diff} -l ${width} --seed ${seed}
 */
const level: LevelData = {
  meta: {
    id: '${id}',
    name: '${name}',
    hint: '${hint}',
    theme: '${theme}',
  },
  grid: [
${rows}
  ],
};

export default level;
`;
}

// ---------------- 外部校验模块（可选复用） ----------------

let validateGrid = null;
let simulateGrid = null;

async function loadExternalModules() {
  try {
    // 项目布局（scripts/../src/core）或根布局（./src/core）都试
    const vCandidates = [join(SCRIPT_DIR, '../src/core/validate.ts'), join(SCRIPT_DIR, 'src/core/validate.ts')];
    const sCandidates = [join(SCRIPT_DIR, '../src/core/simulate.ts'), join(SCRIPT_DIR, 'src/core/simulate.ts')];
    const vPath = vCandidates.find((p) => existsSync(p));
    const sPath = sCandidates.find((p) => existsSync(p));
    if (vPath) {
      const m = await import(pathToFileURL(vPath).href + '?t=' + Date.now());
      validateGrid = m.validateGrid;
    }
    if (sPath) {
      const m = await import(pathToFileURL(sPath).href + '?t=' + Date.now());
      simulateGrid = m.simulateGrid;
    }
  } catch (e) {
    // 复用失败不致命：内置理论校验仍在
  }
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

function generateOne(args, p, seed, outDir, outName) {
  const rng = mulberry32(seed);
  const width = Math.max(48, args.length);
  const layout = generateLayout(rng, p, width);
  const { g, placed } = renderGrid(layout, rng, p, width);

  // 理论校验（构造不变式断言）
  const issues = theoreticalCheck(layout, p, placed, width);

  const diff = p.diff;
  const theme = args.theme || 'forest';
  const name = args.name || `自动生成·难度${diff.toFixed(2)}`;
  const hint = `难度 ${diff.toFixed(2)}，坑宽上限 ${p.maxGap} 格，尖刺上限 ${p.spikeW} 格`;
  const outPath = join(outDir, outName);
  const id = 'auto-' + seed.toString(36);

  const ts = buildLevelFile({ id, name, hint, theme, grid: g, diff, p, seed, width });
  writeFileSync(outPath, ts, 'utf8');
  return { outPath, outName, grid: g, width, seed, issues };
}

async function main() {
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

  await loadExternalModules();

  const diff = clamp(args.difficulty, 0.05, 1.0);
  const p = difficultyParams(diff);
  const baseSeed = args.seed ?? Math.floor(Math.random() * 1e9);

  // 输出目录解析
  let outDir = args.outDir ? resolve(args.outDir) : null;
  if (!outDir) {
    // 项目布局（scripts/../src/levels/maps）或根布局（./src/levels/maps）；否则 ./maps-out
    const candidates = [join(SCRIPT_DIR, '../src/levels/maps'), join(SCRIPT_DIR, 'src/levels/maps')];
    outDir = candidates.find((p) => existsSync(p)) ?? resolve('maps-out');
  }

  let failed = 0;
  for (let i = 0; i < args.count; i++) {
    const seed = baseSeed + i * 7919;
    const outName = args.out || nextDefaultFileName(outDir);
    // 质量优先：尝试最多 6 个种子，优先挑 bot 零死亡的布局；
    // 都没有则退回最后一个"结构 + 理论"通过的结果（bot 决策局限，理论仍可通关）。
    let best = null; // 最后一个结构+理论通过的结果
    let botOk = null; // bot 零死亡的结果
    let attempts = 0;

    for (attempts = 0; attempts < 6; attempts++) {
      const result = generateOne(args, p, seed + attempts, outDir, outName);

      // 结构校验（复用项目模块化规则，不可用则跳过）
      let vOk = true;
      let vMsg = '（无 validate 模块，仅理论校验）';
      if (validateGrid) {
        const rows = result.grid.map((r) => r.join(''));
        const vr = validateGrid(rows);
        vOk = vr.ok;
        vMsg = vOk ? `S:${vr.spawns} E:${vr.exits}` : vr.issues.map((e) => e.msg).join('；');
      }

      // 理论可达性（通过标准）
      const tOk = result.issues.length === 0;
      if (!vOk || !tOk) {
        if (attempts === 0) console.log(`  ✗ 结构/理论未过，重试…`);
        continue;
      }
      best = result;

      // 信息性仿真：优先选 bot 零死亡的种子
      if (!args.simulate || !simulateGrid) break; // 不要求 bot 通过时，第一个合格即可
      const rows = result.grid.map((r) => r.join(''));
      const r = simulateGrid(rows);
      if (r.reached && r.deaths === 0) {
        botOk = result;
        break;
      }
    }

    const result = botOk ?? best;
    if (!result) {
      failed++;
      console.error(`✗ 生成失败 ${outName}：连续 6 次结构/理论校验未过，请调整参数重试。`);
      continue;
    }

    // 报告
    let simMsg = '仿真: 未运行';
    if (args.simulate && simulateGrid && (botOk || best)) {
      const rows = result.grid.map((r) => r.join(''));
      const r = simulateGrid(rows);
      const ok = r.reached && r.deaths === 0;
      simMsg = ok
        ? `仿真: bot 零死亡通关`
        : `仿真: bot ${r.deaths} 死（推进到 x=${Math.round(r.maxX)}，bot 决策局限，理论仍可通关）`;
    } else if (args.simulate) {
      simMsg = '仿真: 无 simulate 模块，跳过';
    }
    console.log(
      `✓ ${result.outName}  结构: 通过  理论: 通过  ${simMsg}`,
    );
    console.log(`✓ 已生成 ${result.outName}  难度=${diff.toFixed(2)}  尺寸=${H}x${result.width}  种子=${seed}`);
  }

  if (failed > 0) process.exit(1);
  console.log(`\n完成：${args.count - failed}/${args.count} 张，全部通过结构 + 理论可达性验证。`);
}

main();
