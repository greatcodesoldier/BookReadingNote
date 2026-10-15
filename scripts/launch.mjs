/**
 * 一键启动：双击「启动读书笔记.bat」时实际跑的就是这个脚本。
 *
 * 它做四件事：
 *   1. 检查 Node.js 版本够不够
 *   2. 如果系统已经在运行 → 直接打开浏览器，不再重复启动
 *   3. 否则启动服务，等它就绪
 *   4. 自动打开浏览器
 *
 * 注意：这个文件里的中文提示全部由 Node 输出（UTF-8），
 * 所以 .bat 里不需要写任何中文，也就不会出现乱码。
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '127.0.0.1';
const OPEN_HOST = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
const URL = `http://${OPEN_HOST}:${PORT}`;

const MIN_MAJOR = 22;
const MIN_MINOR = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 输出 */

const line = (s = '') => console.log(s);
const title = (s) => console.log(`\n  ${s}`);
const step = (s) => console.log(`  ${s}`);

/** 启动过程中不要被 sqlite 的实验性警告刷屏 */
process.on('warning', () => {});

// 启动窗口默认安静一点：不打印每条请求，免得重要提示被顶上去。
// 真正的报错仍然会显示。想看请求日志的话，启动前设 QUIET=0 即可。
if (process.env.QUIET === undefined) process.env.QUIET = '1';

/* ---------------------------------------------------------------- 环境检查 */

function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > MIN_MAJOR || (maj === MIN_MAJOR && min >= MIN_MINOR)) return true;
  line();
  line(`  ⚠️  Node.js 版本过低：当前 v${process.versions.node}，需要 v${MIN_MAJOR}.${MIN_MINOR} 或更高。`);
  line();
  line('  这个系统用到了 Node 自带的数据库功能，低版本跑不起来。');
  line('  到 https://nodejs.org 下载安装新版（选 LTS 即可），');
  line('  装完关掉这个窗口，再双击一次启动文件就行。');
  line();
  return false;
}

/** 探测端口上是不是「本系统」已经在跑 */
async function probe(timeoutMs = 1200) {
  try {
    const res = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 打开浏览器 */

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- 主流程 */

title('📚  读书笔记管理系统 · 启动中');
line('  ─────────────────────────────────────────────');

if (!checkNode()) process.exit(1);

/* 已经在运行 → 打开浏览器就好，避免重复启动 */
const running = await probe();
if (running) {
  line();
  step('这个系统已经在运行了，就不重复启动了。');
  step(`数据库里现有 ${running.notes} 条笔记。`);
  line();
  const opened = openBrowser(URL);
  step(opened ? '✅ 已为你打开浏览器' : '请手动在浏览器里打开下面的地址：');
  line(`     ${URL}`);
  line();
  step('（这个窗口可以关掉，不影响已经运行的服务）');
  line();
  await sleep(1200);
  process.exit(0);
}

/* 启动服务：直接在当前进程里跑，Ctrl+C / 关窗口就停 */
await import('../src/index.js');

/* 等它就绪 */
let health = null;
for (let i = 0; i < 40 && !health; i++) {
  health = await probe(600);
  if (!health) await sleep(250);
}

line('  ─────────────────────────────────────────────');
if (!health) {
  step('⚠️  服务启动超时，或端口被别的程序占用了。');
  step('请把上面的报错信息截图，或改用其它端口：');
  line(`     $env:PORT=9000; node --no-warnings src\\index.js`);
  line();
  process.exit(1);
}

const opened = openBrowser(URL);
step(opened ? '✅ 系统已就绪，浏览器已经打开' : '✅ 系统已就绪');
line(`     ${URL}`);
line();
step(`数据文件：${health.dbPath}`);
step('用法：读到什么就 Ctrl+V 粘进页面，按 Ctrl+Enter 保存。');
line();
step('· 关闭这个窗口 = 停止系统（数据会即时保存，随时可以关）');
step('· 下次再点一次这个启动文件即可');
line();