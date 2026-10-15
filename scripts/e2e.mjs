/**
 * 端到端测试：默认自己拉起一个独立端口的服务 + 全新数据库，跑完自动清理。
 *   node --no-warnings scripts/e2e.mjs
 * 也可以指定已有服务：BASE=http://127.0.0.1:7788 node --no-warnings scripts/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 7799);
const EXTERNAL = !!process.env.BASE;
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const TEST_DB = join(ROOT, 'data', 'e2e-test.db');

let child = null;

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('测试服务启动超时');
}

if (!EXTERNAL) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(TEST_DB + suffix, { force: true });
  child = spawn(process.execPath, ['--no-warnings', 'src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NOTES_DB: TEST_DB, QUIET: '1' },
    stdio: 'ignore',
  });
  await waitForHealth();
}

async function cleanup() {
  if (!child) return;
  const c = child;
  child = null;
  await new Promise((done) => {
    c.once('exit', done);
    c.kill();
    setTimeout(done, 2000);
  });
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix, { force: true }); } catch { /* 文件仍被占用时忽略，下次运行会覆盖 */ }
  }
}

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, text };
}

const SAMPLE = `#心理学 #决策
《思考，快与慢》 作者：丹尼尔·卡尼曼
类型：摘录
页码：P32
> 直觉是有代价的：它让我们在熟悉的情境里高效，在陌生的情境里自信地犯错。
---
今天读到系统1和系统2的分工，感觉和认知失调能连起来：人一旦为某个立场付出了努力，就会自动替它辩护。 #认知失调
---
## 反脆弱
摘录：风会熄灭蜡烛，却能使火越烧越旺。
主题：反脆弱
日期：2026-02-11
---
《原子习惯》
观点：习惯是自我提高的复利，每天进步 1%，一年后是 37 倍。
页码：p.18
#习惯 #复利`;

console.log(`\n端到端测试 ${BASE}\n${'─'.repeat(56)}`);

/* 静态资源 */
console.log('\n静态资源');
{
  const r = await req('/');
  check('首页返回 HTML', r.status === 200 && String(r.text).includes('读书笔记管理系统'));
  for (const asset of ['/css/style.css', '/js/app.js', '/js/views/capture.js', '/js/state.js']) {
    const a = await req(asset);
    check(`资源可访问 ${asset}`, a.status === 200 && String(a.text).length > 100);
  }
  const spa = await req('/some/unknown/route');
  check('未知路径回落到单页应用', spa.status === 200 && String(spa.text).includes('<div class="app">'));
}

/* 解析预览 */
console.log('\n解析预览');
let blocks;
{
  const r = await req('/api/notes/preview', { method: 'POST', body: { text: SAMPLE, mode: 'auto', defaultDate: '2026-03-01' } });
  check('预览接口可用', r.status === 200 && Array.isArray(r.data.blocks));
  blocks = r.data.blocks;
  check('识别出 4 条笔记', blocks.length === 4, `实际 ${blocks?.length}`);
  check('第一条主题正确', blocks[0]?.topic === '思考，快与慢');
  check('第一条页码正确', blocks[0]?.location === 'P32');
  check('第一条类型为摘录', blocks[0]?.kind === 'excerpt');
  check('第一条带标签', blocks[0]?.tags.includes('心理学') && blocks[0]?.tags.includes('决策'));
  check('第三条识别出书名作为主题', blocks[2]?.topic === '反脆弱');
  check('第三条日期被解析', blocks[2]?.noteDate === '2026-02-11');
  check('第四条类型为想法', blocks[3]?.kind === 'idea');
}

/* 保存 */
console.log('\n保存与判重');
{
  const r = await req('/api/notes/bulk', { method: 'POST', body: { blocks, allowDuplicate: false } });
  check('批量保存成功', r.status === 200 && r.data.createdCount === 4, JSON.stringify(r.data).slice(0, 160));

  const again = await req('/api/notes/bulk', { method: 'POST', body: { blocks, allowDuplicate: false } });
  check('重复内容被跳过', again.data.createdCount === 0 && again.data.duplicateCount === 4);

  const force = await req('/api/notes/bulk', { method: 'POST', body: { blocks: [blocks[0]], allowDuplicate: true } });
  check('允许重复时可以强制写入', force.data.createdCount === 1);
  if (force.data.created?.[0]) await req(`/api/notes/${force.data.created[0].id}`, { method: 'DELETE' });
}

