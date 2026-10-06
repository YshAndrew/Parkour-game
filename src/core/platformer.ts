/**
 * 平台跳跃手感核心 —— 纯逻辑、与渲染解耦，便于单元测试。
 *
 * 使用方式：每帧调用 `step(input, dt, world)`，内部维护 coyote / buffer / dash / wall 状态机。
 */

import { PLAYER, GRAVITY, MAX_FALL } from './config.ts';
import { TILE } from './config.ts';

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

const AIR_JUMPS = PLAYER.doubleJump ? 1 : 0;

export class Platformer {
  body: Body;
  state: PlayerState = 'idle';
  facing: 1 | -1 = 1;

  private coyote = 0;
  private jumpBuf = 0;
  private airJumpsLeft = AIR_JUMPS;
  private dashTimer = 0;
  private dashCooldown = 0;
  private dashDir: 1 | -1 = 1;
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

  respawn(x: number, y: number) {
    this.body.x = x - this.body.w / 2;
    this.body.y = y - this.body.h / 2;
    this.body.vx = 0;
    this.body.vy = 0;
    this.state = 'idle';
    this.coyote = 0;
    this.jumpBuf = 0;
    this.dashTimer = 0;
    this.airJumpsLeft = AIR_JUMPS;
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
    this.dashCooldown -= dt;

    if (input.jumpPressed) this.jumpBuf = PLAYER.jumpBuffer;
    if (input.dashPressed && this.dashCooldown <= 0 && this.dashTimer <= 0) {
      this.startDash(input);
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
      this.airJumpsLeft = AIR_JUMPS;
      this.state = Math.abs(b.vx) > 10 ? 'run' : 'idle';
    } else if (b.onWall) {
      this.state = 'wall-slide';
      this.airJumpsLeft = Math.max(this.airJumpsLeft, 1);
    } else {
      this.state = 'air';
    }
  }

  private startDash(input: FrameInput) {
    let dx = 0;
    if (input.left) dx = -1;
    if (input.right) dx = 1;
    this.dashDir = (dx || this.facing) as 1 | -1;
    this.dashTimer = PLAYER.dashTime;
    this.dashCooldown = PLAYER.dashCooldown + PLAYER.dashTime;
    this.body.vx = this.dashDir * PLAYER.dashSpeed;
    this.body.vy = 0;
    this.state = 'dash';
  }

  private stepDash(dt: number, world: World) {
    const b = this.body;
    this.dashTimer -= dt;
    b.vy = 0;
    b.vx = this.dashDir * PLAYER.dashSpeed;
    this.moveAndCollide(dt, world);
    if (this.dashTimer <= 0) {
      b.vx = this.dashDir * PLAYER.maxRunSpeed * 0.9;
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

  /** 剩余空中跳（二段跳）次数；仿真 bot 判断是否需要救援时使用 */
  get remainingAirJumps() {
    return this.airJumpsLeft;
  }
}
