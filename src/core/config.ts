/**
 * 全局常量与可调参数
 */

export const TILE = 16; // 像素瓦片大小（视觉）
export const GRAVITY = 1600;
export const MAX_FALL = 720;

export const PLAYER = {
  width: 10,
  height: 18,
  runAccel: 2400,
  runDecel: 2600,
  maxRunSpeed: 210,
  airAccelMult: 0.85,
  airDecelMult: 0.45,
  jumpSpeed: -395,
  wallJumpHSpeed: 220,
  wallJumpVSpeed: -380,
  coyoteTime: 0.09, // 秒
  jumpBuffer: 0.1, // 秒
  doubleJump: true,
  dashSpeed: 420,
  dashTime: 0.14,
  dashCooldown: 0.4,
  wallSlideSpeed: 120,
} as const;

export const CAMERA = {
  lerp: 0.08,
  ahead: 40,
  deadzoneX: 8,
  deadzoneY: 6,
} as const;

export const COLORS = {
  skyTop: '#0b0e17',
  skyBottom: '#1f2233',
  tileBody: '#3e3f4a',
  tileEdge: '#5c5d6e',
  playerBody: '#ffcd75',
  playerHat: '#ef7d8a',
  spike: '#c0392b',
  coin: '#ffd866',
  coinShine: '#fff6d5',
  portal: '#8ff0a4',
} as const;
