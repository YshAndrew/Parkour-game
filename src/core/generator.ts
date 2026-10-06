/**
 * 自动地图生成器核心（浏览器 + CLI 共享的纯 TS 模块）。
 *
 * 从 scripts/gen-map.mjs 提取：构造式生成 + 理论可达性保证，难度系数控制"冗余"。
 * 通过标准 = 结构校验（src/core/validate.ts）+ 理论可达性（几何上必存在可行路线）；
 * 质量优先 = 在满足通过标准的前提下，优先挑选 simulate bot 零死亡的种子
 * （bot 对平地尖刺有决策死区，bot 死亡不代表地图不可通关，因此是"优先"而非"必须"）。
 *
 * 用法：
 *   const r = generateMap({ difficulty: 0.7, width: 100, seed: 42, simulate: true });
 *   if (r) setRows(r.rows);            // 编辑器直接载入画布
 */

import { validateGrid } from './validate.ts';
import { simulateGrid } from './simulate.ts';

// ---------- 网格常量（对齐 04-06 图惯例） ----------

/** 生成网格总行数 */
export const GEN_ROWS = 18;
const PLATFORM_ROW = 12; // 平台带行（角色站其上面）
const LAVA_ROW = 15; // 底部岩浆整条
const BASE_ROW = 16; // 基岩
const OBJ_ROW = 11; // S/E/C/B/^/> 所在行（平台带上一行）
const COIN_ROW = 9; // 金币行
const ONEWAY_ROW = 10; // 单向平台 '=' 行（坑上方安全网）
const MOVING_ROW = 9; // 移动平台 M/m 行（坑上方可选路线）

// 玩家能力（src/core/config.ts 换算）
const JUMP_GAP = 6; // 跑跳水平距离（格），坑宽安全上限
const SPIKE_MAX_W = 4; // 尖刺组可越宽度上限（格）
const BOUNCE_RANGE = 10; // 弹跳板水平飞出距离（格）

export interface GenOptions {
  /** 难度系数 0.05~1.0，控制冗余量；默认 0.5 */
  difficulty?: number;
  /** 地图宽度（列），最小 48；默认 80 */
  width?: number;
  /** 随机种子；缺省随机。同种子可复现同一张图 */
  seed?: number;
  /** 是否跑仿真挑 bot 零死亡的种子；默认 true（false 时首个合格种子即返回） */
  simulate?: boolean;
}

export interface SimInfo {
  reached: boolean;
  deaths: number;
  maxX: number;
  reason?: string;
}

export interface GenResult {
  rows: string[];
  width: number;
  height: number;
  seed: number;
  diff: number;
  maxGap: number;
  spikeW: number;
  id: string;
  name: string;
  hint: string;
  /** 理论可达性问题（正常应为空数组） */
  issues: string[];
  /** 选中种子的仿真结果；simulate:false 时为 null */
  simulate: SimInfo | null;
  /** 是否 bot 零死亡 */
  botOk: boolean;
}

// ---------- 工具 ----------

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function randInt(rng: () => number, lo: number, hi: number) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
/** mulberry32：可复现 PRNG */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 难度参数（冗余导向） ----------

interface GenParams {
  diff: number;
  maxGap: number;
  spikeW: number;
  spikeChance: number;
  runway: number;
  onewayChance: number;
  bounceChance: number;
  boostChance: number;
  movingChance: number;
  coinEvery: number;
  checkpointEvery: number;
}

function difficultyParams(diff: number): GenParams {
  const d = clamp(diff, 0.05, 1.0);
  return {
    diff: d,
    maxGap: Math.round(lerp(1, 6, d)),
    spikeW: d < 0.3 ? 1 : d < 0.55 ? 2 : d < 0.8 ? 3 : 4,
    spikeChance: 0.12 + 0.55 * d,
    runway: Math.max(3, 7 - Math.round(4 * d)),
    onewayChance: Math.max(0, 0.4 - 0.3 * d),
    bounceChance: d >= 0.35 ? 0.12 + 0.25 * d : 0,
    boostChance: d >= 0.5 ? 0.2 + 0.25 * d : 0,
    movingChance: Math.max(0, 0.25 - 0.15 * d),
    coinEvery: Math.round(2 + 3 * d),
    checkpointEvery: Math.round(5 + 6 * d),
  };
}

// ---------- 布局生成 ----------

interface Run {
  x0: number;
  x1: number;
}
interface Gap {
  x0: number;
  w: number;
}

/**
 * 生成平台段 + 坑布局。不变式（构造即保证）：
 *   - 坑宽 ∈ [1, maxGap]（≤6，跑跳必然可过）
 *   - 坑后平台宽 ≥ max(8, 坑宽+4)（容纳落点偏移）
 *   - 首段 ≥ 10、收尾段 ≥ 12 格
 */
function generateLayout(rng: () => number, p: GenParams, width: number) {
  const runs: Run[] = [];
  const gaps: Gap[] = [];

  let x = 0;
  runs.push({ x0: x, x1: x + randInt(rng, 10, 16) - 1 }); // S 段
  x = runs[0].x1 + 1;

  while (true) {
    const gapW = randInt(rng, 1, p.maxGap);
    const minW = Math.max(8, gapW + 4);
    if (x + gapW + minW + 14 > width) break;

    gaps.push({ x0: x, w: gapW });
    x += gapW;

    const runW = randInt(rng, minW, minW + 6);
    const x1 = Math.min(x + runW - 1, width - 14);
    runs.push({ x0: x, x1 });
    x = x1 + 1;
  }

  const tail: Run = { x0: x, x1: width - 1 };
  if (tail.x1 - tail.x0 + 1 < 12) {
    runs[runs.length - 1].x1 = width - 1;
  } else {
    runs.push(tail);
  }
  return { runs, gaps };
}

