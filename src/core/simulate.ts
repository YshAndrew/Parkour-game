/**
 * 关卡可通关性仿真（无头物理校验）
 * =================================
 * 直接驱动真实的 Platformer 物理类，用“带前瞻规划的 bot”实际跑一遍网格，
 * 确认它能零死亡触达终点传送门 E。编辑器“可通关性检查”与
 * scripts/simulate.mjs 共用这一份逻辑 —— 同一份物理、同一份 bot。
 *
 * 已知简化（与 scripts/simulate.mjs 历史行为一致）：
 *  - 移动平台 M / m 按“停在中心位置”的静态实体处理（关卡设计上它们是可选路线）。
 *  - bot 会尝试“走路 / 短跳 / 中跳 / 满跳”几种策略，选落点最靠前且安全的那个，
 *    并在空中下落时自动补二段跳（救援）；撞墙时用蹬墙跳。
 */

import { PLAYER, TILE } from './config.ts';
import { Platformer } from './platformer.ts';
import type { FrameInput, Rect } from './platformer.ts';

export interface SimulateResult {
  reached: boolean;
  deaths: number;
  maxX: number;
  trace: number[];
  reason?: string;
  spawnEmbedded: boolean;
}

const DT = 1 / 60;

interface World {
  W: number;
  H: number;
  at: (x: number, y: number) => string;
  isSolid: (r: Rect) => boolean;
  oneWayTop: (r: Rect) => number | null;
  hazardAt: (r: Rect) => boolean;
  bounceAt: (r: Rect) => boolean;
  exits: { x: number; y: number }[];
}

function buildWorld(rows: string[]): World {
  const H = rows.length;
  const W = Math.max(0, ...rows.map((r) => r.length));
  const at = (x: number, y: number): string =>
    y >= 0 && y < H ? (rows[y][x] ?? '.') : x < 0 ? '#' : '.';

  // 静态实心格（把移动平台当作停在中心的静态实体）
  const solidExtra: Rect[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      if (c === 'M' || c === 'm') {
        const w = TILE * 2.5;
        const h = 10;
        solidExtra.push({ x: x * TILE + TILE / 2 - w / 2, y: y * TILE + TILE / 2 - h / 2, w, h });
      }
    }
  }

  const hits = (r: Rect, test: (c: string, x: number, y: number) => boolean) => {
    const x0 = Math.floor(r.x / TILE);
    const y0 = Math.floor(r.y / TILE);
    const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
    const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (test(at(x, y), x, y)) return true;
    return false;
  };

  const exits: { x: number; y: number }[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (at(x, y) === 'E') exits.push({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 });
    }
  }

  return {
    W,
    H,
    at,
    isSolid: (r) => {
      if (hits(r, (c) => c === '#')) return true;
      for (const m of solidExtra)
        if (r.x < m.x + m.w && r.x + r.w > m.x && r.y < m.y + m.h && r.y + r.h > m.y) return true;
      return false;
    },
    oneWayTop: (r) => {
      const x0 = Math.floor(r.x / TILE);
      const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
      const y0 = Math.floor(r.y / TILE);
      const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
      let top: number | null = null;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          if (at(x, y) === '=') {
            const t = y * TILE;
            if (top === null || t < top) top = t;
          }
      return top;
    },
    hazardAt: (r) => hits(r, (c) => c === '^' || c === '~'),
    bounceAt: (r) => hits(r, (c) => c === 'B'),
    exits,
  };
}

// ---------- 角色：直接用真实 Platformer ----------

function clonePlayer(p: Platformer): Platformer {
  const c = Object.create(Platformer.prototype) as Platformer;
  return Object.assign(c, p, { body: { ...p.body } });
}

function stepPlayer(p: Platformer, input: FrameInput, world: World) {
  p.step(input, DT, world);
  const b = p.body;
  // 危险 / 弹跳（与 GameScene.checkHazards 一致的口径）
  if (world.bounceAt({ x: b.x, y: b.y + b.h - 8, w: b.w, h: 8 }) && b.vy >= 0) {
    b.vy = -620;
    b.onGround = false;
  }
  if (world.hazardAt(b)) p.state = 'dead';
  if (b.y > world.H * TILE + 80) p.state = 'dead';
}

const isDead = (p: Platformer) => p.state === 'dead';

// ---------- bot：像人类一样“按需起跳”，优先最保守的可行策略 ----------

/** 正在往坑里掉、且还有二段跳 → 补一次空中跳救场 */
function wantRescue(p: Platformer, world: World) {
  const b = p.body;
  if (b.onGround || b.vy <= 0 || p.remainingAirJumps <= 0) return false;
  const below: Rect = { x: b.x, y: b.y + b.h + 2, w: b.w, h: 40 };
  return !world.isSolid(below) || world.hazardAt(below);
}

/** 生成第 f 帧的输入 */
function drive(p: Platformer, world: World, plan: Plan, f: number): FrameInput {
  const rescue = f > 2 && wantRescue(p, world);
  return {
    left: false,
    right: true,
    jumpHeld: rescue || f * DT < plan.hold,
    jumpPressed: rescue || (plan.hold > 0 && f === 0),
    dashPressed: !!plan.dash && f === 0,
    down: false,
  };
}

