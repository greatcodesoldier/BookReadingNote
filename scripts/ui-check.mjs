/**
 * 前端渲染自检：用本机已安装的 Chrome / Edge 无头打开每个视图，
 * 等页面真正跑完（含接口请求与渲染）后导出 DOM，检查：
 *   1. 关键元素是否渲染出来（例如笔记卡片、粘贴框、分析面板）
 *   2. 是否卡在「正在启动 / 正在载入」
 *   3. 页面有没有抛出脚本错误（index.html 里的 error banner 会显示出来）
 *
 *   node --no-warnings scripts/ui-check.mjs
 *   BASE=http://127.0.0.1:9000 node --no-warnings scripts/ui-check.mjs
 *
 * 找不到浏览器时会自动跳过，不影响功能。
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://127.0.0.1:7788';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_ROOT = join(ROOT, '.ui-check-profile');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const CHECKS = [
  {
    view: 'notes',
    name: '记录与浏览',
    expect: [
      ['粘贴输入框', 'capture-input'],
      ['保存按钮', '全部保存'],
      ['侧栏分面', 'sb-item'],
      ['笔记卡片', 'note-card'],
      ['标签徽章', 'tag-chip'],
      ['编辑/删除操作', 'data-act="edit"'],
    ],
    cardCount: true,
  },
  {
    view: 'analyze',
    name: '主题分析',
    expect: [
      ['范围选择面板', '选择主题范围'],
      ['生成按钮', '生成读书笔记'],
      ['分析概览', '主题概览'],
      ['关键词脉络', '关键词脉络'],
    ],
  },
  {
    view: 'timeline',
    name: '时间轴',
    expect: [['时间轴标题', '时间轴'], ['月份格子', 'tl-month'], ['类型回看', '按类型回看']],
  },
  {
    view: 'tags',
    name: '标签管理',
    expect: [['标签表格', 'tag-table'], ['新建标签框', 'new-tag'], ['重命名输入框', 'rename-input']],
  },
  {
    view: 'settings',
    name: '设置',
    expect: [
      ['数据面板', '导出 JSON 备份'],
      ['AI 配置', 'AI 综述'],
      ['快捷键说明', '快捷键'],
      ['标签规则', 'auto'],
    ],
  },
];

const COMMON_REJECT = [
  ['卡在启动中', '正在启动'],
  ['卡在载入中', '正在载入'],
  ['后端连接失败', '连接后端失败'],
];

const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.log('未找到 Chrome / Edge，跳过 UI 自检（不影响功能）。');
  process.exit(0);
}

function dumpDom(url, index, extra = [], budgetMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${join(PROFILE_ROOT, `p${index}`)}`,
        `--virtual-time-budget=${budgetMs}`,
        ...extra,
        '--dump-dom',
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 45000 },
      (err, stdout, stderr) => {
        if (stdout) return resolve(stdout);
        reject(new Error((stderr || err?.message || '无输出').split('\n').filter(Boolean).slice(-1)[0]));
      },
    );
  });
}

/* ------------------------------------------------ 自检数据（只在临时库上造） */

/** 1×1 的 PNG，专门给自检用 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/**
 * 探针要检查「笔记卡片上的图片真的能显示」「主题分析有概览」这类事情，
 * 那需要库里确实有够用的数据 —— 绝不能往用户自己的库里乱塞东西，
 * 所以只有显式给了 SEED_IMAGE=1（配合一个临时库）才会先造几条。
 */
async function seedImageNote() {
  if (process.env.SEED_IMAGE !== '1') return;
  try {
    // 先放几张普通笔记：主题分析、时间轴这些视图得有东西可算才谈得上「渲染正常」
    const samples = [
      ['2026-03-02', '认知负荷', '工作记忆的容量是有限的，所以把复杂任务拆成小步，能明显降低出错的概率。 #认知'],
      ['2026-03-09', '认知负荷', '把「记住」换成「写下来」，脑子就腾出来了：外部记忆比内部记忆可靠得多。 #认知'],
      ['2026-03-16', '决策', '沉没成本之所以难放下，是因为承认它已经白费了，等于承认自己当初判断错了。 #决策'],
    ];
    for (const [noteDate, topic, content] of samples) {
      await api('/api/notes', { content, topic, noteDate });
    }

    const up = await api('/api/attachments', {
      dataUrl: `data:image/png;base64,${TINY_PNG}`, name: '自检用图.png', width: 1, height: 1,
    });
    await api('/api/notes', {
      content: `这张图是自检用的：\n\n![](${up.attachment.url})\n\n图下面是说明文字。`,
      title: '自检：图文混排', topic: '自检', noteDate: '2026-03-20',
    });
    console.log(`  （已为自检插入 ${samples.length + 1} 条笔记，其中 1 条带图）`);
  } catch (err) {
    console.log(`  （插入自检数据失败：${err.message}）`);
  }
}

