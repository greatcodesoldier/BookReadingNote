/**
 * 端到端冒烟测试：node --no-warnings test/smoke.mjs
 * 覆盖 解析 → 入库 → 标签 → 检索 → 分析 → 生成读书笔记 → 导出/导入 全链路。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, extractInlineTags } from '../src/db.js';
import { parsePaste } from '../src/parse.js';
import { analyzeTopic, renderReadingNote, extractKeywords } from '../src/analyze.js';
import { parseSearchQuery } from '../src/api.js';
import { resolveLLM } from '../src/llm.js';
import { timeTagNames, toDateStr, isoWeek } from '../src/util.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const out = fn();
    /* 故意挡住「把 async 函数交给同步 test」这种写法：
       那样 fn() 只返回一个 Promise，断言其实一条都没跑，
       然后这里会把它当成「通过」—— 测试就变成了假绿灯。 */
    if (out && typeof out.then === 'function') {
      throw new Error('用例不能是 async：请把 await import 换成顶部的静态 import，否则断言不会被执行');
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
  }
}

/*
 * 这个文件里的用例**全部是同步的**（需要的东西都在顶部 import 好了）。
 * 原因：如果往同步的 test() 里塞一个 async 函数，fn() 只会返回一个 Promise，
 * 断言其实一条都没跑，却会被记成「通过」，而且结果要等汇总之后才打印、
 * 甚至被 process.exit 掐掉 —— 那就是假绿灯。下面加了拦截，别绕过它。
 */
function section(title) {
  console.log(`\n${title}`);
}

/* ================================================================== 工具函数 */

section('工具函数');

test('toDateStr 支持多种写法', () => {
  assert.equal(toDateStr('2026-03-05'), '2026-03-05');
  assert.equal(toDateStr('2026/3/5'), '2026-03-05');
  assert.equal(toDateStr('2026年3月5日'), '2026-03-05');
  assert.equal(toDateStr('2026-03'), '2026-03-01');
  assert.equal(toDateStr('乱写'), null);
});

test('时间标签包含年/月/周', () => {
  const tags = timeTagNames('2026-03-05');
  assert.equal(tags[0], '2026年');
  assert.equal(tags[1], '2026-03');
  assert.match(tags[2], /^2026-W\d{2}$/);
  assert.equal(isoWeek(new Date('2026-03-05T00:00:00')), 10);
});

test('extractInlineTags 不把 Markdown 标题当标签', () => {
  assert.deepEqual(extractInlineTags('# 这是标题'), []);
  assert.deepEqual(extractInlineTags('一段话 #心理学 结束'), ['心理学']);
  assert.deepEqual(extractInlineTags('#认知 #决策'), ['认知', '决策']);
  assert.deepEqual(extractInlineTags('第 3 页 #2024'), []);
});

/* ================================================================== 粘贴解析 */

section('粘贴解析引擎');

const SAMPLE = `#心理学 #认知
《思考，快与慢》 作者：丹尼尔·卡尼曼
类型：摘录
页码：P32
> 直觉是有代价的：它让我们在熟悉的情境里高效，在陌生的情境里自信地犯错。
---
今天读到系统1和系统2的分工，感觉和认知失调能连起来 #认知失调
---
《思考，快与慢》
疑问：锚定效应为什么在完全无关的数字上依然有效？
---
## 反脆弱
摘录：风会熄灭蜡烛，却能使火越烧越旺。
来源：反脆弱
日期：2026-02-11`;

const parsed = parsePaste(SAMPLE, { defaultDate: '2026-03-01' });

test('按 --- 分隔出 4 条笔记', () => {
  assert.equal(parsed.blocks.length, 4);
});

test('第 1 条：主题/作者/页码/类型/标签都识别出来', () => {
  const b = parsed.blocks[0];
  assert.equal(b.topic, '思考，快与慢');
  assert.equal(b.author, '丹尼尔·卡尼曼');
  assert.equal(b.location, 'P32');
  assert.equal(b.kind, 'excerpt');
  assert.deepEqual(b.tags.sort(), ['心理学', '认知'].sort());
  assert.ok(b.content.includes('直觉是有代价的'));
  assert.ok(!b.content.includes('页码'), '元信息行不应留在正文里');
});

test('第 2 条：正文里的行内 #标签 被提取', () => {
  const b = parsed.blocks[1];
  assert.ok(b.tags.includes('认知失调'));
  assert.equal(b.topic, '');
});

test('第 3 条：疑问类型 + 书名作为主题', () => {
  const b = parsed.blocks[2];
  assert.equal(b.kind, 'question');
  assert.equal(b.topic, '思考，快与慢');
  assert.ok(!b.content.includes('《思考，快与慢》'), '单独的书名行应被吸收为主题');
});

