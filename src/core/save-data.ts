/**
 * 简单本地存储，保存最佳成绩与已解锁关卡
 */

const KEY = 'pixel_parkour_v1';

export interface LevelSave {
  bestMs: number | null; // null = 未通关
  deaths: number;
  coins: number;
  totalCoins: number;
}

export interface SaveData {
  unlocked: number; // 已解锁的最高关卡下标（0-based）
  levels: Record<string, LevelSave>;
  fullscreen: boolean;
}

const defaults = (): SaveData => ({
  unlocked: 0,
  levels: {},
  fullscreen: false,
});

function read(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    // 逐字段校验类型：损坏/过期格式的存档降级为默认值，避免运行时抛错
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    return {
      unlocked:
        typeof parsed.unlocked === 'number' && Number.isFinite(parsed.unlocked) && parsed.unlocked >= 0
          ? Math.floor(parsed.unlocked)
          : 0,
      levels: parsed.levels && typeof parsed.levels === 'object' ? (parsed.levels as SaveData['levels']) : {},
      fullscreen: typeof parsed.fullscreen === 'boolean' ? parsed.fullscreen : false,
    };
  } catch {
    return defaults();
  }
}

function write(data: SaveData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {}
}

export const Save = {
  data: read(),

  persist() {
    write(Save.data);
  },

  level(id: string): LevelSave {
    if (!Save.data.levels[id]) {
      Save.data.levels[id] = { bestMs: null, deaths: 0, coins: 0, totalCoins: 0 };
    }
    return Save.data.levels[id];
  },

  unlock(index: number) {
    Save.data.unlocked = Math.max(Save.data.unlocked, index);
    Save.persist();
  },

  recordLevel(id: string, ms: number, deaths: number, coins: number, totalCoins: number) {
    const lv = Save.level(id);
    lv.deaths += deaths;
    if (lv.bestMs === null || ms < lv.bestMs) lv.bestMs = ms;
    lv.coins = Math.max(lv.coins, coins);
    lv.totalCoins = Math.max(lv.totalCoins, totalCoins);
    Save.persist();
  },
};
