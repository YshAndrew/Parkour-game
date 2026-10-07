/**
 * 关卡可通关性仿真（无头物理校验）
 * =================================
 * 直接驱动真实的 Platformer 物理类，用“带前瞻规划的 bot”实际跑一遍网格，
 * 确认它能零死亡触达终点传送门 E。编辑器“可通关性检查”与
 * scripts/simulate.mjs 共用这一份逻辑 —— 同一份物理、同一份 bot。
 *
 * 已知简化（与 scripts/simulate.mjs 历史行为一致）：
 *  - 移动平台 M / m 不参与仿真（设计上它们是可选路线，按静态实体处理会误伤
 *    “实际上可通关”的地图；参考 src/scenes/GameScene.ts 的可移动平台逻辑）。
 *  - bot 会尝试”走路 / 短跳 / 中跳 / 满跳 / 冲刺跳”几种策略，选落点最靠前且安全的那个，
 *    并在空中下落遇险时按方向键冲刺救场（二段跳默认关闭）；撞墙时用蹬墙跳。
 *  - bot 会像人类一样”看到前方尖刺提前满跳”，并拒绝落在”尖刺前 1~2 格”的决策死区
 *    （那是玩家能正常跳过去、但站在原地上跳必擦刺的位置）。
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
      return hits(r, (c) => c === '#');
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
    hazardAt: (r) => {
      // 与 GameScene.checkHazards 同口径：尖刺只取下方 8px、岩浆取下方 12px（避免整格误判）
      const x0 = Math.floor(r.x / TILE);
      const y0 = Math.floor(r.y / TILE);
      const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
      const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
      const overlap = (x: number, y: number, w: number, h: number) =>
        r.x < x + w && r.x + r.w > x && r.y < y + h && r.y + r.h > y;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const c = at(x, y);
          if (c === '^' && overlap(x * TILE + 2, y * TILE + 8, TILE - 4, TILE - 8)) return true;
          if (c === '~' && overlap(x * TILE, y * TILE + 4, TILE, TILE - 4)) return true;
        }
      }
      return false;
    },
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

/** 正在往致命危险（岩浆/尖刺）里掉、且还有冲刺充能 → 按方向键冲刺救场（替代原二段跳救场）。
 *  只对“下方 40px 内是危险”触发；普通坑/能落地的下坡不触发，
 *  否则会在跳跃本可落地的位置强行冲刺，把完好的抛物线毁掉（曾导致跳进岩浆）。 */
function wantRescue(p: Platformer, world: World) {
  const b = p.body;
  if (b.onGround || b.vy <= 0) return false;
  const below: Rect = { x: b.x, y: b.y + b.h + 2, w: b.w, h: 40 };
  return world.hazardAt(below);
}

/** 生成第 f 帧的输入 */
function drive(p: Platformer, world: World, plan: Plan, f: number): FrameInput {
  const rescue = f > 2 && wantRescue(p, world);
  return {
    left: false,
    right: true,
    up: false,
    jumpHeld: f * DT < plan.hold,
    jumpPressed: plan.hold > 0 && f === 0,
    dashPressed: rescue || (!!plan.dash && f === 0),
    down: false,
  };
}

interface Plan {
  hold: number;
  dash: boolean;
}

/**
 * 当前所在平台带上、身体右缘前方的下一个尖刺 hitbox 起点距离（px）。
 * 只在同一段连续平台带上扫描：遇到坑/台阶（脚下无实心）或挡路墙就停止。
 * 无尖刺返回 null。
 */
function spikeGapAhead(b: Rect, world: World): number | null {
  const feetRow = Math.floor((b.y + b.h - 1) / TILE);
  const bandRow = feetRow + 1;
  const startTile = Math.floor((b.x + b.w) / TILE);
  for (let x = startTile; x < world.W; x++) {
    const under = world.at(x, bandRow);
    if (under !== '#' && under !== '=') return null; // 平台带断：坑/台阶
    if (world.at(x, feetRow) === '^') return x * TILE + 2 - (b.x + b.w); // 尖刺 hitbox 起点
    if (world.at(x, feetRow) === '#') return null; // 墙挡路
  }
  return null;
}