test('第 4 条：Markdown 标题作标题 + 显式日期', () => {
  const b = parsed.blocks[3];
  assert.equal(b.title, '反脆弱');
  assert.equal(b.topic, '反脆弱');
  assert.equal(b.noteDate, '2026-02-11');
  assert.equal(b.kind, 'excerpt');
});

test('老写法「来源：」仍然能解析成主题（向后兼容）', () => {
  const r = parsePaste('来源：得到\n真正的损失不是已经付出的。', { defaultDate: '2026-03-01' });
  assert.equal(r.blocks[0].topic, '得到');
});

test('「主题：」是首选写法，且优先级高于「来源：」', () => {
  const r = parsePaste('主题：决策\n正文一句话。', { defaultDate: '2026-03-01' });
  assert.equal(r.blocks[0].topic, '决策');

  const both = parsePaste('主题：决策\n来源：得到\n正文一句话。', { defaultDate: '2026-03-01' });
  assert.equal(both.blocks[0].topic, '决策', '同一批元信息里先出现的主题优先');
});

test('类型可以写成自定义的词', () => {
  /* 内置的 5 种仍然按关键词自动识别 */
  const builtin = parsePaste('摘录：风会熄灭蜡烛，却能使火越烧越旺。', { defaultDate: '2026-03-01' });
  assert.equal(builtin.blocks[0].kind, 'excerpt');

  /* 自己造的类型用显式的「类型：」写，原样保留 */
  const custom = parsePaste('类型：金句\n风会熄灭蜡烛，却能使火越烧越旺。', { defaultDate: '2026-03-01' });
  assert.equal(custom.blocks[0].kind, '金句', '显式写的类型原样保留');

  /* 任意「Xxx：」不会被当成类型，避免「注意：」「正文：」这类误判 */
  const notKind = parsePaste('注意：这段话明天要再看一遍。', { defaultDate: '2026-03-01' });
  assert.equal(notKind.blocks[0].kind, 'idea', '没显式声明类型时不会瞎猜');
});

test('显式写的「主题：」「类型：」能盖过自动推测出来的值', () => {
  /* 这个形状很常见：书名行 + 摘录行 + 后面补一句主题和类型 */
  const r = parsePaste(
    ['《反脆弱》 P61', '摘录：风会熄灭蜡烛，却能使火越烧越旺。', '主题：不确定性', '类型：金句'].join('\n'),
    { defaultDate: '2026-03-01' },
  );
  const b = r.blocks[0];
  assert.equal(b.topic, '不确定性', '显式的主题应盖过从《书名》推测出来的');
  assert.equal(b.kind, '金句', '显式的类型应盖过从「摘录：」推测出来的');
  assert.equal(b.location, 'P61', '位置仍然从书名行里取到');
  assert.ok(b.content.includes('风会熄灭蜡烛'), '正文没丢');
  assert.ok(!b.content.includes('主题：'), '元信息行不应留在正文里');

  /* 同名字段仍然「第一个显式值胜出」 */
  const two = parsePaste('主题：决策\n主题：认知\n正文。', { defaultDate: '2026-03-01' });
  assert.equal(two.blocks[0].topic, '决策');
});

test('forceSingle 把整段当成一条', () => {
  const one = parsePaste(SAMPLE, { forceSingle: true, defaultDate: '2026-03-01' });
  assert.equal(one.blocks.length, 1);
});

test('空输入不产生笔记', () => {
  assert.equal(parsePaste('   \n\n  ').blocks.length, 0);
});

test('普通长句不会把首行误当标题而丢失内容', () => {
  const p = parsePaste('这是一句比较长的、带有完整语义的话，它描述了一件具体的事情，不应当被当作标题处理。');
  assert.equal(p.blocks.length, 1);
  assert.ok(p.blocks[0].content.includes('不应当被当作标题'));
});

test('图片行不会打断元信息识别（末尾的「日期：」不会漏进正文）', () => {
  const p = parsePaste([
    '#反脆弱',
    '《反脆弱》 P61',
    '摘录：一句话。',
    '![](/api/attachments/abc123XYZ)',
    '日期：2026-03-20',
  ].join('\n'));
  const b = p.blocks[0];
  assert.equal(b.noteDate, '2026-03-20', '日期仍要被识别出来');
  assert.ok(b.content.includes('![](/api/attachments/abc123XYZ)'), '图片要留在正文里');
  assert.ok(!b.content.includes('日期：'), '日期那一行不该留在正文里');
});