/* 检索 */
console.log('\n检索与标签');
let list;
{
  const r = await req('/api/notes');
  list = r.data;
  check('列表返回 4 条', r.data.total === 4, `实际 ${r.data.total}`);
  check('自动生成时间标签', r.data.notes[0].tags.some((t) => t.kind === 'time'));

  const byTag = await req('/api/notes?tags=' + encodeURIComponent('心理学'));
  check('按标签筛选', byTag.data.total === 1, `实际 ${byTag.data.total}`);

  const byTopic = await req('/api/notes?topic=' + encodeURIComponent('反脆弱'));
  check('按主题筛选', byTopic.data.total === 1);

  const byQ = await req('/api/notes?q=' + encodeURIComponent('蜡烛'));
  check('全文检索', byQ.data.total === 1);

  const bySyntax = await req('/api/notes?q=' + encodeURIComponent('类型:想法 复利'));
  check('搜索语法 类型:想法 + 关键词', bySyntax.data.total === 1, `实际 ${bySyntax.data.total}`);

  const bySyntax2 = await req('/api/notes?q=' + encodeURIComponent('类型:摘录'));
  check('搜索语法 类型:摘录', bySyntax2.data.total === 2, `实际 ${bySyntax2.data.total}`);

  const byAt = await req('/api/notes?q=' + encodeURIComponent('@反脆弱'));
  check('搜索语法 @主题', byAt.data.total === 1, `实际 ${byAt.data.total}`);
}

/* 分面 */
console.log('\n分面统计');
{
  const r = await req('/api/facets');
  check('分面接口可用', r.status === 200 && r.data.totals.total === 4);
  check('主题列表非空', r.data.topics.length === 3, `实际 ${r.data.topics.length}`);
  check('时间轴非空', r.data.timeline.length >= 2);
  check('标签含时间标签', r.data.tags.some((t) => t.kind === 'time'));
}

/* 分析 */
console.log('\n主题分析');
{
  const r = await req('/api/analyze', { method: 'POST', body: { tags: ['决策', '认知失调'], tagMode: 'any' } });
  check('分析接口可用', r.status === 200 && r.data.scope.noteCount >= 2, JSON.stringify(r.data).slice(0, 120));
  check('提炼出关键词', r.data.keywords?.length > 0);
  check('挑出代表句', r.data.highlights?.length > 0);
}

/* 生成 */
console.log('\n生成读书笔记');
{
  const r = await req('/api/generate', { method: 'POST', body: { tags: ['决策', '认知失调'], tagMode: 'any', title: '#决策', save: false } });
  check('生成接口可用', r.status === 200 && typeof r.data.markdown === 'string');
  const md = r.data.markdown || '';
  check('包含标题', md.startsWith('# #决策 · 读书笔记'));
  check('包含概览', md.includes('## 一、概览'));
  check('包含关键词', md.includes('关键词脉络'));
  check('包含摘录出处', md.includes('> — '));
  check('包含原文索引', md.includes('原始笔记索引'));

  const saved = await req('/api/generate', { method: 'POST', body: { tags: ['决策', '认知失调'], tagMode: 'any', title: '#决策', save: true } });
  check('可以存回系统', !!saved.data.note?.id);
  if (saved.data.note?.id) await req(`/api/notes/${saved.data.note.id}`, { method: 'DELETE' });
}

/* 标签管理 */
console.log('\n标签管理');
{
  const created = await req('/api/tags', { method: 'POST', body: { name: '临时标签', kind: 'topic' } });
  check('新建标签', created.status === 200 && created.data.tag?.id > 0);
  const id = created.data.tag.id;

  const renamed = await req(`/api/tags/${id}`, { method: 'PATCH', body: { name: '临时标签2' } });
  check('重命名标签', renamed.data.tag?.name === '临时标签2');

  const merged = await req('/api/tags/merge', { method: 'POST', body: { from: [id], into: (await req('/api/tags')).data.tags.find((t) => t.name === '心理学').id } });
  check('合并标签', merged.status === 200);
  const after = await req('/api/tags');
  check('被合并的标签已消失', !after.data.tags.some((t) => t.name === '临时标签2'));
}

/* 笔记编辑 */
console.log('\n笔记编辑');
{
  const id = list.notes[0].id;
  const upd = await req(`/api/notes/${id}`, { method: 'PATCH', body: { title: '改过的标题', starred: true } });
  check('更新笔记', upd.data.title === '改过的标题' && upd.data.starred === true);

  const tagged = await req(`/api/notes/${id}/tags`, { method: 'POST', body: { add: ['手动加标签'] } });
  check('加标签', tagged.data.tags.some((t) => t.name === '手动加标签'));

  const untagged = await req(`/api/notes/${id}/tags`, { method: 'POST', body: { remove: ['手动加标签'] } });
  check('移除标签', !untagged.data.tags.some((t) => t.name === '手动加标签'));

  await req(`/api/notes/${id}`, { method: 'PATCH', body: { title: list.notes[0].title, starred: false } });
}

