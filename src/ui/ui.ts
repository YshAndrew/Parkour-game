/**
 * DOM UI 控制器 —— 菜单、暂停、结算、设置覆盖层
 */

import { LevelRegistry } from '../levels/registry';
import { Save } from '../core/save-data';
import { Settings } from '../core/settings';
import { KEYMAP, refreshKeymap } from '../core/controls';
import type { Action } from '../core/controls';

const hud = document.getElementById('hud') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const flash = document.getElementById('flash') as HTMLElement;
const levelTitle = document.getElementById('hud-level') as HTMLElement;
const coinText = document.getElementById('hud-coins') as HTMLElement;
const deathText = document.getElementById('hud-deaths') as HTMLElement;
const timeText = document.getElementById('hud-time') as HTMLElement;

/** 设置页里键位行的中文标签 */
const KEY_LABELS: Record<Action, string> = {
  left: '左移',
  right: '右移',
  up: '上（方向）',
  down: '下（方向）',
  jump: '跳',
  dash: '冲刺',
  pause: '暂停',
  restart: '重来',
};

/** 设置页内提示信息（重绑冲突等），下次渲染时展示 */
let settingsMsg = '';

/** HUD 节流：每帧都收 game:tick，但只在数值变化或 ≥100ms 时才真正写 DOM */
const hudCache = { ms: -1, deaths: -1, coins: -1, totalCoins: -1 };
let hudLastWrite = 0;

