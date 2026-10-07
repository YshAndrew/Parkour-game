import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('.', import.meta.url));
const mapsDir = resolve(root, 'src/levels/maps');

/** 文件名白名单：两位数字前缀 + 小写字母/数字/横线/下划线，杜绝路径穿越 */
const FILE_RE = /^\d{2}-[a-z0-9_-]+\.ts$/;

function nextNumber(): string {
  if (!existsSync(mapsDir)) return '04';
  const nums = readdirSync(mapsDir)
    .filter((f) => /^\d{2}-/.test(f))
    .map((f) => parseInt(f.slice(0, 2), 10))
    .filter((n) => Number.isInteger(n));
  const max = nums.length ? Math.max(...nums) : 3;
  return String(max + 1).padStart(2, '0');
}

function writeJson(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, code: number, obj: unknown) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

/**
 * 开发模式的地图保存端点（仅 Vite dev server，生产构建不存在）：
 *   GET  /__save-map/next   → { next: '17' }
 *   GET  /__save-map/list   → { files: [...] }
 *   POST /__save-map        → body { filename, content } → 写入 src/levels/maps/
 */
function saveMapPlugin(): Plugin {
  return {
    name: 'parkour-save-map',
    configureServer(server) {
      server.middlewares.use('/__save-map/next', (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'GET only' });
          return;
        }
        writeJson(res, 200, { next: nextNumber() });
      });

      server.middlewares.use('/__save-map/list', (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'GET only' });
          return;
        }
        const files = existsSync(mapsDir)
          ? readdirSync(mapsDir).filter((f) => f.endsWith('.ts')).sort()
          : [];
        writeJson(res, 200, { files });
      });

      server.middlewares.use('/__save-map', (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'POST only' });
          return;
        }
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c;
          if (body.length > 2_000_000) req.destroy();
        });
        req.on('end', () => {
          let data: { filename?: unknown; content?: unknown };
          try {
            data = JSON.parse(body);
          } catch {
            writeJson(res, 400, { error: 'JSON 解析失败' });
            return;
          }
          const filename = String(data.filename ?? '').trim();
          const content = String(data.content ?? '');
          if (!FILE_RE.test(filename)) {
            writeJson(res, 400, { error: '非法文件名（需形如 05-my-level.ts）' });
            return;
          }
          if (!content || content.length > 500_000) {
            writeJson(res, 400, { error: '内容为空或过大' });
            return;
          }
          const target = resolve(mapsDir, filename);
          // 双重防御：白名单已排除路径穿越，这里再校验一次解析后的真实路径
          if (!target.startsWith(mapsDir + sep)) {
            writeJson(res, 400, { error: '路径越界' });
            return;
          }
          const overwritten = existsSync(target);
          writeFileSync(target, content, 'utf8');
          writeJson(res, 200, { filename, overwritten });
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  plugins: [saveMapPlugin()],
  build: {
    rollupOptions: {
      input: {
        game: resolve(root, 'index.html'),
        editor: resolve(root, 'editor.html'),
      },
    },
  },
});