function lookahead(start: Platformer, world: World, plan: Plan, frames = 110) {
  const c = clonePlayer(start);
  for (let f = 0; f < frames; f++) {
    stepPlayer(c, drive(c, world, plan, f), world);
    if (isDead(c)) return { safe: false, x: c.body.x, y: c.body.y, landed: false };
    if (c.body.onGround && f > 3) {
      // 决策死区：落在“尖刺前 1~2 格”时，站原地起跳必擦刺 —— 拒绝该落点
      const d = spikeGapAhead(c.body, world);
      if (d !== null && d < 6) return { safe: false, x: c.body.x, y: c.body.y, landed: false };
      return { safe: !world.hazardAt(c.body), x: c.body.x, y: c.body.y, landed: true };
    }
  }
  return { safe: false, x: c.body.x, y: c.body.y, landed: false };
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
    // 清掉上一次执行遗留的跳跃缓冲，防止“意外起跳”污染本次决策
    p.clearJumpBuffer();
    // 决策：在所有“安全且能推进”的策略里挑落点最靠前的那（最保守）
    const results = PLANS.map((plan) => ({ plan, r: lookahead(p, world, plan) }));
    const safe = results.filter((v) => v.r.safe && v.r.landed);
    const progress = safe.filter((v) => v.r.x > p.body.x + 2);
    let chosen: Plan | null = null;

    // 规则1（尖刺提前起跳）：同一段平台带前方 45px 内有尖刺 → 直接满跳（像人类一样看到就跳）
    const spikeGap = spikeGapAhead(p.body, world);
    if (spikeGap !== null && spikeGap >= 0 && spikeGap < 45) {
      const fullJump = results.find((v) => v.plan.hold === 0.5 && !v.plan.dash);
      if (fullJump && fullJump.r.safe && fullJump.r.landed) chosen = fullJump.plan;
    }
    // 规则2（出口就在前方）：别跳过头，走进去触发终点
    if (!chosen) {
      const exitNear = world.exits.some(
        (e) => e.x > p.body.x + p.body.w && e.x < p.body.x + p.body.w + 80,
      );
      if (exitNear) {
        const walk = results.find((v) => v.plan.hold === 0 && !v.plan.dash);
        if (walk && walk.r.safe && walk.r.landed && walk.r.x > p.body.x + 2) chosen = walk.plan;
      }
    }
    if (!chosen && progress.length) chosen = progress.reduce((a, b) => (a.r.x <= b.r.x ? a : b)).plan;
    if (!chosen && safe.length) chosen = safe.reduce((a, b) => (a.r.x >= b.r.x ? a : b)).plan;

    // 防死胡同：无论选中什么计划，若落点已无法再推进（尖刺前死区/坑前跳不上去/掉进宽坑），
    // 就改选落点能继续推进的最远跳跃，避免一步步走进绝路。
    // 落点在出口触发范围内视为“可推进”（走进出口即胜利）。
    if (chosen) {
      const chosenRes = results.find((v) => v.plan === chosen)!.r;
      const canProgressFrom = (pos: { x: number; y: number }) => {
        const probe = clonePlayer(p);
        probe.body.x = pos.x;
        probe.body.y = pos.y;
        probe.body.vy = 0;
        probe.body.onGround = true;
        probe.clearJumpBuffer();
        const atExit = world.exits.some(
          (e) =>
            probe.body.x < e.x + 6 &&
            probe.body.x + probe.body.w > e.x - 6 &&
            probe.body.y < e.y + 10 &&
            probe.body.y + probe.body.h > e.y - 10,
        );
        return (
          atExit ||
          PLANS.some((plan) => {
            const r = lookahead(probe, world, plan);
            return r.safe && r.landed && r.x > pos.x + 2;
          })
        );
      };
      if (!canProgressFrom(chosenRes)) {
        const alts = progress
          .filter((v) => !(v.plan.hold === 0 && !v.plan.dash))
          .sort((a, b) => b.r.x - a.r.x);
        chosen = null;
        for (const alt of alts) {
          if (canProgressFrom(alt.r)) {
            chosen = alt.plan;
            break;
          }
        }
      }
    }

    if (!chosen) {
      // 所有策略都会死：只能硬走（撞墙时蹬墙跳），看能不能摸到活路
      let hitWall = false;
      for (let f = 0; f < 90; f++) {
        const b = p.body;
        if (!b.onGround && b.onWall) hitWall = true;
        stepPlayer(
          p,
          { left: false, right: true, up: false, jumpHeld: false, jumpPressed: hitWall, dashPressed: false, down: false },
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