test('图片后面的正文不会被当成元信息吃掉', () => {
  const p = parsePaste([
    '摘录：一句话。',
    '![](/api/attachments/abc123XYZ)',
    '后面这些话是正文，一个字都不能少。',
    '日期：2026-03-20',
  ].join('\n'));
  const b = p.blocks[0];
  assert.ok(b.content.includes('后面这些话是正文，一个字都不能少。'), '正文要完整保留');
  assert.ok(b.content.includes('![](/api/attachments/abc123XYZ)'));
});

test('一整条只有图片也不会变成空笔记', () => {
  const p = parsePaste(['![](/api/attachments/abc123XYZ)', '日期：2026-03-20'].join('\n'));
  const b = p.blocks[0];
  assert.ok(b.content.includes('/api/attachments/abc123XYZ'), '只贴一张图也要能存下来');
  assert.equal(b.noteDate, '2026-03-20');
});

/* ================================================================== 入库与标签 */

section('入库与标签');

const store = createStore(':memory:');
const saved = store.notes.create(
  { ...parsed.blocks[0], tags: parsed.blocks[0].tags, tagsAuto: true },
  { allowDuplicate: true },
);
store.notes.create({ ...parsed.blocks[1], tags: parsed.blocks[1].tags, tagsAuto: true }, { allowDuplicate: true });
store.notes.create({ ...parsed.blocks[2], tags: parsed.blocks[2].tags, tagsAuto: true }, { allowDuplicate: true });

test('保存后可以读回', () => {
  assert.equal(saved.note.id, 1);
  assert.equal(store.notes.get(1).topic, '思考，快与慢');
});

test('自动生成时间标签', () => {
  const note = store.notes.get(1);
  const timeTags = note.tags.filter((t) => t.kind === 'time').map((t) => t.name);
  assert.ok(timeTags.includes('2026年'), `期望包含 2026年，实际 ${timeTags}`);
  assert.ok(timeTags.includes('2026-03'));
  assert.equal(timeTags.length, 3);
});

test('主题标签被保存', () => {
  const names = store.notes.get(1).tags.map((t) => t.name);
  assert.ok(names.includes('心理学'));
  assert.ok(names.includes('认知'));
});

test('判重：相同内容 + 相同主题会被识别', () => {
  const res = store.notes.create({ ...parsed.blocks[0], tags: [] }, { allowDuplicate: false });
  assert.equal(res.duplicate, true);
  assert.equal(res.note.id, 1);
});

test('手动移除的自动标签不会在保存时被加回来', () => {
  const note = store.notes.get(1);
  store.notes.removeTags(1, ['认知']);
  assert.ok(!store.notes.get(1).tags.some((t) => t.name === '认知'));
  store.notes.update(1, { content: `${store.notes.get(1).content}\n补充一句 #认知。` });
  assert.ok(!store.notes.get(1).tags.some((t) => t.name === '认知'), '被抑制的标签不应复活');
  store.notes.addTags(1, ['认知']);
  assert.ok(store.notes.get(1).tags.some((t) => t.name === '认知'));
});

test('修改日期会同步时间标签', () => {
  store.notes.update(3, { noteDate: '2025-12-20' });
  const names = store.notes.get(3).tags.filter((t) => t.kind === 'time').map((t) => t.name);
  assert.ok(names.includes('2025年'));
  assert.ok(!names.includes('2026年'), '旧的时间标签应被移除');
  store.notes.update(3, { noteDate: '2026-03-01' });
});

/* ================================================================== 自由类型 / 主题 */

section('主题字段与自由类型');

test('主题可以随便填，不受任何枚举限制', () => {
  const res = store.notes.create({
    title: '主题随便写', content: '主题字段是完全自由的。', topic: '我自己的分类·随便写的东西',
    noteDate: '2026-03-08', kind: 'idea',
  }, { allowDuplicate: true });
  assert.equal(res.note.topic, '我自己的分类·随便写的东西');
});

test('类型可以自己造词并原样存下来', () => {
  const res = store.notes.create({
    title: '金句一条', content: '这类句子值得单独存起来。', kind: '金句', noteDate: '2026-03-08',
  }, { allowDuplicate: true });
  assert.equal(res.note.kind, '金句');
  assert.equal(store.notes.get(res.note.id).kind, '金句', '读回来仍然是「金句」');
  assert.equal(res.note.kindLabel, '金句', '取不到内置中文标签就原样显示');
});

test('内置类型的中文标签会被换算回内置键', () => {
  const res = store.notes.create({
    title: '类型写中文', content: '类型字段手打了中文。', kind: '摘录', noteDate: '2026-03-08',
  }, { allowDuplicate: true });
  assert.equal(res.note.kind, 'excerpt');
  assert.equal(res.note.kindLabel, '摘录');
});

