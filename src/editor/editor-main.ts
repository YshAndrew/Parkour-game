/**
 * 编辑器入口：搭建 Phaser 实例、左侧瓦片面板、右侧属性/校验/仿真/保存面板，
 * 并在编辑器场景与试玩场景之间切换。
 */

import Phaser from 'phaser';
import { LevelRegistry } from '../levels/registry';
import { validateGrid } from '../core/validate.ts';
import { simulateGrid } from '../core/simulate.ts';
import { EditorScene } from './editor-scene.ts';
import { PlayScene } from './play-scene.ts';
import { editorState, newLevel, setMeta, setRows, subscribe, width, height } from './state.ts';
import { kindsToRows } from './tile-painter.ts';
import { openSaveDialog, isDev } from './save.ts';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'editor-canvas',
  backgroundColor: '#0e121d',
  pixelArt: true,
  roundPixels: true,
  width: 960,
  height: 540,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [EditorScene, PlayScene],
});

// 调试句柄（浏览器冒烟测试用，可删除）
declare global {
  interface Window {
    __parkourEditor?: { game: Phaser.Game };
  }
}
window.__parkourEditor = { game };

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// ---------- Toast ----------

function toast(msg: string, kind: 'success' | 'error' | '' = '') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ` ${kind}` : '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// ---------- 工具面板 ----------

interface ToolDef {
  ch: string;
  label: string;
  color: string;
}

const TOOLS: ToolDef[] = [
  { ch: '#', label: '实心', color: '#3e3f4a' },
  { ch: '=', label: '单向', color: '#6d6875' },
  { ch: '-', label: '横木', color: '#7a5c3e' },
  { ch: '^', label: '尖刺', color: '#c0392b' },
  { ch: '~', label: '岩浆', color: '#e74c3c' },
  { ch: 'o', label: '金币', color: '#ffd866' },
  { ch: 'S', label: '出生', color: '#8ff0a4' },
  { ch: 'E', label: '终点', color: '#2ecc71' },
  { ch: 'C', label: '检查点', color: '#95a5a6' },
  { ch: 'B', label: '弹跳', color: '#27ae60' },
  { ch: '>', label: '加速→', color: '#3498db' },
  { ch: '<', label: '加速←', color: '#3498db' },
  { ch: 'M', label: '平台M', color: '#9b59b6' },
  { ch: 'm', label: '平台m', color: '#9b59b6' },
  { ch: '.', label: '橡皮', color: '#222' },
];

let activeToolCh = '#';

