/**
 * 解析器调试工具：把一段文本丢给解析引擎，看它会被解析成什么。
 *
 *   node --no-warnings scripts/debug-parse.mjs "《反脆弱》 P167\n摘录：试错是一种期权。"
 *   node --no-warnings scripts/debug-parse.mjs < 我的笔记.txt
 *   node --no-warnings scripts/debug-parse.mjs                # 不带参数时跑内置的几个例子
 */
import { readFileSync } from 'node:fs';
import { parsePaste } from '../src/parse.js';

const SAMPLES = [
  ['书名 + 位置写在一行', `#反脆弱
《反脆弱》 P61
摘录：如果你拥有一个会随波动而受益的结构，那么不确定性就不再是需要防范的敌人。
日期：2026-09-21`],
  ['书名 + 章节', `《人类简史》 第 3 章
摘录：想象的共同体让陌生人之间也能协作。`],
  ['类型写在正文首行', `读到一段很有意思的话。
摘录：习惯是自我提高的复利。`],
  ['网页剪藏', `标题：为什么我们把沉没成本看得那么重
主题：决策
链接：https://example.com/a/1
真正的损失不是已经付出的，而是为了证明已经付出的没有白费而继续投入。 #沉没成本`],
  ['一次贴多条', `《原子习惯》 P12
摘录：每天进步 1%。
---
想法：这个和复利是一个意思。 #复利`],
];

function show(text, label) {
  const r = parsePaste(text, { defaultDate: '2000-01-01' });
  console.log(`\n${'─'.repeat(60)}`);
  if (label) console.log(`【${label}】`);
  console.log(`识别到 ${r.blocks.length} 条笔记`);
  if (r.stats.tags?.length) console.log(`标签：${r.stats.tags.map((t) => `#${t}`).join(' ')}`);

  for (const [i, b] of r.blocks.entries()) {
    console.log(`\n  ${i + 1}. 标题   ${b.title}`);
    console.log(`     主题   ${b.topic || '—'}${b.location ? `  ·  位置 ${b.location}` : ''}`);
    console.log(`     作者   ${b.author || '—'}`);
    console.log(`     类型   ${b.kind}      日期 ${b.noteDate}`);
    console.log(`     标签   ${b.tags.length ? b.tags.map((t) => `#${t}`).join(' ') : '—'}`);
    console.log(`     正文   ${JSON.stringify(b.content)}`);
  }
  console.log('');
}

/* 1) 命令行参数 */
const arg = process.argv.slice(2).join(' ').trim();

if (arg) {
  show(arg.replace(/\\n/g, '\n'), '来自命令行参数');
} else if (!process.stdin.isTTY) {
  /* 2) 管道 / 重定向进来的内容 */
  let piped = '';
  try { piped = readFileSync(0, 'utf8'); } catch { piped = ''; }
  if (piped.trim()) show(piped, '来自标准输入');
} else {
  /* 3) 内置示例 */
  for (const [label, text] of SAMPLES) show(text, label);
}