test('类型两边空白会被去掉，过长会被截断', () => {
  const res = store.notes.create({
    title: '类型规整', content: '规整一下类型。', kind: '   案例  ', noteDate: '2026-03-08',
  }, { allowDuplicate: true });
  assert.equal(res.note.kind, '案例');

  const long = store.notes.create({
    title: '类型太长', content: '太长的类型会被截断。', kind: 'x'.repeat(50), noteDate: '2026-03-08',
  }, { allowDuplicate: true });
  assert.equal(long.note.kind.length, 16);
});

test('类型留空时退回默认的「想法」', () => {
  const res = store.notes.create({
    title: '没填类型', content: '没有填类型。', noteDate: '2026-03-08',
  }, { allowDuplicate: true });
  assert.equal(res.note.kind, 'idea');
});

test('编辑时也能把类型改成任意文字，也可以清空', () => {
  const res = store.notes.create({
    title: '改类型', content: '稍后改类型。', kind: 'idea', noteDate: '2026-03-08',
  }, { allowDuplicate: true });
  const id = res.note.id;

  assert.equal(store.notes.update(id, { kind: '待验证的猜测' }).kind, '待验证的猜测');
  assert.equal(store.notes.update(id, { kind: '疑问' }).kind, 'question', '中文标签换算成内置键');
  assert.equal(store.notes.update(id, { kind: '' }).kind, 'idea', '清空后退回默认值');
  // 最后落在自定义类型上，顺便避免多出一条内置「疑问」影响后面的统计断言
  assert.equal(store.notes.update(id, { kind: '案例' }).kind, '案例');
  assert.equal(store.notes.update(id, { title: '只改标题' }).kind, '案例', '没传 kind 时不受影响');
});

test('自定义类型会出现在分面统计里，中文标签回退为原文', () => {
  const kinds = store.facets().kinds;
  assert.ok(kinds.some((k) => k.kind === '金句'), '自定义类型应被统计到');
  assert.ok(kinds.some((k) => k.kind === 'excerpt'));
});

test('按自定义类型检索可行', () => {
  const q = parseSearchQuery('类型:金句');
  assert.deepEqual(q.kinds, ['金句']);
  const list = store.notes.list({ kinds: q.kinds, includeArchived: true });
  assert.ok(list.total >= 1, '应该能搜到自定义类型的笔记');
  assert.ok(list.notes.every((n) => n.kind === '金句'));

  assert.deepEqual(parseSearchQuery('类型:摘录').kinds, ['excerpt'], '中文标签仍然换算成内置键');
});

/* ================================================================== 检索 */

section('检索与过滤');

store.notes.create({
  title: '反脆弱的一句', content: '风会熄灭蜡烛，却能使火越烧越旺。', topic: '反脆弱',
  author: '塔勒布', kind: 'excerpt', noteDate: '2026-02-11', tags: ['反脆弱', '复杂性'],
}, { allowDuplicate: true });
store.notes.create({
  title: '关于习惯', content: '习惯是自我提高的复利。', topic: '原子习惯',
  kind: 'excerpt', noteDate: '2026-01-15', starred: true, tags: ['习惯'],
}, { allowDuplicate: true });

test('全文检索命中标题与正文', () => {
  assert.equal(store.notes.list({ q: '蜡烛' }).total, 1);
  assert.equal(store.notes.list({ q: '习惯' }).total, 1);
});

test('按标签过滤（all / any 语义）', () => {
  assert.equal(store.notes.list({ tags: ['心理学'] }).total, 1);
  assert.equal(store.notes.list({ tags: ['心理学', '认知'], tagMode: 'all' }).total, 1);
  assert.equal(store.notes.list({ tags: ['认知'], tagMode: 'any' }).total, 1);
  assert.equal(store.notes.list({ tags: ['心理学', '习惯'], tagMode: 'any' }).total, 2);
  assert.equal(store.notes.list({ tags: ['心理学', '习惯'], tagMode: 'all' }).total, 0);
});

test('按主题 / 类型 / 日期区间过滤', () => {
  assert.equal(store.notes.list({ topic: '反脆弱' }).total, 1);
  assert.equal(store.notes.list({ kinds: ['question'] }).total, 1);
  assert.equal(store.notes.list({ from: '2026-02-01', to: '2026-02-28' }).total, 1);
  assert.equal(store.notes.list({ starred: true }).total, 1);
});