export const UI = {
  init() {
    UI.showOverlay();
    UI.showTitle();
    window.addEventListener('resize', () => UI.syncHudToCanvas());
  },

  /** 由 main 在 Phaser 画布创建完成后调用，绑定尺寸监听 */
  bindCanvas() {
    const canvas = document.querySelector('#game-container canvas');
    if (canvas && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => UI.syncHudToCanvas()).observe(canvas);
    }
    UI.syncHudToCanvas();
  },

  /** 把 HUD 覆盖层对齐到 canvas 的实际显示区域，避免落在黑边上 */
  syncHudToCanvas() {
    const app = document.getElementById('app');
    const canvas = document.querySelector('#game-container canvas') as HTMLCanvasElement | null;
    if (!app || !canvas) return;
    const a = app.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    hud.style.left = `${c.left - a.left}px`;
    hud.style.top = `${c.top - a.top}px`;
    hud.style.width = `${c.width}px`;
    hud.style.height = `${c.height}px`;
  },

  // ---------- 菜单 ----------

  showTitle() {
    UI.clearOverlay();
    const panel = UI.panel([
      UI.h1('像素跑酷'),
      UI.p('C 跳    X 冲刺（按方向键决定冲哪）    ←→/↑↓ 或 A/D/W/S 移动    下+跳 下平台'),
      UI.controlsTable({
        '移动:': '← → ↑ ↓ / A D W S',
        '跳:': 'C',
        '冲刺:': 'X（按方向键决定冲哪）',
        '下平台:': '↓ + 跳',
        '暂停:': 'Esc',
        '重来:': 'R',
      }),
      UI.btn('开始游戏', () => UI.emit('play-next')),
      UI.btn('无限模式', UI.showInfinitySelect, 'secondary'),
      UI.btn('选关', UI.showLevelSelect, 'secondary'),
      UI.btn('设置', () => UI.showSettings(UI.showTitle), 'secondary'),
      UI.btn('地图编辑器', () => {
        window.location.href = './editor.html';
      }, 'secondary'),
    ]);
    overlay.appendChild(panel);
  },

  showLevelSelect() {
    UI.clearOverlay();
    const panel = UI.panel([UI.h1('选关'), UI.div('level-grid')]);
    const grid = panel.querySelector('.level-grid') as HTMLDivElement;

    for (const lv of LevelRegistry.all) {
      const unlocked = lv.index <= Save.data.unlocked;
      const save = Save.level(lv.id);
      const card = document.createElement('div');
      card.className = unlocked ? 'level-card' : 'level-card dim';
      if (!unlocked) card.style.pointerEvents = 'none';
      card.innerHTML = `
        <div class="num" style="background:${unlocked ? '#ffcd75' : '#555'}">${lv.index + 1}</div>
        <div class="name">${lv.name}</div>
        <div class="hint">${unlocked ? (lv.hint ?? '') : '通关上一关解锁'}</div>
        <div class="best">${save.bestMs !== null ? `最佳 ${UI.fmtTime(save.bestMs)} · 金币 ${save.coins}/${save.totalCoins}` : ''}</div>
      `;
      card.addEventListener('click', () => UI.emit('play-level', lv.index));
      grid.appendChild(card);
    }

    panel.appendChild(UI.btn('返回', UI.showTitle, 'secondary'));
    overlay.appendChild(panel);
  },

  // ---------- 无限模式难度选单 ----------

  showInfinitySelect() {
    UI.clearOverlay();
    const panel = UI.panel([
      UI.h1('无限模式'),
      UI.p('选择起始难度（之后每关 +0.05 递增）'),
      UI.btn('轻松（0.2）', () => UI.emit('play-infinity', 0.2)),
      UI.btn('普通（0.5）', () => UI.emit('play-infinity', 0.5)),
      UI.btn('困难（0.75）', () => UI.emit('play-infinity', 0.75)),
      UI.btn('极限（1.0）', () => UI.emit('play-infinity', 1.0), 'secondary'),
      UI.btn('返回', UI.showTitle, 'secondary'),
    ]);
    overlay.appendChild(panel);
  },

  // ---------- 设置 ----------

  showSettings(back: () => void) {
    UI.clearOverlay();
    const panel = UI.panel([
      UI.h1('设置'),
      UI.div('settings-section', '<h2>键位（点击按键重新绑定，Esc 取消）</h2>'),
    ]);

    const keyRows = document.createElement('div');
    keyRows.className = 'settings-rows';
    for (const action of Object.keys(KEYMAP) as Action[]) {
      const row = document.createElement('div');
      row.className = 'key-row';
      const label = document.createElement('span');
      label.textContent = KEY_LABELS[action];
      const btn = document.createElement('button');
      btn.className = 'key-bind';
      btn.textContent = KEYMAP[action][0];
      btn.addEventListener('click', () => beginRebind(action, btn, back));
      row.append(label, btn);
      keyRows.appendChild(row);
    }
    panel.appendChild(keyRows);
    panel.appendChild(
      UI.btn('恢复默认键位', () => {
        Settings.resetKeymap();
        refreshKeymap();
        UI.showSettings(back);
      }, 'secondary'),
    );

    const diffSection = UI.div('settings-section', '<h2>难度</h2>');
    diffSection.appendChild(
      makeToggle('二段跳（滞空时可再跳一次）', Settings.data.doubleJump, (v) => {
        Settings.setDoubleJump(v);
      }),
    );
    diffSection.appendChild(
      makeToggle('二段冲刺（滞空时可冲刺两次）', Settings.data.doubleDash, (v) => {
        Settings.setDoubleDash(v);
      }),
    );
    panel.appendChild(diffSection);

    if (settingsMsg) {
      const msg = UI.div('settings-msg', settingsMsg);
      settingsMsg = '';
      panel.appendChild(msg);
    }
    panel.appendChild(UI.btn('返回', back, 'secondary'));
    overlay.appendChild(panel);
  },

  // ---------- 游戏内 ----------

  showHUD(levelName: string) {
    UI.syncHudToCanvas();
    hud.classList.remove('hidden');
    levelTitle.textContent = levelName;
    coinText.textContent = '0 / 0';
    deathText.textContent = '0';
    timeText.textContent = '0.0s';
    // 重置节流缓存，保证新关卡第一帧立即刷新
    hudCache.ms = -1;
    hudCache.deaths = -1;
    hudCache.coins = -1;
    hudCache.totalCoins = -1;
    hudLastWrite = 0;
  },
  hideHUD() {
    hud.classList.add('hidden');
  },

  updateHUD({ ms, deaths, coins, totalCoins }: { ms: number; deaths: number; coins: number; totalCoins: number }) {
    const now = performance.now();
    const urgent = deaths !== hudCache.deaths || coins !== hudCache.coins || totalCoins !== hudCache.totalCoins;
    if (!urgent && now - hudLastWrite < 100) return;
    hudCache.ms = ms;
    hudCache.deaths = deaths;
    hudCache.coins = coins;
    hudCache.totalCoins = totalCoins;
    hudLastWrite = now;
    coinText.textContent = `${coins} / ${totalCoins}`;
    deathText.textContent = `${deaths}`;
    timeText.textContent = `${(ms / 1000).toFixed(1)}s`;
  },

  flashDeath() {
    flash.classList.add('on');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => flash.classList.remove('on'));
    });
  },

  // ---------- 暂停 ----------

  showPause(onResume: () => void) {
    UI.clearOverlay();
    overlay.classList.add('active');
    const panel = UI.panel([
      UI.h1('暂停'),
      UI.btn('继续', () => {
        overlay.classList.remove('active');
        onResume();
      }),
      UI.btn('重来', () => UI.emit('restart')),
      UI.btn('设置', () => UI.showSettings(() => UI.showPause(onResume))),
      UI.btn('回菜单', () => UI.emit('go-menu')),
    ]);
    overlay.appendChild(panel);
  },

  hidePause() {
    overlay.classList.remove('active');
    UI.clearOverlay();
  },

  // ---------- 结算 ----------

  showWin(data: {
    levelId: string;
    levelIndex: number;
    ms: number;
    deaths: number;
    coins: number;
    totalCoins: number;
    isLast: boolean;
    isInfinity?: boolean;
    round?: number;
    runDeaths?: number;
    runCoins?: number;
  }) {
    UI.clearOverlay();
    overlay.classList.add('active');
    const save = Save.level(data.levelId);
    const isBest = save.bestMs !== null && data.ms <= save.bestMs;
    const panel = UI.panel([
      UI.h1(data.isInfinity ? `第 ${data.round} 关完成！` : '关卡完成！'),
      UI.div('stats', `
        <div class="stat">用时 <b class="${isBest ? 'new-best' : ''}">${UI.fmtTime(data.ms)}</b></div>
        <div class="stat">死亡 <b>${data.deaths}</b></div>
        <div class="stat">金币 <b>${data.coins} / ${data.totalCoins}</b></div>
        ${
          data.isInfinity
            ? `<div class="stat">无限累计：通关 <b>${data.round}</b> 关 · 死亡 <b>${data.runDeaths}</b> · 金币 <b>${data.runCoins}</b></div>`
            : ''
        }
      `),
      data.isInfinity
        ? UI.btn(`继续无限（第 ${(data.round ?? 0) + 1} 关）`, () => UI.emit('infinity-next'))
        : data.isLast
          ? UI.p('全关卡通关！感谢游玩 🎉')
          : UI.btn('下一关', () => UI.emit('play-next', data.levelIndex + 1)),
      UI.btn('选关', UI.showLevelSelect, 'secondary'),
      UI.btn('菜单', () => UI.emit('go-menu'), 'secondary'),
    ]);
    overlay.appendChild(panel);
  },

  // ---------- 工具 ----------

  showOverlay() {
    overlay.classList.add('active');
  },
  hideOverlay() {
    overlay.classList.remove('active');
    UI.clearOverlay();
  },
  clearOverlay() {
    overlay.innerHTML = '';
  },

  fmtTime(ms: number) {
    const s = (ms / 1000).toFixed(2);
    return `${s}s`;
  },

  // DOM 工厂
  panel(children: HTMLElement[]) {
    const el = document.createElement('div');
    el.className = 'panel';
    for (const c of children) el.appendChild(c);
    return el;
  },
  h1(text: string) {
    const el = document.createElement('h1');
    el.textContent = text;
    return el;
  },
  p(text: string) {
    const el = document.createElement('div');
    el.className = 'sub';
    el.textContent = text;
    return el;
  },
  btn(label: string, onClick: () => void, cls = '') {
    const el = document.createElement('button');
    el.className = 'px-btn' + (cls ? ' ' + cls : '');
    el.textContent = label;
    el.addEventListener('click', onClick);
    return el;
  },
  div(cls: string, html?: string) {
    const el = document.createElement('div');
    el.className = cls;
    if (html) el.innerHTML = html;
    return el;
  },
  controlsTable(map: Record<string, string>) {
    const el = document.createElement('div');
    el.className = 'controls-table';
    for (const [k, v] of Object.entries(map)) {
      el.innerHTML += `<div><kbd>${k}</kbd> ${v}</div>`;
    }
    return el;
  },

  // 简单事件总线
  listeners: new Map<string, Set<(d?: any) => void>>(),
  on(event: string, fn: (d?: any) => void) {
    if (!UI.listeners.has(event)) UI.listeners.set(event, new Set());
    UI.listeners.get(event)!.add(fn);
  },
  emit(event: string, data?: any) {
    UI.listeners.get(event)?.forEach((f) => f(data));
  },
};

