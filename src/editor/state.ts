/**
 * 编辑器共享状态：当前网格（逐行字符串）、关卡 meta、撤销栈。
 * 编辑器场景 / 试玩场景 / DOM 面板都订阅同一份状态。
 */

export type Theme = 'forest' | 'cave' | 'sky';

export interface LevelMeta {
  id: string;
  name: string;
  hint: string;
  theme: Theme | '';
}

export interface EditorState {
  rows: string[];
  meta: LevelMeta;
}

/** 新图默认模板（已通过 check:maps 的骨架） */
export const TEMPLATE_ROWS = [
  '................',
  '.....o..........',
  '.S......^^^....E',
  '################',
  '################',
];

const defaultMeta = (): LevelMeta => ({
  id: 'my-level',
  name: '新关卡',
  hint: '选关界面的一句话提示',
  theme: '',
});

export const editorState: EditorState = {
  rows: TEMPLATE_ROWS.map((r) => r),
  meta: defaultMeta(),
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) fn();
}

export function width() {
  return Math.max(0, ...editorState.rows.map((r) => r.length));
}

export function height() {
  return editorState.rows.length;
}

export function getCell(x: number, y: number): string {
  if (y < 0 || y >= editorState.rows.length) return '.';
  return editorState.rows[y][x] ?? '.';
}

/** 把网格扩到至少 (w, h)，超出部分补空气 */
function growTo(w: number, h: number) {
  const rows = editorState.rows;
  const curW = width();
  const need = Math.max(w, curW);
  for (let y = 0; y < rows.length; y++) {
    if (rows[y].length < need) rows[y] = rows[y].padEnd(need, '.');
  }
  while (rows.length < h) rows.push('.'.repeat(need));
}

export function setCell(x: number, y: number, ch: string) {
  if (x < 0 || y < 0) return;
  growTo(x + 1, y + 1);
  const row = editorState.rows[y];
  editorState.rows[y] = row.slice(0, x) + ch + row.slice(x + 1);
  notify();
}

export function setRows(rows: string[]) {
  editorState.rows = rows.map((r) => r);
  notify();
}

export function setMeta(patch: Partial<LevelMeta>) {
  Object.assign(editorState.meta, patch);
  notify();
}

/** 重置为默认模板关卡 */
export function newLevel() {
  editorState.rows = TEMPLATE_ROWS.map((r) => r);
  editorState.meta = defaultMeta();
  notify();
}

// ---------- 撤销 ----------

const undoStack: string[][] = [];
const MAX_UNDO = 60;

/** 一次绘制笔画开始时调用，记录网格快照 */
export function snapshotForUndo() {
  undoStack.push(editorState.rows.map((r) => r));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

export function undo(): boolean {
  const prev = undoStack.pop();
  if (!prev) return false;
  editorState.rows = prev;
  notify();
  return true;
}
