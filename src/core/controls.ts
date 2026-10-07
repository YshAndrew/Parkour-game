/**
 * 按键映射（Celeste 式，可重绑）
 *
 * 模型：每个动作 = [主键, ...固定备用键]
 *  - 主键（[0]）可重绑并持久化到 Settings.keymap
 *  - 备用键（[1..]）为固定双套（方向键 + WASD），不可重绑
 *  - 重绑后调用 refreshKeymap() 使运行时 KEYMAP 立即生效
 */

import { Settings } from './settings.ts';

export const DEFAULT_KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  jump: ['KeyC'],
  dash: ['KeyX'],
  pause: ['Escape'],
  restart: ['KeyR'],
} as const;

export type Action = keyof typeof DEFAULT_KEYS;

function buildKeymap(): Record<Action, string[]> {
  const km = {} as Record<Action, string[]>;
  for (const action of Object.keys(DEFAULT_KEYS) as Action[]) {
    const stored = Settings.data.keymap[action];
    const primary =
      typeof stored === 'string' && stored.length > 0 ? stored : DEFAULT_KEYS[action][0];
    km[action] = [...new Set([primary, ...DEFAULT_KEYS[action].slice(1)])];
  }
  return km;
}

/** 运行时键位表（可变；重绑后需调用 refreshKeymap 重建） */
export const KEYMAP: Record<Action, string[]> = buildKeymap();

export function refreshKeymap() {
  const built = buildKeymap();
  for (const action of Object.keys(built) as Action[]) {
    KEYMAP[action] = built[action];
  }
}

export function actionFor(code: string): Action | null {
  for (const [action, codes] of Object.entries(KEYMAP)) {
    if ((codes as readonly string[]).includes(code)) return action as Action;
  }
  return null;
}

export class Input {
  pressed = new Set<string>();
  justPressed = new Set<string>();

  down(action: Action) {
    return KEYMAP[action].some((k) => this.pressed.has(k));
  }

  just(action: Action) {
    return KEYMAP[action].some((k) => this.justPressed.has(k));
  }

  clearJust() {
    this.justPressed.clear();
  }

  handleDown(e: KeyboardEvent) {
    if (!this.pressed.has(e.code)) this.justPressed.add(e.code);
    this.pressed.add(e.code);
  }

  handleUp(e: KeyboardEvent) {
    this.pressed.delete(e.code);
  }
}
