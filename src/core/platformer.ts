/**
 * 平台跳跃手感核心 —— 纯逻辑、与渲染解耦，便于单元测试。
 *
 * 使用方式：每帧调用 `step(input, dt, world)`，内部维护 coyote / buffer / dash / wall 状态机。
 *
 * 冲刺（Celeste 式）：
 *  - 8 向方向键制：按方向键决定冲刺方向（对角归一化），无方向则沿 facing 水平冲
 *  - 充能制：默认每段滞空 1 次冲刺，触地 / 触墙恢复；设置开"二段冲刺"则为 2 次
 *  - 下冲触地 = 超级冲刺（沿 facing 向前弹射）
 *  - 二段跳由设置开关（默认关）
 */

import { PLAYER, GRAVITY, MAX_FALL } from './config.ts';
import { TILE } from './config.ts';
import { Settings } from './settings.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Body extends Rect {
  vx: number;
  vy: number;
  onGround: boolean;
  onWall: boolean;
  wallDir: number; // -1 左墙 1 右墙
  dropping: boolean; // 正在下穿单向平台
}

export interface FrameInput {
  left: boolean;
  right: boolean;
  up: boolean;
  jumpHeld: boolean;
  jumpPressed: boolean;
  dashPressed: boolean;
  down: boolean;
}

export interface World {
  /** 实心碰撞（含移动平台） */
  isSolid: (r: Rect) => boolean;
  /** 与矩形重叠的单向平台顶面 y 坐标，无则 null */
  oneWayTop: (r: Rect) => number | null;
}

export type PlayerState = 'idle' | 'run' | 'air' | 'wall-slide' | 'dash' | 'dead' | 'win';

export class Platformer {
  body: Body;
  state: PlayerState = 'idle';
  facing: 1 | -1 = 1;

  private coyote = 0;
  private jumpBuf = 0;
  private airJumpsLeft = 0;
  private dashCharges = 1;
  private dashTimer = 0;
  private dashDX = 0; // 归一化冲刺方向
  private dashDY = 0;
  private justLanded = false;
  private justWallJumped = false;
  private justJumped = false;

  constructor(x: number, y: number) {
    this.body = {
      x,
      y,
      w: PLAYER.width,
      h: PLAYER.height,
      vx: 0,
      vy: 0,
      onGround: false,
      onWall: false,
      wallDir: 0,
      dropping: false,
    };
  }

  /** 二段跳次数（设置开关，默认关） */
  private get maxAirJumps() {
    return Settings.data.doubleJump ? 1 : 0;
  }
  /** 冲刺充能上限（设置开关"二段冲刺"，默认 1 次/段滞空） */
  private get maxDashCharges() {
    return Settings.data.doubleDash ? 2 : 1;
  }

  respawn(x: number, y: number) {
    this.body.x = x - this.body.w / 2;
    this.body.y = y - this.body.h / 2;
    this.body.vx = 0;
    this.body.vy = 0;
    this.state = 'idle';
    this.coyote = 0;
    this.jumpBuf = 0;
    this.dashTimer = 0;
    this.airJumpsLeft = this.maxAirJumps;
    this.dashCharges = this.maxDashCharges;
  }

  get cx() {
    return this.body.x + this.body.w / 2;
  }
  get cy() {
    return this.body.y + this.body.h / 2;
  }

