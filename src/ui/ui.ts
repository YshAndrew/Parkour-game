/**
 * DOM UI 控制器 —— 菜单、暂停、结算覆盖层
 */

import { LevelRegistry } from '../levels/registry';
import { Save } from '../core/save-data';

const hud = document.getElementById('hud') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const flash = document.getElementById('flash') as HTMLElement;
const levelTitle = document.getElementById('hud-level') as HTMLElement;
const coinText = document.getElementById('hud-coins') as HTMLElement;
const deathText = document.getElementById('hud-deaths') as HTMLElement;
const timeText = document.getElementById('hud-time') as HTMLElement;

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
      UI.p('空格 / 上 / W 跳跃    ←/→ / A/D 移动    Shift / Z 冲刺    下+跳 下平台'),
      UI.controlsTable({
        '跳:': 'Space / ↑ / W',
        '走:': '← → / A D',
        '冲刺:': 'Shift / Z',
        '下平台:': '↓ + 跳',
        '暂停:': 'Esc',
        '重来:': 'R',
      }),
      UI.btn('开始游戏', () => UI.emit('play-next')),
      UI.btn('选关', UI.showLevelSelect, 'secondary'),
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
        <div class="best">${save.bestMs !== null ? `最佳: ${UI.fmtTime(save.bestMs)}` : ''}</div>
      `;
      card.addEventListener('click', () => UI.emit('play-level', lv.index));
      grid.appendChild(card);
    }

    panel.appendChild(UI.btn('返回', UI.showTitle, 'secondary'));
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
  },
  hideHUD() {
    hud.classList.add('hidden');
  },

  updateHUD({ ms, deaths, coins, totalCoins }: { ms: number; deaths: number; coins: number; totalCoins: number }) {
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
  }) {
    UI.clearOverlay();
    overlay.classList.add('active');
    const save = Save.level(data.levelId);
    const isBest = save.bestMs !== null && data.ms <= save.bestMs;
    const panel = UI.panel([
      UI.h1('关卡完成！'),
      UI.div('stats', `
        <div class="stat">用时 <b class="${isBest ? 'new-best' : ''}">${UI.fmtTime(data.ms)}</b></div>
        <div class="stat">死亡 <b>${data.deaths}</b></div>
        <div class="stat">金币 <b>${data.coins} / ${data.totalCoins}</b></div>
      `),
      data.isLast
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
  h2(text: string) {
    const el = document.createElement('h2');
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