// ---------- 设置页内部 ----------

/** 点击键位行进入"按任意键…"监听态 */
function beginRebind(action: Action, btn: HTMLButtonElement, back: () => void) {
  btn.textContent = '按任意键…';
  btn.classList.add('listening');
  const handler = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', handler);
    btn.classList.remove('listening');

    if (e.key === 'Escape') {
      settingsMsg = '';
      UI.showSettings(back);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      settingsMsg = '不支持修饰键/组合键，请按一个普通键';
      UI.showSettings(back);
      return;
    }
    const code = e.code;
    const conflict = (Object.keys(KEYMAP) as Action[]).find(
      (a) => a !== action && KEYMAP[a].includes(code),
    );
    if (conflict) {
      settingsMsg = `「${code}」已被「${KEY_LABELS[conflict]}」占用，请换一个键`;
      UI.showSettings(back);
      return;
    }
    settingsMsg = '';
    Settings.setKey(action, code);
    refreshKeymap();
    UI.showSettings(back);
  };
  window.addEventListener('keydown', handler);
}

/** 开关行（难度设置） */
function makeToggle(label: string, on: boolean, onChange: (v: boolean) => void) {
  const row = document.createElement('div');
  row.className = 'toggle-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const sw = document.createElement('button');
  sw.className = 'switch' + (on ? ' on' : '');
  sw.setAttribute('aria-pressed', String(on));
  sw.addEventListener('click', () => {
    const v = !on;
    sw.classList.toggle('on', v);
    sw.setAttribute('aria-pressed', String(v));
    onChange(v);
  });
  row.append(lbl, sw);
  return row;
}
