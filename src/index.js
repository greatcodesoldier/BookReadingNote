/**
 * 服务入口：一个零依赖的本地 HTTP 服务，同时提供 REST API 和前端页面。
 *
 *   node src/index.js                  # 打开 http://127.0.0.1:7788
 *   PORT=9000 node src/index.js
 *   NOTES_DB=./data/my.db node src/index.js
 *   HOST=0.0.0.0 node src/index.js     # 局域网访问（注意：默认只监听本机）
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './db.js';
import { createRouter } from './api.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');

const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.NOTES_DB || join(ROOT, 'data', 'notes.db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const store = createStore(DB_PATH);
const handleApi = createRouter(store);

// 启动时顺手清一次没人引用的图片（粘进记录台又没保存的、笔记已删掉的）。
// 只清理放置超过 7 天的，免得把「刚粘进去、还没点保存」的草稿图删掉。
try {
  const swept = store.attachments.gc({ graceDays: 7 });
  if (swept.removed && process.env.QUIET !== '1') {
    console.log(`  （顺带清理了 ${swept.removed} 张没人再引用的图片）`);
  }
} catch (err) {
  console.error('清理无用图片失败（不影响使用）：', err.message);
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 阻止路径穿越
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR + sep) && target !== join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('is dir');
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    // 单页应用：未知路径回落到 index.html
    try {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();

  res.on('finish', () => {
    if (process.env.QUIET === '1') return;
    const ms = Date.now() - started;
    console.log(`${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${ms}ms)`);
  });

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('未捕获错误：', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, HOST, () => {
  const stats = store.stats();
  const banner = [
    '',
    '  📚  读书笔记管理系统',
    '  ─────────────────────────────────────────────',
    `  地址    http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
    `  数据库  ${stats.dbPath}`,
    `  现有    ${stats.notes} 条笔记 · ${stats.tags} 个标签 · ${stats.topics} 个主题` +
      (stats.attachments ? ` · ${stats.attachments} 张图片（${(stats.attachmentBytes / 1024 / 1024).toFixed(1)}MB）` : ''),
    '  ─────────────────────────────────────────────',
    '  Ctrl+C 停止服务',
    '',
  ].join('\n');
  console.log(banner);
});

/** 端口被占用时，先看看占着它的到底是不是本系统自己 */
async function probeExisting() {
  const host = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  try {
    const res = await fetch(`http://${host}:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('\n  ❌ 服务启动失败：', err.message, '\n');
    process.exit(1);
  }

  const host = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const existing = await probeExisting();
  const lines = ['', `  ⚠️  端口 ${PORT} 已经被占用，服务没能启动。`, ''];

  if (existing) {
    lines.push(
      '  看起来这个系统已经在运行了（数据库里现有 ' + `${existing.notes} 条笔记` + '）。',
      `  直接用浏览器打开 http://${host}:${PORT} 就行，不用再启动一次。`,
      '',
      '  想重启的话：先到原来那个窗口按 Ctrl+C 停掉，再重新启动。',
    );
  } else {
    lines.push(
      `  占用这个端口的是别的程序（不是本系统）。`,
      '',
      '  换个端口启动即可：',
      `      PowerShell:   $env:PORT=9000; node --no-warnings src/index.js`,
      `      macOS/Linux:  PORT=9000 node --no-warnings src/index.js`,
      '',
      `  然后打开 http://${host}:9000`,
      '  或者先找出占用端口的程序并关掉：',
      `      netstat -ano | findstr :${PORT}`,
    );
  }
  lines.push('');
  console.error(lines.join('\n'));
  // 稍微等一下再退出：让探测端口留下的异步句柄收干净，
  // 否则 Windows 上偶尔会多打一行 "Assertion failed: ... libuv" 的噪音。
  setTimeout(() => process.exit(1), 120);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}