  step(input: FrameInput, dt: number, world: World) {
    const b = this.body;
    this.justLanded = false;
    this.justWallJumped = false;
    this.justJumped = false;

    if (this.state === 'dead' || this.state === 'win') {
      b.vx = 0;
      return;
    }

    this.coyote -= dt;
    this.jumpBuf -= dt;
    this.dashTimer -= dt;

    // 冲刺充能恢复：触地 / 触墙（Celeste 式）
    if (b.onGround || b.onWall) this.dashCharges = this.maxDashCharges;

    if (input.jumpPressed) this.jumpBuf = PLAYER.jumpBuffer;
    if (input.dashPressed && this.dashCharges > 0 && this.dashTimer <= 0) {
      this.startDash(input);
      this.dashCharges--;
    }

    if (this.dashTimer > 0) {
      this.stepDash(dt, world);
      return;
    }

    // ---------- 水平 ----------
    const accel = b.onGround ? PLAYER.runAccel : PLAYER.runAccel * PLAYER.airAccelMult;
    const decel = b.onGround ? PLAYER.runDecel : PLAYER.runDecel * PLAYER.airDecelMult;

    if (input.left && !input.right) {
      b.vx = Math.max(b.vx - accel * dt, -PLAYER.maxRunSpeed);
      this.facing = -1;
    } else if (input.right && !input.left) {
      b.vx = Math.min(b.vx + accel * dt, PLAYER.maxRunSpeed);
      this.facing = 1;
    } else {
      const d = decel * dt;
      b.vx = Math.abs(b.vx) <= d ? 0 : b.vx - Math.sign(b.vx) * d;
    }

    // ---------- 跳跃 ----------
    const canGroundJump = b.onGround || this.coyote > 0;
    const canWallJump = !b.onGround && b.onWall;

    // 下 + 跳：下穿单向平台（只有脚下不是实心地面时才生效，避免消费掉实心地上的跳跃）
    const standingOnSolid = world.isSolid({ x: b.x, y: b.y + b.h, w: b.w, h: 2 });
    if (this.jumpBuf > 0 && input.down && b.onGround && !standingOnSolid) {
      this.jumpBuf = 0;
      b.dropping = true;
      b.y += 2;
      b.onGround = false;
    } else if (this.jumpBuf > 0 && (canGroundJump || canWallJump || this.airJumpsLeft > 0)) {
      this.jumpBuf = 0;
      if (canWallJump) {
        b.vx = -b.wallDir * PLAYER.wallJumpHSpeed;
        b.vy = PLAYER.wallJumpVSpeed;
        this.facing = b.wallDir === 1 ? -1 : 1;
        this.justWallJumped = true;
      } else {
        b.vy = PLAYER.jumpSpeed * (canGroundJump ? 1 : 0.94);
        if (!canGroundJump) this.airJumpsLeft--;
        this.justJumped = true;
      }
      b.onGround = false;
      this.coyote = 0;
    }

    // 松开跳跃键 → 截断上升（可变跳高）
    if (!input.jumpHeld && b.vy < 0) b.vy *= 0.92;

    // ---------- 重力 ----------
    b.vy = Math.min(b.vy + GRAVITY * dt, MAX_FALL);

    // 贴墙下滑减速
    if (b.onWall && !b.onGround && b.vy > PLAYER.wallSlideSpeed) {
      b.vy = Math.max(b.vy - GRAVITY * 2.2 * dt, PLAYER.wallSlideSpeed);
    }

    // ---------- 位移与碰撞 ----------
    this.moveAndCollide(dt, world);

    // ---------- 状态 ----------
    if (b.onGround) {
      this.coyote = PLAYER.coyoteTime;
      this.airJumpsLeft = this.maxAirJumps;
      this.state = Math.abs(b.vx) > 10 ? 'run' : 'idle';
    } else if (b.onWall) {
      this.state = 'wall-slide';
    } else {
      this.state = 'air';
    }
  }

  /** 方向键制冲刺：读取按住的方向键决定方向；无方向则沿 facing 水平冲 */
  private startDash(input: FrameInput) {
    let dx = 0;
    let dy = 0;
    if (input.left) dx -= 1;
    if (input.right) dx += 1;
    if (input.up) dy -= 1;
    if (input.down) dy += 1;
    if (dx === 0 && dy === 0) dx = this.facing; // 无方向 → 朝向

    const len = Math.hypot(dx, dy);
    this.dashDX = dx / len;
    this.dashDY = dy / len;
    this.dashTimer = PLAYER.dashTime;
    this.body.vx = this.dashDX * PLAYER.dashSpeed;
    this.body.vy = this.dashDY * PLAYER.dashSpeed;
    this.state = 'dash';
  }

