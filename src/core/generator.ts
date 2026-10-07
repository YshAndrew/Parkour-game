/**
 * 自动地图生成器核心（浏览器 + CLI 共享的纯 TS 模块）。
 *
 * 布局（告别"一条直线"）：
 *  - 平台带不再固定在同一行：每段独立高度 row ∈ [ROW_MIN, ROW_MAX]
 *  - 段间两种连接：
 *      * 坑（gap）：仅限同高度段之间，宽 ∈ [1, maxGap]（≤6，跑跳必过）
 *      * 台阶（step）：相邻列无水平间隙，上 ≤2 格 / 下 ≤3 格（单跳顶点 ≈3.05 格，理论必可跳）
 *  - 可选高空金币路线：难度 ≥0.5 时中段上方放单向平台（高于段带 5 格，仅跳+上冲可达）
 *
 * 通过标准 = 结构校验（validateGrid）+ 理论可达（theoreticalCheck）；
 * 质量优先 = 优先挑 simulate bot 零死亡的种子（信息性）。
 *
 * 用法：
 *   const r = generateMap({ difficulty: 0.7, width: 100, seed: 42, simulate: true });
 *   if (r) setRows(r.rows);            // 编辑器直接载入画布
 */

import { validateGrid } from './validate.ts';
import { simulateGrid } from './simulate.ts';

// ---------- 网格常量 ----------

/** 生成网格总行数 */
export const GEN_ROWS = 18;
const LAVA_ROW = 15; // 底部岩浆整条
const BASE_ROW = 16; // 基岩
const ROW_MIN = 9; // 平台带最低行（越高越靠上）
const ROW_MAX = 13; // 平台带最高行（越接近岩浆）
const ROW_START = 11; // 起始平台带行

// 玩家能力（src/core/config.ts 换算；二段跳/二段冲刺默认关，按单跳/单冲设计）
const JUMP_GAP = 6; // 跑跳水平距离（格），坑宽安全上限
const SPIKE_MAX_W = 4; // 尖刺组可越宽度上限（格）
const BOUNCE_RANGE = 10; // 弹跳板水平飞出距离（格）
const STEP_UP_MAX = 2; // 上台阶最大高度（单跳顶点≈3.05 格）
const STEP_DOWN_MAX = 3; // 下台阶最大落差

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
  stepChance: number;
  bonusChance: number;
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
    // 高难度台阶更频繁（垂直变化更多）
    stepChance: 0.2 + 0.35 * d,
    // 高空奖励路线仅在较高难度出现
    bonusChance: d >= 0.5 ? 0.25 : 0,
  };
}

// ---------- 布局生成 ----------

interface Seg {
  x0: number;
  x1: number;
  row: number;
}
type Conn =
  | { kind: 'gap'; x0: number; w: number; row: number }
  | { kind: 'step'; fromRow: number; toRow: number }
  | null; // 相邻同高段（合并运行），无约束

interface Layout {
  segs: Seg[];
  /** conns[i] = seg[i] 与 seg[i+1] 的连接（长度 = segs.length - 1） */
  conns: Conn[];
}

/**
 * 生成分段 + 连接布局。构造即保证：
 *  - 坑宽 ∈ [1, maxGap] 且两侧同高（跑跳必可过）
 *  - 台阶上 ≤2 / 下 ≤3，相邻列（理论必可跳/落）
 *  - 坑后/台阶后平台宽 ≥ 8 格
 *  - 首段 ≥ 10、收尾段 ≥ 12 格；台阶总数受 stepBudget 限制防锯齿
 */
