/**
 * 关卡可通关性校验（无头物理仿真）
 * =================================
 * 在 Node 里复刻 src/core/platformer.ts 的物理规则，用一个“带前瞻规划的 bot”
 * 实际跑一遍每张地图，确认它能在不死亡的情况下触达终点传送门 E。
 *
 * 为什么要做这个：ASCII 地图很容易画出“看着能过、实际跳不过去”的断层。
 * 这个脚本能在加地图后立刻告诉你那张图是否可通关。
 *
 * 用法：node scripts/simulate.mjs
 *
 * 说明 / 已知简化：
 *  - 移动平台 M / m 按“停在中心位置”的静态实体处理（关卡设计上它们是可选路线）。
 *  - bot 会尝试“走路 / 短跳 / 中跳 / 满跳”几种策略，选落点最靠前且安全的那个，
 *    并在空中下落时自动补二段跳；撞墙时用蹬墙跳。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 与 src/core/config.ts 保持一致 ----------
const TILE = 16;
const P = { w: 10, h: 18, maxRunSpeed: 210, jumpSpeed: -395, wallJumpH: 220, wallJumpV: -380 };
const GRAVITY = 1600;
const MAX_FALL = 720;
const DT = 1 / 60;
const COYOTE = 0.09;
const JUMP_BUFFER = 0.1;

const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/levels/maps');

// ---------- 地图读取 ----------
function loadRows(file) {
  const src = readFileSync(join(dir, file), 'utf8');
  const rows = [...src.match(/grid:\s*\[([\s\S]*?)\]/)[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const w = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => r.padEnd(w, '.'));
}

function buildWorld(rows) {
  const at = (x, y) => (y >= 0 && y < rows.length ? rows[y][x] ?? '.' : x < 0 ? '#' : '.');
  const H = rows.length;
  const W = Math.max(...rows.map((r) => r.length));

  // 静态实心格（把移动平台当作停在中心的静态实体）
  const solidExtra = [];
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

  const hits = (r, test) => {
    const x0 = Math.floor(r.x / TILE);
    const y0 = Math.floor(r.y / TILE);
    const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
    const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (test(at(x, y), x, y)) return true;
    return false;
  };

  return {
    rows,
    W,
    H,
    at,
    isSolid: (r) => {
      if (hits(r, (c) => c === '#')) return true;
      for (const m of solidExtra) if (r.x < m.x + m.w && r.x + r.w > m.x && r.y < m.y + m.h && r.y + r.h > m.y) return true;
      return false;
    },
    oneWayTop: (r) => {
      const x0 = Math.floor(r.x / TILE);
      const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
      const y0 = Math.floor(r.y / TILE);
      const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
      let top = null;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          if (at(x, y) === '=') {
            const t = y * TILE;
            if (top === null || t < top) top = t;
          }
      return top;
    },
    // 危险区（与 GameScene.checkHazards 一致）
    hazardAt: (r) => {
      const x0 = Math.floor(r.x / TILE);
      const y0 = Math.floor(r.y / TILE);
      const x1 = Math.floor((r.x + r.w - 0.01) / TILE);
      const y1 = Math.floor((r.y + r.h - 0.01) / TILE);
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          if (at(x, y) === '^' || at(x, y) === '~') return true;
      return false;
    },
    bounceAt: (r) => hits(r, (c) => c === 'B'),
  };
}

// ---------- 角色状态机（与 platformer.ts 同规则） ----------
function newState(x, y) {
  return {
    b: { x, y, w: P.w, h: P.h, vx: 0, vy: 0, onGround: false, onWall: false, wallDir: 0, dropping: false },
    coyote: 0,
    jumpBuf: 0,
    airJumps: 1,
    dash: 0,
    dashCd: 0,
    dashDir: 1,
    dead: false,
  };
}

const clone = (s) => ({ ...s, b: { ...s.b } });

function move(s, world) {
  const b = s.b;
  b.onWall = false;
  b.wallDir = 0;
  const wasStuck = world.isSolid(b);

  b.x += b.vx * DT;
  if (!wasStuck && world.isSolid(b)) {
    const d = Math.sign(b.vx) || 1;
    while (world.isSolid(b)) b.x -= d * 0.5;
    b.vx = 0;
    if (!b.onGround) {
      b.onWall = true;
      b.wallDir = d;
    }
  }

  const prevBottom = b.y + b.h;
  const wasGround = b.onGround;
  b.onGround = false;
  b.y += b.vy * DT;

  if (wasStuck && world.isSolid(b)) {
    let g = 0;
    while (world.isSolid(b) && g++ < 3 * TILE) b.y -= 1;
    b.vy = 0;
    b.onGround = true;
  } else if (world.isSolid(b)) {
    const d = Math.sign(b.vy) || 1;
    while (world.isSolid(b)) b.y -= d * 0.5;
    if (d > 0) b.onGround = true;
    b.vy = 0;
    b.dropping = false;
  } else if (b.vy >= 0) {
    const top = world.oneWayTop(b);
    if (top !== null && prevBottom <= top + 2) {
      b.y = top - b.h;
      b.vy = 0;
      b.onGround = true;
    }
  }
  void wasGround;
}

function step(s, input, world) {
  const b = s.b;
  if (s.dead) return;

  s.coyote -= DT;
  s.jumpBuf -= DT;
  s.dashCd -= DT;
  if (input.jumpPressed) s.jumpBuf = JUMP_BUFFER;
  if (input.dashPressed && s.dashCd <= 0 && s.dash <= 0) {
    s.dash = 0.14;
    s.dashCd = 0.54;
    s.dashDir = input.left ? -1 : 1;
    b.vx = s.dashDir * 420;
    b.vy = 0;
  }

  if (s.dash > 0) {
    s.dash -= DT;
    b.vy = 0;
    b.vx = s.dashDir * 420;
    move(s, world);
    return;
  }

  const accel = b.onGround ? 2400 : 2040;
  const decel = b.onGround ? 2600 : 1170;
  if (input.left && !input.right) b.vx = Math.max(b.vx - accel * DT, -P.maxRunSpeed);
  else if (input.right && !input.left) b.vx = Math.min(b.vx + accel * DT, P.maxRunSpeed);
  else {
    const d = decel * DT;
    b.vx = Math.abs(b.vx) <= d ? 0 : b.vx - Math.sign(b.vx) * d;
  }

  const canGround = b.onGround || s.coyote > 0;
  const canWall = !b.onGround && b.onWall;
  if (s.jumpBuf > 0 && (canGround || canWall || s.airJumps > 0)) {
    s.jumpBuf = 0;
    if (canWall) {
      b.vx = -b.wallDir * P.wallJumpH;
      b.vy = P.wallJumpV;
    } else {
      b.vy = canGround ? P.jumpSpeed : P.jumpSpeed * 0.94;
      if (!canGround) s.airJumps--;
    }
    b.onGround = false;
    s.coyote = 0;
  }

  if (!input.jumpHeld && b.vy < 0) b.vy *= 0.92;
  b.vy = Math.min(b.vy + GRAVITY * DT, MAX_FALL);
  if (b.onWall && !b.onGround && b.vy > 120) b.vy = Math.max(b.vy - GRAVITY * 2.2 * DT, 120);

  move(s, world);

  if (b.onGround) {
    s.coyote = COYOTE;
    s.airJumps = 1;
  } else if (b.onWall) {
    s.airJumps = Math.max(s.airJumps, 1);
  }

  // 危险 / 弹跳 / 加速带
  const b1 = s.b;
  if (world.bounceAt({ x: b1.x, y: b1.y + b1.h - 8, w: b1.w, h: 8 }) && b1.vy >= 0) {
    b1.vy = -620;
    b1.onGround = false;
  }
  if (world.hazardAt(b1)) s.dead = true;
  if (b1.y > world.H * TILE + 80) s.dead = true;
}

// ---------- bot：像人类一样“按需起跳”，优先最保守的可行策略 ----------

/** 正在往坑里掉、且还有二段跳 → 补一次空中跳救场 */
function wantRescue(s, world) {
  const b = s.b;
  if (b.onGround || b.vy <= 0 || s.airJumps <= 0) return false;
  const below = { x: b.x, y: b.y + b.h + 2, w: b.w, h: 40 };
  return !world.isSolid(below) || world.hazardAt(below);
}

