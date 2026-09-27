/**
 * 按键映射
 */

export const KEYMAP = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  down: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'ArrowUp', 'KeyW'],
  dash: ['ShiftLeft', 'ShiftRight', 'KeyZ'],
  pause: ['Escape'],
  restart: ['KeyR'],
} as const;

export type Action = keyof typeof KEYMAP;

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