console.log(`\nUI 渲染自检\n  浏览器 ${browser}\n  地址   ${BASE}\n${'─'.repeat(56)}`);

// 必须在渲染各视图之前先把自检数据准备好，否则「记录与浏览」那一组会因为空库而全线报错
await seedImageNote();

let pass = 0;
let fail = 0;

for (const [i, check] of CHECKS.entries()) {
  let dom;
  try {
    dom = await dumpDom(`${BASE}/#/${check.view}`, i);
  } catch (err) {
    console.log(`\n${check.name}\n  ✗ 渲染失败：${err.message}`);
    fail++;
    continue;
  }

  console.log(`\n${check.name}`);
  for (const [label, needle] of check.expect) {
    if (dom.includes(needle)) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label}（DOM 中找不到 ${JSON.stringify(needle)}）`); }
  }
  for (const [label, needle] of COMMON_REJECT) {
    if (dom.includes(needle)) { fail++; console.log(`  ✗ 不该出现：${label}`); }
    else { pass++; console.log(`  ✓ 无「${label}」`); }
  }
  // 脚本错误横幅：只有真的触发了才会带上文字（元素本身始终存在于页面里）
  const banner = dom.match(/<div class="js-error-banner"[^>]*>([\s\S]*?)<\/div>/);
  const bannerText = (banner?.[1] || '').trim();
  if (bannerText) { fail++; console.log(`  ✗ 页面抛了脚本错误：${bannerText.slice(0, 160)}`); }
  else { pass++; console.log('  ✓ 没有脚本错误'); }
  if (check.cardCount) {
    const cards = (dom.match(/class="card note-card/g) || []).length;
    if (cards > 0) { pass++; console.log(`  ✓ 实际渲染出 ${cards} 张笔记卡片`); }
    else { fail++; console.log('  ✗ 一张笔记卡片都没有渲染出来（数据库里可能没有笔记）'); }
  }
}

/* ------------------------------------------------ 交互可用性（鼠标能不能点） */

/*
 * 只检查 DOM 里有没有内容是抓不到「页面被透明遮罩盖住、鼠标完全点不动」这类问题的：
 * 元素都在、hidden 属性也在，但 CSS 让遮罩一直显示着。
 * 所以这里把探针页放进 public/ 跑一轮真实浏览器的命中测试。
 */
const PROBE_SRC = join(ROOT, 'scripts', 'ui-probe.html');
const PROBE_DST = join(ROOT, 'public', '__ui-probe.html');

async function checkInteractive() {
  console.log('\n交互可用性');
  if (!existsSync(PROBE_SRC)) { fail++; console.log('  ✗ 缺少探针文件 scripts/ui-probe.html'); return; }
  copyFileSync(PROBE_SRC, PROBE_DST);
  try {
    // 探针里有一次真实的图片上传（要等网络 + 预览防抖），虚拟时间预算给足；
// SHRINK=1 时还会额外造一张十几 MB 的大图来验证压缩，所以再放宽一些
    const wantShrink = process.env.SHRINK === '1';
    const probeUrl = `${BASE}/__ui-probe.html${wantShrink ? '?shrink=1' : ''}`;
    if (wantShrink) console.log('  （包含大截图压缩探测：会临时上传一张十几 MB 的图，只该用在临时库上）');
    const dom = await dumpDom(probeUrl, 'probe', ['--window-size=1400,1000'], wantShrink ? 40000 : 20000);
    const block = dom.match(/===== RESULT =====([\s\S]*?)===== END =====/);
    if (!block) { fail++; console.log('  ✗ 探针没有返回结果（页面可能没加载完）'); return; }
    for (const row of block[1].trim().split('\n')) {
      if (!row.trim()) continue;
      const [status, name, detail] = row.split('\t');
      if (status === 'PASS') { pass++; console.log(`  ✓ ${name}`); }
      else { fail++; console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`); }
    }
  } catch (err) {
    fail++;
    console.log(`  ✗ 交互探测失败：${err.message}`);
  } finally {
    rmSync(PROBE_DST, { force: true });
  }
}

await checkInteractive();

console.log(`\n${'─'.repeat(56)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
try { rmSync(PROFILE_ROOT, { recursive: true, force: true }); } catch { /* 目录被占用就留着，已加进 .gitignore */ }
if (fail) process.exit(1);
console.log('  UI 渲染自检通过 ✅');
process.exit(0);