/** 生成第 f 帧的输入 */
function drive(s, world, plan, f) {
  const rescue = f > 2 && wantRescue(s, world);
  return {
    left: false,
    right: true,
    jumpHeld: rescue || f * DT < plan.hold,
    jumpPressed: rescue || (plan.hold > 0 && f === 0),
    dashPressed: !!plan.dash && f === 0,
    down: false,
  };
}

function lookahead(start, world, plan, frames = 110) {
  const c = clone(start);
  for (let f = 0; f < frames; f++) {
    step(c, drive(c, world, plan, f), world);
    if (c.dead) return { safe: false, x: c.b.x, landed: false };
    if (c.b.onGround && f > 3) return { safe: !world.hazardAt(c.b), x: c.b.x, landed: true };
  }
  return { safe: false, x: c.b.x, landed: false };
}

// 候选策略：按住跳跃键的时长 × 是否冲刺（hold=0 表示直接走下去）
const PLANS = [];
for (const hold of [0, 0.08, 0.16, 0.26, 0.5]) {
  PLANS.push({ hold, dash: false });
  if (hold > 0) PLANS.push({ hold, dash: true });
}

function runBot(world, spawn) {
  const s = newState(spawn.x - P.w / 2, spawn.y - P.h / 2);
  const exits = [];
  for (let y = 0; y < world.H; y++)
    for (let x = 0; x < world.W; x++)
      if (world.at(x, y) === 'E') exits.push({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 });

  let maxX = s.b.x;
  let deaths = 0;
  let reached = false;
  const trace = [];

  // 与 GameScene.checkExit 一致的传送门判定
  const touchExit = () => {
    for (const e of exits) {
      if (s.b.x < e.x + 6 && s.b.x + s.b.w > e.x - 6 && s.b.y < e.y + 10 && s.b.y + s.b.h > e.y - 10) return true;
    }
    return false;
  };

  for (let iter = 0; iter < 300 && !reached; iter++) {
    // 决策：在所有“安全且能推进”的策略里挑落点最靠前的那个（最保守）
    const results = PLANS.map((p) => ({ p, r: lookahead(s, world, p) }));
    const safe = results.filter((v) => v.r.safe && v.r.landed);
    const progress = safe.filter((v) => v.r.x > s.b.x + 2);
    let chosen = null;
    if (progress.length) chosen = progress.reduce((a, b) => (a.r.x <= b.r.x ? a : b)).p;
    else if (safe.length) chosen = safe.reduce((a, b) => (a.r.x >= b.r.x ? a : b)).p;

    if (!chosen) {
      // 所有策略都会死：只能硬走（撞墙时蹬墙跳），看能不能摸到活路
      let hitWall = false;
      for (let f = 0; f < 90; f++) {
        const b = s.b;
        if (!b.onGround && b.onWall) hitWall = true;
        step(s, { left: false, right: true, jumpHeld: false, jumpPressed: hitWall, down: false }, world);
        if (touchExit()) reached = true;
        if (reached || s.dead) break;
        if (b.x > maxX + 1) break;
      }
      if (reached) break;
      if (s.dead) {
        deaths++;
        return { reached: false, deaths, maxX, trace, reason: '所有策略都会死' };
      }
      maxX = Math.max(maxX, s.b.x);
      trace.push(Math.round(s.b.x));
      continue;
    }

    // 执行所选策略，直到落地
    for (let f = 0; f < 240; f++) {
      step(s, drive(s, world, chosen, f), world);
      if (s.dead) break;
      if (touchExit()) {
        reached = true;
        break;
      }
      if (s.b.onGround && f > 3) break;
    }
    maxX = Math.max(maxX, s.b.x);
    trace.push(Math.round(s.b.x));
    if (s.dead) {
      deaths++;
      break;
    }
  }

  return { reached, deaths, maxX, trace };
}

// ---------- 主流程 ----------
let failed = false;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
  const rows = loadRows(file);
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
  const spawn = { x: sx * TILE + TILE / 2, y: (sy + 1) * TILE - P.h / 2 };

  if (world.isSolid({ x: spawn.x - P.w / 2, y: spawn.y - P.h / 2, w: P.w, h: P.h })) {
    console.log(`✗ ${file}  出生点嵌在方块里`);
    failed = true;
    continue;
  }

  const r = runBot(world, spawn);
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