test('搜索语法解析', () => {
  const f = parseSearchQuery('#心理学 @思考 类型:摘录 after:2026-01-01 星标 正文');
  assert.deepEqual(f.tags, ['心理学']);
  assert.equal(f.topic, '思考');
  assert.deepEqual(f.kinds, ['excerpt']);
  assert.equal(f.from, '2026-01-01');
  assert.equal(f.starred, true);
  assert.equal(f.q, '正文');
});

test('date:2026-02 展开成整月区间', () => {
  const f = parseSearchQuery('date:2026-02');
  assert.equal(f.from, '2026-02-01');
  assert.equal(f.to, '2026-02-28');
});

test('分面统计可用', () => {
  const f = store.facets();
  assert.ok(f.totals.total >= 5);
  assert.ok(f.topics.some((s) => s.name === '反脆弱'));
  assert.ok(f.timeline.length >= 2);
  assert.ok(f.kinds.length >= 2);
});

/* ================================================================== 标签管理 */

section('标签管理');

test('重命名标签', () => {
  const tag = store.tags.byName('复杂性');
  store.tags.update(tag.id, { name: '复杂系统' });
  assert.ok(store.tags.byName('复杂系统'));
  assert.equal(store.tags.byName('复杂性'), null);
});

test('同名重命名自动合并', () => {
  const a = store.tags.create({ name: '临时A' });
  store.notes.addTags(4, ['临时A']);
  store.tags.update(a.id, { name: '反脆弱' });
  const names = store.notes.get(4).tags.map((t) => t.name);
  assert.ok(names.includes('反脆弱'));
});

test('合并标签', () => {
  const from = store.tags.create({ name: '待合并' });
  store.notes.addTags(4, ['待合并']);
  const into = store.tags.byName('反脆弱');
  store.tags.merge([from.id], into.id);
  assert.equal(store.tags.byName('待合并'), null);
  assert.ok(store.notes.get(4).tags.some((t) => t.id === into.id));
});

/* ================================================================== 分析 */

section('主题分析与读书笔记生成');

const scope = store.notes.list({ tags: ['认知', '认知失调'], tagMode: 'any', limit: 100 }).notes;

test('分析结果包含概览/关键词/代表句', () => {
  const a = analyzeTopic(scope, { scope: { tags: ['认知'] } });
  assert.equal(a.scope.noteCount, scope.length);
  assert.ok(a.scope.noteCount >= 2, `范围过小：${a.scope.noteCount}`);
  assert.ok(a.scope.topics.length >= 1);
  assert.ok(a.keywords.length > 0, '应能提炼出关键词');
  assert.ok(a.highlights.length > 0, '应能挑出代表句');
  assert.ok(a.themes.length > 0, '应有共现主题');
});

test('关键词过滤掉常见虚词', () => {
  const kws = extractKeywords(scope, { limit: 20 }).map((k) => k.term);
  for (const bad of ['的', '一个', '我们', '可以']) assert.ok(!kws.includes(bad), `不该出现 ${bad}`);
});

test('生成的读书笔记结构完整', () => {
  const a = analyzeTopic(scope, { scope: { tags: ['心理学'] } });
  const md = renderReadingNote(a, { title: '#心理学' });
  assert.ok(md.startsWith('# #心理学 · 读书笔记'));
  assert.ok(md.includes('## 一、概览'));
  assert.ok(md.includes('关键词脉络'));
  assert.ok(md.includes('核心摘录'));
  assert.ok(md.includes('原始笔记索引'));
  assert.ok(md.includes('> — '), '摘录应带出处');
  assert.ok(md.includes('2026-03-01'), '应带日期');
});

test('生成的读书笔记可以再存回系统', () => {
  const a = analyzeTopic(scope, { scope: { tags: ['心理学'] } });
  const md = renderReadingNote(a, { title: '#心理学' });
  const res = store.notes.create({ title: '#心理学 · 读书笔记', content: md, kind: 'summary', tags: ['心理学', '读书笔记'] });
  assert.ok(res.note.id > 0);
  assert.ok(store.notes.get(res.note.id).content.includes('读书笔记'));
});

/* ================================================================== 导入导出 */

section('备份与导入导出');

test('导出 → 清空 → 导入，内容一致', () => {
  const dump = store.io.exportAll();
  assert.ok(dump.notes.length >= 6);
  assert.equal(dump.format, 'reading-notes/v1');

  const fresh = createStore(':memory:');
  const res = fresh.io.importAll(dump, { mode: 'skip' });
  assert.equal(res.created, dump.notes.length);
  const again = fresh.io.exportAll();
  assert.equal(again.notes.length, dump.notes.length);

  const before = dump.notes.find((n) => n.topic === '反脆弱');
  const after = again.notes.find((n) => n.topic === '反脆弱');
  assert.equal(after.content, before.content);
  assert.equal(after.noteDate, before.noteDate);
  assert.ok(after.tags.some((t) => t.name === '反脆弱'), '标签应随备份一起还原');
});

