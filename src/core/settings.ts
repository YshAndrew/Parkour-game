/**
 * 玩家设置（与存档分离）：键位主键覆盖 + 难度开关
 *
 * - keymap: 仅存被改过的主键（action -> key code），其余用 controls 的默认值
 * - doubleJump / doubleDash: 难度开关，默认关（平衡取向）
 * - 浏览器 localStorage 持久化；Node（仿真/CLI）环境无 localStorage 时用默认值
 */

const KEY = 'pixel_parkour_settings_v1';

export interface SettingsData {
  keymap: Record<string, string>;
  doubleJump: boolean;
  doubleDash: boolean;
}

const DEFAULTS = (): SettingsData => ({
  keymap: {},
  doubleJump: false,
  doubleDash: false,
});

function read(): SettingsData {
  if (typeof localStorage === 'undefined') return DEFAULTS();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS();
    const parsed = JSON.parse(raw) as Partial<SettingsData>;
    return {
      keymap: parsed.keymap && typeof parsed.keymap === 'object' ? parsed.keymap : {},
      doubleJump: typeof parsed.doubleJump === 'boolean' ? parsed.doubleJump : false,
      doubleDash: typeof parsed.doubleDash === 'boolean' ? parsed.doubleDash : false,
    };
  } catch {
    return DEFAULTS();
  }
}

const data = read();

function write() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* 忽略写入失败（隐私模式等） */
  }
}

export const Settings = {
  data,

  setKey(action: string, code: string) {
    data.keymap[action] = code;
    write();
  },

  resetKeymap() {
    data.keymap = {};
    write();
  },

  setDoubleJump(v: boolean) {
    data.doubleJump = v;
    write();
  },

  setDoubleDash(v: boolean) {
    data.doubleDash = v;
    write();
  },
};
