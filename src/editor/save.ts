/**
 * 保存/导出：构建 LevelData .ts 源码；提供三种保存方式：
 *  ① 自动写入项目 src/levels/maps/（仅开发模式，经 Vite 本地端点）
 *  ② 下载 .ts 文件
 *  ③ 复制到剪贴板
 * 点击“保存”时弹窗询问使用哪种方式。
 */

import { editorState } from './state.ts';

export function sanitizeId(id: string): string {
  const s = id.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return s || 'my-level';
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 生成符合 LevelData 的 .ts 源码 */
export function buildLevelTs(): string {
  const m = editorState.meta;
  const rows = editorState.rows;
  const gridStr = rows.map((r) => `    '${esc(r)}',`).join('\n');
  const themeLine = m.theme ? `\n    theme: '${m.theme}',` : '';
  return [
    `import type { LevelData } from '../../core/map-format';`,
    ``,
    `const level: LevelData = {`,
    `  meta: {`,
    `    id: '${esc(sanitizeId(m.id))}',        // 全局唯一，存档 key`,
    `    name: '${esc(m.name || '新关卡')}',`,
    `    hint: '${esc(m.hint)}',${themeLine}`,
    `  },`,
    `  grid: [`,
    gridStr,
    `  ],`,
    `};`,
    ``,
    `export default level;`,
    ``,
  ].join('\n');
}

// ---------- 本地保存端点（Vite dev only） ----------

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch(url, init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

export const isDev = import.meta.env.DEV;

/** 获取服务器建议的下一个文件名（如 17-xxx.ts）；静态构建返回 null */
export async function fetchNextFilename(): Promise<string | null> {
  const r = await fetchJson('/__save-map/next');
  if (!r.ok) return null;
  const next = (r.body as { next?: string } | null)?.next;
  if (!next) return null;
  return `${next}-${sanitizeId(editorState.meta.id)}.ts`;
}

/** 写入项目文件；返回结果描述 */
export async function writeToProject(filename: string, content: string): Promise<{ ok: boolean; msg: string }> {
  const r = await fetchJson('/__save-map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content }),
  });
  if (!r.ok) {
    const err = (r.body as { error?: string } | null)?.error ?? `HTTP ${r.status || '网络错误'}`;
    return { ok: false, msg: err };
  }
  const data = r.body as { filename?: string; overwritten?: boolean } | null;
  const fn = data?.filename ?? filename;
  return { ok: true, msg: data?.overwritten ? `已覆盖 ${fn}` : `已写入 ${fn}` };
}

/** 下载 .ts 文件 */
export function downloadTs(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/typescript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 复制到剪贴板（带降级） */
export async function copyTs(content: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(content);
      return true;
    }
  } catch {
    /* fallthrough */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = content;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------- 保存对话框 ----------

export function openSaveDialog(toast: (msg: string, kind?: 'success' | 'error') => void) {
  const root = document.getElementById('modal-root');
  if (!root) return;

  const filename = document.createElement('input');
  filename.value = '…';
  filename.spellcheck = false;

  fetchNextFilename().then((suggest) => {
    filename.value = suggest ?? `${sanitizeId(editorState.meta.id)}.ts`;
  });

  const close = () => {
    root.classList.remove('open');
    root.innerHTML = '';
  };

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h3>保存关卡</h3>
    <label>文件名（两位数字前缀决定选关顺序，如 05-my-level.ts）
    </label>
    <div class="row">
      <button data-act="write" class="primary">① 写入项目 maps/</button>
      <button data-act="download">② 下载 .ts</button>
      <button data-act="copy">③ 复制内容</button>
    </div>
    <div class="row">
      <button data-act="cancel">取消</button>
    </div>
  `;
  const label = modal.querySelector('label');
  if (label) label.appendChild(filename);
  modal.querySelector('[data-act="cancel"]')!.addEventListener('click', close);
  modal.querySelector('[data-act="write"]')!.addEventListener('click', async () => {
    const fn = filename.value.trim();
    const content = buildLevelTs();
    if (!isDev) {
      toast('静态构建无法写入项目，请用下载/复制', 'error');
      return;
    }
    const r = await writeToProject(fn, content);
    toast(r.msg, r.ok ? 'success' : 'error');
    if (r.ok) close();
  });
  modal.querySelector('[data-act="download"]')!.addEventListener('click', () => {
    downloadTs(filename.value.trim() || 'map.ts', buildLevelTs());
    toast('已下载文件', 'success');
    close();
  });
  modal.querySelector('[data-act="copy"]')!.addEventListener('click', async () => {
    const ok = await copyTs(buildLevelTs());
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
    if (ok) close();
  });

  root.innerHTML = '';
  root.appendChild(modal);
  root.classList.add('open');
}
