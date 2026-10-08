/**
 * 地图结构校验 —— 纯逻辑、无 Phaser/Node 依赖。
 * 编辑器实时校验与 scripts/validate-maps.mjs 共用同一份规则。
 *
 * 规则（与 validate-maps.mjs 一致）：
 *  - 出生点 S 恰好 1 个；终点 E 至少 1 个
 *  - S / E / C 下方 3 格内必须有落脚方块（#、=、B、M、m）
 *  - B / ^ / ~ 下方必须是实心（# 或 ~）
 */
export interface ValidateIssue {
  msg: string;
  x?: number;
  y?: number;
}

export interface ValidateResult {
  ok: boolean;
  issues: ValidateIssue[];
  width: number;
  height: number;
  spawns: number;
  exits: number;
}

const FOOTING = new Set(['#', '=', 'B', 'M', 'm']);

/** 校验逐行字符串网格（每行可不等长，越界视为空气） */
export function validateGrid(rows: string[]): ValidateResult {
  const height = rows.length;
  const width = Math.max(0, ...rows.map((r) => r.length));
  const issues: ValidateIssue[] = [];

  const at = (x: number, y: number): string =>
    y >= 0 && y < rows.length ? (rows[y][x] ?? '.') : '.';

  const solidBelow = (x: number, y: number) => {
    for (let d = 1; d <= 3; d++) {
      if (FOOTING.has(at(x, y + d))) return true;
    }
    return false;
  };

  let spawns = 0;
  let exits = 0;
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === 'S') {
        spawns++;
        if (!solidBelow(x, y)) issues.push({ msg: `S(${x},${y}) 下方 3 格无落脚`, x, y });
      }
      if (c === 'E') {
        exits++;
        if (!solidBelow(x, y)) issues.push({ msg: `E(${x},${y}) 下方 3 格无落脚`, x, y });
      }
      if (c === 'C' && !solidBelow(x, y)) issues.push({ msg: `C(${x},${y}) 下方 3 格无落脚`, x, y });
      if ((c === 'B' || c === '^' || c === '~') && at(x, y + 1) !== '#' && at(x, y + 1) !== '~') {
        issues.push({ msg: `${c}(${x},${y}) 下方不是实心`, x, y });
      }
    }
  }
  if (spawns !== 1) issues.push({ msg: `出生点数量=${spawns}，必须恰好 1 个` });
  if (exits < 1) issues.push({ msg: '缺少终点 E' });

  return { ok: issues.length === 0, issues, width, height, spawns, exits };
}