  private stepDash(dt: number, world: World) {
    const b = this.body;
    this.dashTimer -= dt;
    b.vx = this.dashDX * PLAYER.dashSpeed;
    b.vy = this.dashDY * PLAYER.dashSpeed;
    this.moveAndCollide(dt, world);

    // 下冲触地 → 超级冲刺（结束冲刺并沿 facing 向前弹射）
    if (this.dashDY > 0 && b.onGround) {
      b.vx = this.facing * PLAYER.maxRunSpeed * PLAYER.superdashMult;
      b.vy = 0;
      this.dashTimer = 0;
      this.state = b.onGround ? 'run' : 'air';
      return;
    }

    if (this.dashTimer <= 0) {
      if (this.dashDY === 0) {
        // 水平冲刺：沿用原收尾（保留水平动量）
        b.vx = this.dashDX * PLAYER.maxRunSpeed * 0.9;
        b.vy = 0;
      } else {
        // 上/下/斜向：保留部分冲刺速度（上冲有小跳、下冲快速下坠）
        b.vx = this.dashDX * PLAYER.dashSpeed * PLAYER.dashEndKeep;
        b.vy = this.dashDY * PLAYER.dashSpeed * PLAYER.dashEndKeep;
      }
      this.state = 'air';
    }
  }

  /** AABB：先水平后垂直，撞实心则贴边停下；单向平台只在下落时落脚 */
  private moveAndCollide(dt: number, world: World) {
    const b = this.body;
    b.onWall = false;
    b.wallDir = 0;

    // 移动前就已嵌入地形？（例如出生点偏移、被移动平台推入墙体）
    // 这种情况必须交给 Y 轴向上解卡，绝不能在 X 轴上把角色横向挤飞。
    const wasStuck = world.isSolid(b);

    // X（b.onGround 此刻仍是上帧值，用于判断是否允许贴墙）
    b.x += b.vx * dt;
    if (!wasStuck && world.isSolid(b)) {
      const dir = Math.sign(b.vx) || 1;
      while (world.isSolid(b)) b.x -= dir * 0.5;
      b.vx = 0;
      if (!b.onGround) {
        b.onWall = true;
        b.wallDir = dir;
      }
    }

    // Y
    const prevBottom = b.y + b.h;
    const wasGround = b.onGround;
    b.onGround = false;
    b.y += b.vy * dt;

    if (wasStuck && world.isSolid(b)) {
      // 向上解卡：最多抬升 3 格，避免卡在方块里
      let guard = 0;
      while (world.isSolid(b) && guard++ < 3 * TILE) b.y -= 1;
      b.vy = 0;
      b.onGround = true;
      if (!wasGround) this.justLanded = true;
    } else if (world.isSolid(b)) {
      const dir = Math.sign(b.vy) || 1;
      while (world.isSolid(b)) b.y -= dir * 0.5;
      if (dir > 0) {
        b.onGround = true;
        if (!wasGround) this.justLanded = true;
      }
      b.vy = 0;
      b.dropping = false;
    } else if (b.vy >= 0) {
      if (b.dropping) {
        if (world.oneWayTop(b) === null) b.dropping = false;
      } else {
        const top = world.oneWayTop(b);
        if (top !== null && prevBottom <= top + 2) {
          b.y = top - b.h;
          b.vy = 0;
          b.onGround = true;
          if (!wasGround) this.justLanded = true;
        }
      }
    }
  }

  consumeLanded() {
    const v = this.justLanded;
    this.justLanded = false;
    return v;
  }
  consumeWallJumped() {
    const v = this.justWallJumped;
    this.justWallJumped = false;
    return v;
  }
  consumeJumped() {
    const v = this.justJumped;
    this.justJumped = false;
    return v;
  }

  get tileX() {
    return Math.floor(this.cx / TILE);
  }
  get tileY() {
    return Math.floor(this.cy / TILE);
  }
}