test('重复导入会被跳过', () => {
  const dump = store.io.exportAll();
  const fresh = createStore(':memory:');
  fresh.io.importAll(dump);
  const second = fresh.io.importAll(dump);
  assert.equal(second.created, 0);
  assert.equal(second.skipped, dump.notes.length);
});

/* ================================================================== 图片附件 */

section('图片附件（图文一起存）');

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('图片存进去能原样取回来', () => {
  const att = store.attachments.put({ data: TINY_PNG, mime: 'image/png', name: '截图.png', width: 1200, height: 800 });
  assert.ok(att.id, '应该有 id');
  assert.equal(att.url, `/api/attachments/${att.id}`);
  assert.equal(att.mime, 'image/png');
  assert.equal(att.width, 1200);

  const back = store.attachments.data(att.id);
  assert.ok(back, '应该能取回字节');
  assert.equal(back.mime, 'image/png');
  assert.equal(back.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 文件头要对得上');
  assert.equal(back.bytes, Buffer.from(TINY_PNG, 'base64').length);
});

test('data URL 形式的上传也能认', () => {
  const att = store.attachments.put({ dataUrl: `data:image/png;base64,${TINY_PNG}` });
  assert.equal(att.mime, 'image/png');
  assert.equal(store.attachments.data(att.id).bytes, Buffer.from(TINY_PNG, 'base64').length);
});

test('只收图片，其它类型一律拒绝', () => {
  assert.throws(() => store.attachments.put({ data: Buffer.from('hello').toString('base64'), mime: 'text/plain' }), /不支持/);
  assert.throws(() => store.attachments.put({ data: TINY_PNG, mime: 'application/pdf' }), /不支持/);
  assert.throws(() => store.attachments.put({ data: '', mime: 'image/png' }), /空/);
});

test('超过大小上限的图片会被拒绝', () => {
  const big = 'A'.repeat(Math.ceil((13 * 1024 * 1024) / 3) * 4); // 约 13MB
  assert.throws(() => store.attachments.put({ data: big, mime: 'image/png' }), /太大/);
});

test('文字和图片一起保存成一条笔记', () => {
  const att = store.attachments.put({ data: TINY_PNG, mime: 'image/png', name: '流程图.png' });
  const res = store.notes.create({
    title: '图文混排', topic: '智能调度', noteDate: '2026-03-12',
    content: `这张图是调度流程：\n\n![](${att.url})\n\n图下面是说明文字。`,
  }, { allowDuplicate: true });
  assert.equal(res.note.content.includes(att.url), true, '正文里应保留图片引用');
  assert.equal(store.attachments.meta(att.id).noteId, res.note.id, '图片应归属到这条笔记');
});

test('编辑笔记新增的图片也会被认领', () => {
  const att = store.attachments.put({ data: TINY_PNG, mime: 'image/png' });
  const note = store.notes.create({ title: '稍后补图', content: '先写文字，图以后再补。', noteDate: '2026-03-12' }, { allowDuplicate: true }).note;
  assert.equal(store.attachments.meta(att.id).noteId, null);
  store.notes.update(note.id, { content: `先写文字，图以后再补。\n\n![](${att.url})` });
  assert.equal(store.attachments.meta(att.id).noteId, note.id);
});

test('清理时有人引用的图片不会被动，没人用的才删', () => {
  // 用一个干净的库：清理的断言要精确，不能把前面用例留下的孤儿图算进来
  const s = createStore(':memory:');
  const kept = s.attachments.put({ data: TINY_PNG, mime: 'image/png' });
  s.notes.create({ content: `留着\n\n![](${kept.url})`, noteDate: '2026-03-12' }, { allowDuplicate: true });
  const junk = s.attachments.put({ data: TINY_PNG, mime: 'image/png' });

  const swept = s.attachments.gc({ graceDays: 0 });
  assert.equal(swept.removed, 1, '只该删掉那一张没人用的');
  assert.ok(s.attachments.meta(kept.id), '被引用的图必须留着');
  assert.equal(s.attachments.meta(junk.id), null, '没人用的图应该没了');
});

test('宽限期内的新图片不会被误删（保护还没保存的草稿）', () => {
  const s = createStore(':memory:');
  const draft = s.attachments.put({ data: TINY_PNG, mime: 'image/png' });
  const swept = s.attachments.gc({ graceDays: 7 });
  assert.equal(swept.removed, 0);
  assert.ok(s.attachments.meta(draft.id), '刚粘进来还没保存的图不能被删掉');
});

test('同一张图被两条笔记引用时，删掉一条不会把图删掉', () => {
  const s = createStore(':memory:');
  const att = s.attachments.put({ data: TINY_PNG, mime: 'image/png' });
  const a = s.notes.create({ content: `第一份\n\n![](${att.url})`, noteDate: '2026-03-12' }, { allowDuplicate: true }).note;
  const b = s.notes.create({ content: `第二份\n\n![](${att.url})`, noteDate: '2026-03-12' }, { allowDuplicate: true }).note;
  s.notes.delete(a.id);
  const swept = s.attachments.gc({ graceDays: 0 });
  assert.equal(swept.removed, 0, '另一条笔记还在用，不能删');
  assert.ok(s.attachments.meta(att.id));
  assert.ok(s.notes.get(b.id));
});

test('导出备份带上图片，导入后图还在且仍指向同一条笔记', () => {
  const att = store.attachments.put({ data: TINY_PNG, mime: 'image/png', name: '结构图.png' });
  const note = store.notes.create({
    title: '备份里的图', topic: '备份测试', noteDate: '2026-03-13',
    content: `说明文字\n\n![](${att.url})`,
  }, { allowDuplicate: true }).note;

  const dump = store.io.exportAll();
  const mine = dump.attachments.find((a) => a.id === att.id);
  assert.ok(mine, '备份里应该有这张图');
  assert.equal(typeof mine.data, 'string');
  assert.equal(Buffer.from(mine.data, 'base64').length, Buffer.from(TINY_PNG, 'base64').length);

  const fresh = createStore(':memory:');
  const res = fresh.io.importAll(dump, { mode: 'skip' });
  assert.ok(res.attachments >= 1, '图片也要被导入');
  const restored = fresh.notes.list({ q: '说明文字' }).notes[0];
  assert.ok(restored, '笔记应被导入');
  assert.equal(restored.content.includes(att.url), true, '正文里的引用不变');
  assert.ok(fresh.attachments.data(att.id), '图片字节应能取到');
  assert.equal(fresh.attachments.meta(att.id).noteId, restored.id, '导入后也要认领到笔记');
});

test('统计里能看到图片数量和占用空间', () => {
  const s = store.stats();
  assert.equal(typeof s.attachments, 'number');
  assert.ok(s.attachments >= 1);
  assert.ok(s.attachmentBytes >= Buffer.from(TINY_PNG, 'base64').length);
});

/* ================================================================== 前端渲染工具 */

section('前端 Markdown 渲染（mdLite）');

const { mdLite } = await import('../public/js/util.js');

test('以 #标签 开头的行不会造成死循环', () => {
  // 这正是把浏览器卡死的输入：# 后面没有空格，不算标题
  const out = mdLite('#心理学 #决策\n正文一句话。');
  assert.ok(out.includes('#心理学 #决策'));
  assert.ok(out.includes('正文一句话'));
});

test('引用 / 标题 / 列表 / 代码块都能渲染', () => {
  assert.ok(mdLite('> 一句引用').includes('<blockquote>'));
  assert.ok(mdLite('# 大标题').includes('<h3>'));
  assert.ok(mdLite('## 小标题').includes('<h4>'));
  assert.ok(mdLite('- 甲\n- 乙').includes('<ul>'));
  assert.ok(mdLite('1. 甲\n2. 乙').includes('<ol>'));
  assert.ok(mdLite('```\ncode\n```').includes('<pre><code>'));
});

test('只含标记字符的输入也能结束', () => {
  for (const t of ['>', '#', '-', '1.', '```', '#', '>\n>', '- \n- ', '<script>']) {
    assert.equal(typeof mdLite(t), 'string', `输入 ${JSON.stringify(t)} 未正常返回`);
  }
});

test('转义 HTML，避免 XSS', () => {
  const out = mdLite('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
});

test('混合内容渲染不丢行', () => {
  const src = '#标题\n正文\n> 引用\n- 项目\n#标签\n结尾';
  const out = mdLite(src);
  for (const piece of ['#标题', '正文', '引用', '项目', '#标签', '结尾']) {
    assert.ok(out.includes(piece), `缺少 ${piece}`);
  }
});

test('图片会被渲染成 <img>，并且单独成块', () => {
  const out = mdLite('看这张图\n\n![](/api/attachments/AbC123xyz)\n\n下面是说明');
  assert.ok(out.includes('<img src="/api/attachments/AbC123xyz"'), '应渲染成 img');
  assert.ok(out.includes('loading="lazy"'), '图片应该懒加载');
  assert.ok(out.includes('class="md-img"'), '整行图片应单独成块');
  assert.ok(out.includes('看这张图') && out.includes('下面是说明'));
});

test('data:image 图片也能渲染（Markdown 导出的内嵌格式）', () => {
  const out = mdLite('![](data:image/png;base64,iVBORw0KGgo=)');
  assert.ok(out.includes('<img src="data:image/png;base64,'));
});

test('不认识的图片来源不会被当成图片', () => {
  const out = mdLite('![](javascript:alert(1))');
  assert.ok(!out.includes('<img'), '不能渲染成 img');
  assert.ok(out.includes('javascript:alert(1)'), '原样显示，不丢内容');
});

test('图片标记不会被链接规则抢走（不留下孤零零的 !）', () => {
  const out = mdLite('![](/api/attachments/AbC123xyz)');
  assert.ok(!out.includes('!['), '不应留下 Markdown 残留');
  assert.ok(!out.includes('<a '), '不应被当成链接');
});

test('正文里夹着的图片也能渲染', () => {
  const out = mdLite('前面 ![示意图](/api/attachments/AbC123xyz) 后面');
  assert.ok(out.includes('<img src="/api/attachments/AbC123xyz"'));
  assert.ok(out.includes('前面') && out.includes('后面'));
});

test('只含图片的正文也能结束（不会死循环）', () => {
  assert.ok(mdLite('![](').length >= 0);
  assert.ok(mdLite('![]()').length >= 0);
  assert.ok(mdLite('![](/api/attachments/x)').includes('md-img') || mdLite('![](/api/attachments/x)').includes('<p>'));
});

/* ================================================================== LLM（无 Key 时降级） */

test('未配置 API Key 时生成流程不报错', () => {
  const config = resolveLLM(store);
  assert.equal(typeof config.configured, 'boolean');
});

/* ================================================================== 旧数据迁移 */

section('老数据库迁移（source 列 → topic 列）');

test('老库能自动迁移：数据不丢，列名换成 topic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-migrate-'));
  const dbFile = join(dir, 'old.db');
  let migrated = null;
  try {
    /* 造一个「老版本」的库：列名叫 source，索引名也叫 source */
    const old = new DatabaseSync(dbFile);
    old.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'idea',
        note_date TEXT NOT NULL, starred INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, fingerprint TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_notes_source ON notes(source);
      CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'topic', color TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE note_tags (note_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, auto INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (note_id, tag_id));
      CREATE TABLE tag_suppress (note_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (note_id, tag_id));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO notes (title, content, source, kind, note_date, created_at, updated_at)
        VALUES ('老笔记', '这条是迁移前存进去的。', '反脆弱', 'excerpt', '2026-01-20', '2026-01-20T00:00:00Z', '2026-01-20T00:00:00Z');
    `);
    old.close();

    /* 用当前代码打开它 */
    migrated = createStore(dbFile);

    const cols = migrated.query('PRAGMA table_info(notes)').map((c) => c.name);
    assert.ok(cols.includes('topic'), '迁移后应该有 topic 列');
    assert.ok(!cols.includes('source'), '老的 source 列应该已经改名');

    const list = migrated.notes.list({});
    assert.equal(list.total, 1, '老数据不能丢');
    assert.equal(list.notes[0].topic, '反脆弱', '老数据里的来源变成了主题');
    assert.equal(list.notes[0].kind, 'excerpt');

    /* 迁移后照常能写能查 */
    const added = migrated.notes.create({
      title: '迁移后新增', content: '迁移之后继续用。', topic: '新主题', kind: '金句', noteDate: '2026-03-09',
    }, { allowDuplicate: true });
    assert.equal(added.note.topic, '新主题');
    assert.equal(migrated.notes.list({ topic: '反脆弱' }).total, 1);
    assert.equal(migrated.facets().topics.length, 2, '主题分面应同时包含新旧数据');
  } finally {
    migrated?.raw.close();         // 不关掉文件句柄，Windows 上删不掉临时目录
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

test('导入旧备份（字段名还是 source）也能正常识别', () => {
  const res = store.io.importAll({
    format: 'reading-notes/v1',
    notes: [{ title: '旧备份', content: '这条来自旧版备份文件。', source: '旧书', kind: 'excerpt', noteDate: '2026-02-02' }],
  });
  assert.equal(res.created, 1);
  const hit = store.notes.list({ q: '这条来自旧版备份文件' }).notes[0];
  assert.equal(hit.topic, '旧书', '旧备份里的 source 应落到主题上');
});

/* ================================================================== 结果 */

console.log(`\n${'─'.repeat(56)}`);
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  for (const f of failures) console.log(`\n  ✗ ${f.name}\n${f.err.stack}`);
  process.exit(1);
}
console.log('  全部通过 ✅');