function generateLayout(rng: () => number, p: GenParams, width: number): Layout {
  const segs: Seg[] = [];
  const conns: Conn[] = [];

  let x = 0;
  let row = ROW_START;
  segs.push({ x0: 0, x1: randInt(rng, 10, 16) - 1, row }); // S 段
  x = segs[0].x1 + 1;
  let stepBudget = 6;

  while (true) {
    const remaining = width - x;
    if (remaining <= 14) break;

    let madeStep = false;
    if (stepBudget > 0) {
      const upMax = Math.min(STEP_UP_MAX, row - ROW_MIN);
      const downMax = Math.min(STEP_DOWN_MAX, ROW_MAX - row);
      if ((upMax > 0 || downMax > 0) && rng() < p.stepChance) {
        const up = upMax > 0 && (downMax === 0 || rng() < 0.55);
        const delta = randInt(rng, 1, up ? upMax : downMax);
        const newRow = up ? row - delta : row + delta;
        conns.push({ kind: 'step', fromRow: row, toRow: newRow });
        row = newRow;
        stepBudget--;
        const runW = randInt(rng, 10, 16);
        const x1 = Math.min(x + runW - 1, width - 14);
        segs.push({ x0: x, x1, row });
        x = x1 + 1;
        madeStep = true;
      }
    }
    if (madeStep) continue;

    // 坑（同高）
    const gapW = randInt(rng, 1, p.maxGap);
    const minW = Math.max(8, gapW + 4);
    if (x + gapW + minW + 14 > width) break;
    conns.push({ kind: 'gap', x0: x, w: gapW, row });
    x += gapW;
    const runW = randInt(rng, minW, minW + 6);
    const x1 = Math.min(x + runW - 1, width - 14);
    segs.push({ x0: x, x1, row });
    x = x1 + 1;
  }

  // 收尾段（与上一段相邻同高，视为合并运行；过窄则并入上一段）
  const tail: Seg = { x0: x, x1: width - 1, row };
  if (tail.x1 - tail.x0 + 1 < 12) {
    segs[segs.length - 1].x1 = width - 1;
  } else {
    segs.push(tail);
  }
  return { segs, conns };
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

function isPlatformCol(g: string[][], x: number, row: number): boolean {
  return x >= 0 && x < g[0].length && g[row][x] === '#';
}

interface Placed {
  spikes: { x0: number; w: number }[];
  bounces: number[];
  checkpoints: number[];
}

function renderGrid(layout: Layout, rng: () => number, p: GenParams, width: number) {
  const g = newGrid(width);
  const placed: Placed = { spikes: [], bounces: [], checkpoints: [] };

  // 1) 平台带（每段自己的高度）
  for (const seg of layout.segs) {
    for (let x = seg.x0; x <= seg.x1; x++) g[seg.row][x] = '#';
  }

  // 2) S / E（首段 / 末段的段高 - 1 行）
  const first = layout.segs[0];
  const last = layout.segs[layout.segs.length - 1];
  put(g, 1, first.row - 1, 'S');
  put(g, width - 1, last.row - 1, 'E');

  // 3) 段内机关（首段 / 收尾段保持纯净）
  for (let i = 0; i < layout.segs.length; i++) {
    const seg = layout.segs[i];
    const isFirst = i === 0;
    const isLast = i === layout.segs.length - 1;
    const objRow = seg.row - 1;
    const coinRow = seg.row - 3;

    if (!isFirst && !isLast && i % p.checkpointEvery === 0) {
      const cx = seg.x0 + Math.floor((seg.x1 - seg.x0 + 1) / 2);
      if (put(g, cx, objRow, 'C')) placed.checkpoints.push(cx);
    }

    if (!isFirst && !isLast && rng() < p.bounceChance) {
      const bx = randInt(rng, seg.x0 + 2, seg.x1 - 2);
      if (g[objRow][bx] === '.' && isPlatformCol(g, bx + BOUNCE_RANGE, seg.row)) {
        g[objRow][bx] = 'B';
        placed.bounces.push(bx);
      }
    }

    const canSpike = !isFirst && !isLast && rng() < p.spikeChance && seg.x1 - seg.x0 + 1 >= p.runway * 2 + 2;
    if (canSpike) {
      const maxW = Math.min(p.spikeW, seg.x1 - seg.x0 + 1 - p.runway * 2);
      const W = randInt(rng, 1, Math.max(1, maxW));
      const sx = randInt(rng, seg.x0 + p.runway, seg.x1 - p.runway - W + 1);
      let ok = true;
      for (let k = 0; k < W; k++) if (g[objRow][sx + k] !== '.') ok = false;
      if (ok) {
        for (let k = 0; k < W; k++) g[objRow][sx + k] = '^';
        placed.spikes.push({ x0: sx, w: W });
      }
    }

    let coinX = seg.x0 + 1;
    while (coinX <= seg.x1 - 1) {
      put(g, coinX, coinRow, 'o');
      coinX += p.coinEvery;
    }

    const gapAfter = i < layout.conns.length ? layout.conns[i] : null;
    if (gapAfter && gapAfter.kind === 'gap' && !isLast && rng() < p.boostChance) {
      const n = randInt(rng, 2, 3);
      let ok = true;
      for (let k = 0; k < n; k++) if (g[objRow][seg.x1 - k] !== '.') ok = false;
      if (ok) for (let k = 0; k < n; k++) g[objRow][seg.x1 - k] = '>';
    }
  }

  // 4) 坑：单向平台 / 移动平台（可选路线，主线上方，相对坑高）
  for (let i = 0; i < layout.conns.length; i++) {
    const conn = layout.conns[i];
    if (!conn || conn.kind !== 'gap') continue;
    const cx = conn.x0 + Math.floor(conn.w / 2);
    if (conn.w >= 2 && rng() < p.onewayChance) put(g, cx, conn.row - 2, '=');
    if (rng() < p.movingChance) put(g, cx, conn.row - 3, rng() < 0.5 ? 'M' : 'm');
  }

  // 5) 可选高空金币路线（跳 + 上冲可达；含弹跳板的段不放，避免干扰弹射）
  if (p.bonusChance > 0) {
    for (let i = 1; i < layout.segs.length - 1; i++) {
      const seg = layout.segs[i];
      if (placed.bounces.some((bx) => bx >= seg.x0 && bx <= seg.x1)) continue;
      if (rng() >= p.bonusChance) continue;
      const len = randInt(rng, 3, 4);
      const by = seg.row - 5;
      if (by < 2) continue;
      const bx = randInt(rng, seg.x0 + 2, Math.max(seg.x0 + 2, seg.x1 - len - 1));
      let ok = true;
      for (let k = 0; k < len; k++) if (g[by][bx + k] !== '.') ok = false;
      if (!ok) continue;
      for (let k = 0; k < len; k++) g[by][bx + k] = '=';
      for (let k = 0; k < len; k += 2) put(g, bx + k, by - 1, 'o');
    }
  }

  return { g, placed };
}

// ---------- 理论可达性校验（对布局 + 放置记录断言） ----------

function theoreticalCheck(layout: Layout, p: GenParams, placed: Placed, width: number): string[] {
  const issues: string[] = [];
  const segs = layout.segs;
  const conns = layout.conns;

  for (let i = 0; i < conns.length; i++) {
    const conn = conns[i];
    const left = segs[i];
    const right = segs[i + 1];
    if (!conn) {
      if (left.x1 + 1 !== right.x0) issues.push(`段 ${i}→${i + 1} 无连接但不相邻`);
      continue;
    }
    if (conn.kind === 'gap') {
      if (conn.w > p.maxGap) issues.push(`坑宽 ${conn.w} 超过 maxGap=${p.maxGap}`);
      if (conn.w > JUMP_GAP) issues.push(`坑宽 ${conn.w} 超过跑跳极限 ${JUMP_GAP}`);
      if (left.row !== conn.row || right.row !== conn.row) {
        issues.push(`坑两侧高度不一致（${left.row}/${right.row}/${conn.row}）`);
      }
      if (right.x1 - right.x0 + 1 < Math.max(8, conn.w + 4)) {
        issues.push(`坑后平台过窄（${right.x1 - right.x0 + 1} < ${Math.max(8, conn.w + 4)}）`);
      }
    } else {
      const up = conn.toRow < conn.fromRow;
      const d = Math.abs(conn.toRow - conn.fromRow);
      if (up && d > STEP_UP_MAX) issues.push(`上台阶 ${d} 超过 ${STEP_UP_MAX}`);
      if (!up && d > STEP_DOWN_MAX) issues.push(`下台阶 ${d} 超过 ${STEP_DOWN_MAX}`);
      if (right.x0 !== left.x1 + 1) issues.push(`台阶应有相邻列`);
      if (right.x1 - right.x0 + 1 < 8) issues.push(`台阶后平台过窄`);
    }
  }

  for (const s of placed.spikes) {
    if (s.w > SPIKE_MAX_W) issues.push(`尖刺组宽 ${s.w} 超过可越宽度 ${SPIKE_MAX_W}`);
    const seg = segs.find((r) => s.x0 >= r.x0 && s.x0 <= r.x1);
    if (!seg) {
      issues.push(`尖刺不在平台段内（x=${s.x0}）`);
      continue;
    }
    const leftFlat = s.x0 - seg.x0;
    const rightFlat = seg.x1 - (s.x0 + s.w - 1);
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