function buildPalette(editor: EditorScene) {
  const palette = $('palette');
  palette.innerHTML = '';
  for (const t of TOOLS) {
    const btn = document.createElement('button');
    btn.className = 'palette-btn' + (t.ch === activeToolCh ? ' active' : '');
    btn.innerHTML = `<span class="swatch" style="background:${t.color}"></span>${t.label}`;
    btn.title = `放置「${t.ch}」`;
    btn.addEventListener('click', () => {
      activeToolCh = t.ch;
      editor.setTool(t.ch);
      palette.querySelectorAll('.palette-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateStatus();
    });
    palette.appendChild(btn);
  }
}

// ---------- 面板 ----------

function bindMeta() {
  const id = $('f-id') as HTMLInputElement;
  const name = $('f-name') as HTMLInputElement;
  const hint = $('f-hint') as HTMLInputElement;
  const theme = $('f-theme') as HTMLSelectElement;

  const sync = () => {
    id.value = editorState.meta.id;
    name.value = editorState.meta.name;
    hint.value = editorState.meta.hint;
    theme.value = editorState.meta.theme;
  };
  sync();

  id.addEventListener('input', () => setMeta({ id: id.value }));
  name.addEventListener('input', () => setMeta({ name: name.value }));
  hint.addEventListener('input', () => setMeta({ hint: hint.value }));
  theme.addEventListener('change', () => setMeta({ theme: theme.value as 'forest' | 'cave' | 'sky' | '' }));
  subscribe(sync);
}

function updateSize() {
  $('size-info').textContent = `${height()} 行 × ${width()} 列（${width() * 16}×${height() * 16}px）`;
}

function updateValidate() {
  const panel = $('validate-panel');
  const r = validateGrid(editorState.rows);
  if (r.ok) {
    panel.className = 'panel-box ok';
    panel.textContent = `✓ 结构通过（S:${r.spawns} E:${r.exits}，${r.height}×${r.width}）`;
  } else {
    panel.className = 'panel-box bad';
    panel.innerHTML = r.issues.map((e) => `✗ ${e.msg}`).join('<br/>');
  }
}

function updateSimulate() {
  const panel = $('simulate-panel');
  const r = simulateGrid(editorState.rows);
  if (r.spawnEmbedded) {
    panel.className = 'panel-box bad';
    panel.textContent = `✗ ${r.reason ?? '出生点嵌在方块里'}`;
    return;
  }
  const ok = r.reached && r.deaths === 0;
  panel.className = ok ? 'panel-box ok' : 'panel-box bad';
  panel.textContent = ok
    ? `✓ 可通关：0 死亡到达终点（推进 x=${Math.round(r.maxX)}）`
    : `✗ 不可通关：到达=${r.reached} 死亡=${r.deaths} 推进到 x=${Math.round(r.maxX)}${r.reason ? `（${r.reason}）` : ''}`;
}

let simTimer: number | undefined;
function scheduleSimulate() {
  window.clearTimeout(simTimer);
  simTimer = window.setTimeout(updateSimulate, 700);
}

function bindLoadExisting() {
  const sel = $('load-existing') as HTMLSelectElement;
  sel.innerHTML = '<option value="">— 选择现有地图 —</option>';
  LevelRegistry.all.forEach((lv, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i + 1}. ${lv.name}`;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    const i = Number(sel.value);
    if (Number.isNaN(i) || i < 0 || i >= LevelRegistry.count()) return;
    const lv = LevelRegistry.get(i);
    setRows(kindsToRows(lv.grid));
    setMeta({ id: lv.id, name: lv.name, hint: lv.hint ?? '', theme: lv.theme ?? '' });
    sel.value = '';
    toast(`已载入「${lv.name}」`, 'success');
  });
}

// ---------- 状态栏 ----------

function updateStatus(extra = '') {
  const bar = $('status-bar');
  const tool = TOOLS.find((t) => t.ch === activeToolCh);
  bar.innerHTML = [
    `<span>工具：${tool?.label ?? '?'}</span>`,
    `<span>尺寸：${height()}×${width()}</span>`,
    `<span id="status-cursor">光标：—</span>`,
    `<span>${isDev ? '开发模式：可写入项目' : '静态构建：保存用下载/复制'}</span>`,
    extra ? `<span>${extra}</span>` : '',
  ].join('');
}

// ---------- 场景切换 ----------

function goPlay() {
  game.scene.stop('editor');
  game.scene.start('play', { rows: [...editorState.rows] });
  toast('试玩中：方向键/AD 移动，空格/上/W 跳，Shift/Z 冲刺，Esc 返回编辑', '');
}

function backToEditor() {
  game.scene.stop('play');
  game.scene.start('editor');
  updateStatus();
}

// ---------- 启动 ----------

game.events.once(Phaser.Core.Events.READY, () => {
  const editor = game.scene.getScene('editor') as EditorScene;
  const play = game.scene.getScene('play') as PlayScene;

  buildPalette(editor);
  bindMeta();
  bindLoadExisting();
  updateSize();
  updateValidate();
  updateSimulate();
  updateStatus();

  subscribe(() => {
    updateSize();
    updateValidate();
    scheduleSimulate();
    updateStatus();
  });

  editor.events.on('editor:cursor', (t: { x: number; y: number; ch: string } | null) => {
    const el = document.getElementById('status-cursor');
    if (el) el.textContent = t ? `光标：(${t.x}, ${t.y}) ${t.ch}` : '光标：—';
  });
  editor.events.on('editor:tool', (ch: string) => {
    activeToolCh = ch;
    updateStatus();
  });

  play.events.on('play:win', (d: { deaths: number; ms: number }) => {
    toast(`通关！死亡 ${d.deaths} 次，用时 ${(d.ms / 1000).toFixed(1)}s`, 'success');
    setTimeout(backToEditor, 900);
  });
  play.events.on('play:exit', () => backToEditor());
  play.events.on('play:died', (deaths: number) => {
    updateStatus(`死亡 ${deaths} 次`);
  });
  play.events.on('play:tick', (d: { ms: number; deaths: number }) => {
    updateStatus(`死亡 ${d.deaths} 次 · ${(d.ms / 1000).toFixed(1)}s`);
  });

  $('btn-new').addEventListener('click', () => {
    const hasContent = editorState.rows.some((r) => /[^.\s]/.test(r));
    if (hasContent && !window.confirm('清空当前网格，新建默认模板关卡？')) return;
    newLevel();
    toast('已新建模板关卡', 'success');
  });
  $('btn-play').addEventListener('click', () => goPlay());
  $('btn-save').addEventListener('click', () => openSaveDialog(toast));
  $('btn-simulate').addEventListener('click', updateSimulate);
});