/* 主题与自由类型（走真实的 HTTP 路径，和界面用的是同一套接口） */
console.log('\n主题与自由类型');
{
  const before = (await req('/api/notes')).data.total;

  const created = await req('/api/notes', {
    method: 'POST',
    body: { content: '这条用来验证自由类型。', topic: '自选主题·随便写', kind: '金句', noteDate: '2026-04-01' },
  });
  const made = created.data.created?.[0];
  check('主题可以自由填写', made?.topic === '自选主题·随便写', JSON.stringify(created.data).slice(0, 160));
  check('类型可以自己造词', made?.kind === '金句');
  check('自定义类型的中文标签回退为原文', made?.kindLabel === '金句');
  const customId = made.id;

  const readBack = await req(`/api/notes/${customId}`);
  check('自定义类型能读回来', readBack.data.kind === '金句', JSON.stringify(readBack.data).slice(0, 120));

  const patched = await req(`/api/notes/${customId}`, { method: 'PATCH', body: { kind: '案例复盘' } });
  check('编辑时可以把类型改成别的自由文本', patched.data.kind === '案例复盘');

  const labelPatch = await req(`/api/notes/${customId}`, { method: 'PATCH', body: { kind: '摘录' } });
  check('中文标签会被换算成内置键', labelPatch.data.kind === 'excerpt');

  const byCustom = await req('/api/notes?q=' + encodeURIComponent('类型:金句'));
  check('本类型已被改成别的，所以搜不到了', byCustom.data.total === 0, `实际 ${byCustom.data.total}`);

  await req(`/api/notes/${customId}`, { method: 'PATCH', body: { kind: '金句' } });
  const byCustom2 = await req('/api/notes?q=' + encodeURIComponent('类型:金句'));
  check('按自定义类型检索能命中', byCustom2.data.total === 1, `实际 ${byCustom2.data.total}`);

  const facets = await req('/api/facets');
  check('自定义类型出现在分面统计里', facets.data.kinds.some((k) => k.kind === '金句'));

  await req(`/api/notes/${customId}`, { method: 'DELETE' });
  const after = (await req('/api/notes')).data.total;
  check('删掉之后数量复原', after === before, `${before} → ${after}`);
}

/* 导出 / 设置 */
console.log('\n导出与设置');
{
  const md = await req('/api/export/markdown');
  check('导出 Markdown', md.status === 200 && String(md.text).includes('# 读书笔记全库导出'));
  const json = await req('/api/export/json');
  check('导出 JSON 备份', json.status === 200 && json.data.format === 'reading-notes/v1');
  const csv = await req('/api/export/csv');
  check('导出 CSV', csv.status === 200 && String(csv.text).includes('id,date,title'));

  const s = await req('/api/settings');
  check('读取设置', s.status === 200 && s.data.llm && typeof s.data.llm.configured === 'boolean');
  const patch = await req('/api/settings', { method: 'PATCH', body: { autoTagFromContent: '1' } });
  check('写入设置', patch.status === 200);
}