interface Plan {
  hold: number;
  dash: boolean;
}

function lookahead(start: Platformer, world: World, plan: Plan, frames = 110) {
  const c = clonePlayer(start);
  for (let f = 0; f < frames; f++) {
    stepPlayer(c, drive(c, world, plan, f), world);
    if (isDead(c)) return { safe: false, x: c.body.x, landed: false };
    if (c.body.onGround && f > 3) return { safe: !world.hazardAt(c.body), x: c.body.x, landed: true };
  }
  return { safe: false, x: c.body.x, landed: false };
}

// 候选策略：按住跳跃键的时长 × 是否冲刺（hold=0 表示直接走下去）
const PLANS: Plan[] = [];
for (const hold of [0, 0.08, 0.16, 0.26, 0.5]) {
  PLANS.push({ hold, dash: false });
  if (hold > 0) PLANS.push({ hold, dash: true });
}

function runBot(world: World, spawn: { x: number; y: number }) {
  const p = new Platformer(0, 0);
  p.respawn(spawn.x, spawn.y);

  let maxX = p.body.x;
  let deaths = 0;
  let reached = false;
  const trace: number[] = [];

  // 与 GameScene.checkExit 一致的传送门判定（触发框 12×30，中心偏移 -6,-20）
  const touchExit = () => {
    const b = p.body;
    for (const e of world.exits) {
      if (b.x < e.x + 6 && b.x + b.w > e.x - 6 && b.y < e.y + 10 && b.y + b.h > e.y - 10) return true;
    }
    return false;
  };

  for (let iter = 0; iter < 300 && !reached; iter++) {
    // 决策：在所有“安全且能推进”的策略里挑落点最靠前的那（最保守）
    const results = PLANS.map((plan) => ({ plan, r: lookahead(p, world, plan) }));
    const safe = results.filter((v) => v.r.safe && v.r.landed);
    const progress = safe.filter((v) => v.r.x > p.body.x + 2);
    let chosen: Plan | null = null;
    if (progress.length) chosen = progress.reduce((a, b) => (a.r.x <= b.r.x ? a : b)).plan;
    else if (safe.length) chosen = safe.reduce((a, b) => (a.r.x >= b.r.x ? a : b)).plan;

    if (!chosen) {
      // 所有策略都会死：只能硬走（撞墙时蹬墙跳），看能不能摸到活路
      let hitWall = false;
      for (let f = 0; f < 90; f++) {
        const b = p.body;
        if (!b.onGround && b.onWall) hitWall = true;
        stepPlayer(
          p,
          { left: false, right: true, jumpHeld: false, jumpPressed: hitWall, dashPressed: false, down: false },
          world,
        );
        if (touchExit()) reached = true;
        if (reached || isDead(p)) break;
        if (b.x > maxX + 1) break;
      }
      if (reached) break;
      if (isDead(p)) {
        deaths++;
        return { reached: false, deaths, maxX, trace, reason: '所有策略都会死' };
      }
      maxX = Math.max(maxX, p.body.x);
      trace.push(Math.round(p.body.x));
      continue;
    }

    // 执行所选策略，直到落地
    for (let f = 0; f < 240; f++) {
      stepPlayer(p, drive(p, world, chosen, f), world);
      if (isDead(p)) break;
      if (touchExit()) {
        reached = true;
        break;
      }
      if (p.body.onGround && f > 3) break;
    }
    maxX = Math.max(maxX, p.body.x);
    trace.push(Math.round(p.body.x));
    if (isDead(p)) {
      deaths++;
      break;
    }
  }

  return { reached, deaths, maxX, trace };
}

/** 对逐行字符串网格做可通关性仿真（含出生点嵌入检查） */
export function simulateGrid(rows: string[]): SimulateResult {
  if (rows.length === 0 || rows.every((r) => r.length === 0)) {
    return { reached: false, deaths: 0, maxX: 0, trace: [], reason: '空地图', spawnEmbedded: false };
  }
  const world = buildWorld(rows);

  let sx = 1;
  let sy = 1;
  rows.forEach((r, y) =>
    [...r].forEach((c, x) => {
      if (c === 'S') {
        sx = x;
        sy = y;
      }
    }),
  );
  // 与 src/core/map-format.ts 的 standPos 一致：脚底贴该格底面
  const spawn = { x: sx * TILE + TILE / 2, y: (sy + 1) * TILE - PLAYER.height / 2 };

  const spawnRect: Rect = {
    x: spawn.x - PLAYER.width / 2,
    y: spawn.y - PLAYER.height / 2,
    w: PLAYER.width,
    h: PLAYER.height,
  };
  if (world.isSolid(spawnRect)) {
    return { reached: false, deaths: 0, maxX: 0, trace: [], reason: '出生点嵌在方块里', spawnEmbedded: true };
  }

  const r = runBot(world, spawn);
  return { ...r, spawnEmbedded: false };
}