// ---------- 网格渲染 ----------

function newGrid(width: number): string[][] {
  const g: string[][] = [];
  for (let y = 0; y < GEN_ROWS; y++) g.push(new Array(width).fill('.'));
  for (let x = 0; x < width; x++) {
    g[LAVA_ROW][x] = '~';
    g[BASE_ROW][x] = '#';
    g[BASE_ROW + 1][x] = '#';
  }
  return g;
}

function put(g: string[][], x: number, y: number, ch: string): boolean {
  if (y < 0 || y >= GEN_ROWS || x < 0 || x >= g[0].length) return false;
  if (g[y][x] !== '.') return false;
  g[y][x] = ch;
  return true;
}

function isPlatformCol(g: string[][], x: number): boolean {
  return x >= 0 && x < g[0].length && g[PLATFORM_ROW][x] === '#';
}

interface Placed {
  spikes: { x0: number; w: number }[];
  bounces: number[];
  checkpoints: number[];
}

function renderGrid(layout: { runs: Run[]; gaps: Gap[] }, rng: () => number, p: GenParams, width: number) {
  const g = newGrid(width);
  const placed: Placed = { spikes: [], bounces: [], checkpoints: [] };

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

    if (!isFirst && !isLast && i % p.checkpointEvery === 0) {
      const cx = r.x0 + Math.floor((r.x1 - r.x0 + 1) / 2);
      if (put(g, cx, OBJ_ROW, 'C')) placed.checkpoints.push(cx);
    }

    if (!isFirst && !isLast && rng() < p.bounceChance) {
      const bx = randInt(rng, r.x0 + 2, r.x1 - 2);
      if (g[OBJ_ROW][bx] === '.' && isPlatformCol(g, bx + BOUNCE_RANGE)) {
        g[OBJ_ROW][bx] = 'B';
        placed.bounces.push(bx);
      }
    }

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

    let coinX = r.x0 + 1;
    while (coinX <= r.x1 - 1) {
      put(g, coinX, COIN_ROW, 'o');
      coinX += p.coinEvery;
    }

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

// ---------- 理论可达性校验（对布局 + 放置记录断言） ----------

function theoreticalCheck(layout: { runs: Run[]; gaps: Gap[] }, p: GenParams, placed: Placed, width: number): string[] {
  const issues: string[] = [];
  const runs = layout.runs;

  for (const gap of layout.gaps) {
    if (gap.w > p.maxGap) issues.push(`坑宽 ${gap.w} 超过 maxGap=${p.maxGap}`);
    if (gap.w > JUMP_GAP) issues.push(`坑宽 ${gap.w} 超过跑跳极限 ${JUMP_GAP}`);
  }

  for (let i = 0; i < layout.gaps.length; i++) {
    const right = runs[i + 1];
    const gap = layout.gaps[i];
    if (right && right.x1 - right.x0 + 1 < Math.max(8, gap.w + 4)) {
      issues.push(`坑后平台过窄（${right.x1 - right.x0 + 1} < ${Math.max(8, gap.w + 4)}）`);
    }
  }

  for (const s of placed.spikes) {
    if (s.w > SPIKE_MAX_W) issues.push(`尖刺组宽 ${s.w} 超过可越宽度 ${SPIKE_MAX_W}`);
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

  for (const bx of placed.bounces) {
    if (bx + BOUNCE_RANGE >= width) issues.push(`弹跳板 B 落点超出地图（x=${bx}）`);
  }

  return issues;
}

// ---------- 对外入口 ----------

/**
 * 生成一张满足"结构 + 理论可达"的地图。
 * 质量优先：最多尝试 6 个种子（seed..seed+5），优先返回 bot 零死亡的布局；
 * 都没有则返回最后一个结构+理论通过的结果；全部失败返回 null。
 */
export function generateMap(opts: GenOptions = {}): GenResult | null {
  const diff = clamp(opts.difficulty ?? 0.5, 0.05, 1.0);
  const p = difficultyParams(diff);
  const width = Math.max(48, opts.width ?? 80);
  const doSim = opts.simulate ?? true;
  const baseSeed = opts.seed ?? Math.floor(Math.random() * 1e9);

  let best: GenResult | null = null;
  let botOk: GenResult | null = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const seed = baseSeed + attempt;
    const rng = mulberry32(seed);
    const layout = generateLayout(rng, p, width);
    const { g, placed } = renderGrid(layout, rng, p, width);
    const issues = theoreticalCheck(layout, p, placed, width);
    const rows = g.map((r) => r.join(''));

    const vOk = validateGrid(rows).ok;
    if (!vOk || issues.length > 0) continue;

    const sim = doSim ? simulateGrid(rows) : null;
    const res: GenResult = {
      rows,
      width,
      height: GEN_ROWS,
      seed,
      diff,
      maxGap: p.maxGap,
      spikeW: p.spikeW,
      id: 'auto-' + seed.toString(36),
      name: `自动生成·难度${diff.toFixed(2)}`,
      hint: `难度 ${diff.toFixed(2)}，坑宽上限 ${p.maxGap} 格，尖刺上限 ${p.spikeW} 格`,
      issues: [],
      simulate: sim,
      botOk: !!(sim && sim.reached && sim.deaths === 0),
    };

    if (!best) best = res;
    if (res.botOk) {
      botOk = res;
      break;
    }
    if (!doSim) break;
  }

  return botOk ?? best;
}