/* 图片：粘贴图片 → 和文字一起存 */
console.log('\n图片与图文混排');
{
  // 1×1 的红色 PNG，够用来验证字节是否原样存取
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  const up = await req('/api/attachments', {
    method: 'POST',
    body: { dataUrl: `data:image/png;base64,${PNG}`, name: '调度流程图.png', width: 1200, height: 800 },
  });
  check('上传图片', up.status === 200 && !!up.data.attachment?.id, JSON.stringify(up.data).slice(0, 140));
  const url = up.data.attachment?.url;
  check('返回可直接用的地址', typeof url === 'string' && url.startsWith('/api/attachments/'));
  check('记下了原始尺寸', up.data.attachment?.width === 1200 && up.data.attachment?.height === 800);

  const img = await fetch(BASE + url);
  const bytes = Buffer.from(await img.arrayBuffer());
  check('取回图片', img.status === 200 && img.headers.get('content-type') === 'image/png');
  check('字节原样返回', bytes.length === up.data.attachment.bytes && bytes.subarray(0, 4).toString('hex') === '89504e47');
  check('图片带长期缓存头', String(img.headers.get('cache-control')).includes('immutable'));

  const missing = await fetch(`${BASE}/api/attachments/zzzzzzzzzzzz`);
  check('不存在的图片返回 404', missing.status === 404);

  /* 一条笔记：文字 + 图片 + 文字 */
  const saved = await req('/api/notes', {
    method: 'POST',
    body: { content: `这张图是调度流程：\n\n![](${url})\n\n图下面是当时的说明文字。`, noteDate: '2026-04-02', topic: '智能调度' },
  });
  const note = saved.data.created?.[0];
  check('图文一起保存成一条笔记', !!note && note.content.includes(url), JSON.stringify(saved.data).slice(0, 140));

  const meta = await req(`${url}/meta`);
  check('图片归属到这条笔记', meta.data.attachment?.noteId === note.id);

  const gcKeep = await req('/api/attachments/gc', { method: 'POST', body: { graceDays: 0 } });
  check('有人引用的图片不会被清理', gcKeep.data.removed === 0, JSON.stringify(gcKeep.data));

  /* 没人引用的图片会被回收 */
  const junk = await req('/api/attachments', { method: 'POST', body: { data: PNG, mime: 'image/png', name: '没人要.png' } });
  const gcDrop = await req('/api/attachments/gc', { method: 'POST', body: { graceDays: 0 } });
  check('没人引用的图片会被清理', gcDrop.data.removed === 1, JSON.stringify(gcDrop.data));
  const gone = await fetch(BASE + junk.data.attachment.url);
  check('清理之后就取不到了', gone.status === 404);

  /* 宽限期：刚粘进来还没保存的图不能被误删 */
  const draft = await req('/api/attachments', { method: 'POST', body: { data: PNG, mime: 'image/png' } });
  await req('/api/attachments/gc', { method: 'POST', body: { graceDays: 7 } });
  const draftStill = await fetch(BASE + draft.data.attachment.url);
  check('7 天宽限期内不会误删草稿图', draftStill.status === 200);

  /* 非图片一律拒绝 */
  const bad = await req('/api/attachments', {
    method: 'POST',
    body: { data: Buffer.from('这不是图片').toString('base64'), mime: 'text/plain' },
  });
  check('拒绝非图片类型', bad.status === 400 && String(bad.data.error).includes('不支持'), JSON.stringify(bad.data));

  /* 删除：没人用的能删，还被引用的不能删 */
  const inUse = await req(`/api/attachments/${url.split('/').pop()}`, { method: 'DELETE' });
  check('还被笔记引用的图片拒绝删除', inUse.status === 400 && String(inUse.data.error).includes('引用'), JSON.stringify(inUse.data));
  const stillThere = await fetch(BASE + url);
  check('拒绝之后图片还在', stillThere.status === 200);

  const spare = await req('/api/attachments', { method: 'POST', body: { data: PNG, mime: 'image/png' } });
  const spareUrl = spare.data.attachment.url;
  const del = await req(`/api/attachments/${spareUrl.split('/').pop()}`, { method: 'DELETE' });
  check('没人用的图片可以直接删掉', del.status === 200 && del.data.deleted === true);
  check('删掉之后就取不到了', (await fetch(BASE + spareUrl)).status === 404);
  check('删不存在的图片返回 404', (await req('/api/attachments/zzzzzzzzzzzz', { method: 'DELETE' })).status === 404);

  /* 导出：Markdown 内嵌图片，JSON 备份带图片 */
  const md = await req('/api/export/markdown');
  check('Markdown 导出把图片内嵌进去', String(md.text).includes('data:image/png;base64,'));
  check('Markdown 导出标注了图片张数', String(md.text).includes('张图片'));

  const json = await req('/api/export/json');
  check('JSON 备份带上图片', Array.isArray(json.data.attachments) && json.data.attachments.length >= 1);
  check('备份里的图片是 base64', typeof json.data.attachments[0].data === 'string' && json.data.attachments[0].data.length > 20);

  /* 笔记删掉之后，图片变成孤儿，应被回收 */
  await req(`/api/notes/${note.id}`, { method: 'DELETE' });
  const gcAfter = await req('/api/attachments/gc', { method: 'POST', body: { graceDays: 0 } });
  check('笔记删掉后图片会被回收', gcAfter.data.removed >= 1, JSON.stringify(gcAfter.data));
}

/* 错误处理 */
console.log('\n错误处理');
{
  const notFound = await req('/api/notes/999999');
  check('不存在的笔记返回 404', notFound.status === 404);
  const badJson = await fetch(`${BASE}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  check('非法 JSON 返回 4xx', badJson.status >= 400 && badJson.status < 500);
  const empty = await req('/api/notes/bulk', { method: 'POST', body: { blocks: [{ content: '   ' }] } });
  check('空内容被拒绝但不崩溃', empty.status === 200 && empty.data.failed.length === 1);
  const noScope = await req('/api/generate', { method: 'POST', body: { tags: ['不存在的主题'] } });
  check('空范围生成给出友好错误', noScope.status === 400 && String(noScope.data.error).includes('没有笔记'));
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
const code = fail ? 1 : 0;
if (!fail) console.log('  端到端全部通过 ✅');
await cleanup();
process.exit(code);