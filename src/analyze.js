/**
 * 主题分析引擎（纯本地，无外部依赖）。
 *
 * 做三件事：
 *  1. 把一个主题下的所有零散笔记「归拢」：主题分布、类型分布、时间分布
 *  2. 从文本里提炼关键词脉络、主题共现、代表性摘录
 *  3. 渲染成一篇结构化的 Markdown 读书笔记
 */
import { KIND_LABEL } from './db.js';
import { nowLocalStamp } from './util.js';

/* ------------------------------------------------------------------ 关键词提取 */

// 出现在词内部就基本可以判定为噪音的功能字
const CJK_STOP_CHARS = new Set('的了是在我你他她它们这那就都也很也把被与和而且但呢吗吧啊呀哦着过又还只更最之其所以为对于把从到给'.split(''));
const CJK_STOP_GRAMS = new Set([
  '一个', '这个', '那个', '什么', '怎么', '如果', '因为', '所以', '但是', '而且', '就是',
  '可以', '我们', '他们', '你们', '自己', '这样', '那样', '时候', '东西', '事情', '问题',
  '一些', '很多', '非常', '真的', '还是', '或者', '然后', '已经', '没有', '不是', '这些',
  '那些', '作者', '本书', '书中', '观点', '内容', '感觉', '觉得', '认为',
]);
const EN_STOP = new Set(
  ('the a an and or but if then than that this these those of to in on at for with without from by as is are was were be been being ' +
   'it its it\'s we you they he she his her their our your my me us them i not no do does did done have has had can could should would ' +
   'will just about into over under more most some such only also very much many so what which who whom when where why how').split(/\s+/),
);

const CJK_RUN = /[\u4e00-\u9fff]{2,}/g;
const EN_WORD = /[a-z][a-z0-9+#'’-]{2,}/g;
/** 抽取 2/3/4 字词：4 字用来把「读书笔记」这类完整词组立起来，短碎片会被它吸收掉 */
const GRAM_SIZES = [2, 3, 4];

function isNoiseGram(g) {
  if (CJK_STOP_GRAMS.has(g)) return true;
  for (const ch of g) if (CJK_STOP_CHARS.has(ch)) return true;
  return false;
}

/**
 * 从一组笔记里提炼关键词。
 * 中文用 2/3-gram 统计（无需分词器），英文按单词；标签与标题中的词会加权。
 */
export function extractKeywords(notes, { limit = 20 } = {}) {
  const counts = new Map();
  const docFreq = new Map(); // 出现在多少条不同的笔记里
  const titleHits = new Set();
  const tagHits = new Set();

  const bump = (term, weight) => {
    counts.set(term, (counts.get(term) || 0) + weight);
  };

  for (const note of notes) {
    const seen = new Set(); // 本条笔记里出现过的词
    const add = (term, weight) => {
      bump(term, weight);
      seen.add(term);
    };
    const text = `${note.title || ''}\n${note.content || ''}`;
    const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ');
    for (const run of clean.match(CJK_RUN) || []) {
      for (const n of GRAM_SIZES) {
        for (let i = 0; i + n <= run.length; i++) {
          const g = run.slice(i, i + n);
          if (isNoiseGram(g)) continue;
          add(g, n === 2 ? 1 : n === 3 ? 0.9 : 0.8);
        }
      }
    }
    for (const w of clean.toLowerCase().match(EN_WORD) || []) {
      if (EN_STOP.has(w) || w.length < 3) continue;
      add(w, 1);
    }
    for (const t of note.tags || []) {
      if (t.kind === 'time') continue;
      tagHits.add(t.name);
      const n = note.title && note.title.includes(t.name) ? 1.6 : 1.25;
      add(t.name, n);
    }
    for (const run of (note.title || '').match(CJK_RUN) || []) {
      for (const n of GRAM_SIZES) {
        for (let i = 0; i + n <= run.length; i++) {
          const g = run.slice(i, i + n);
          if (!isNoiseGram(g)) { titleHits.add(g); add(g, 0.6); }
        }
      }
    }
    for (const term of seen) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }

  const minCount = notes.length >= 4 ? 2 : 1;
  const scored = [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([term, count]) => {
      const df = docFreq.get(term) || 1;
      // 跨越多条笔记反复出现的词更像真词；只在一条笔记里出现的连续切片往后退
      const spread = 1 + 0.6 * Math.min(df - 1, 4);
      return {
        term,
        count: Math.round(count * 10) / 10,
        notes: df,
        score: count * spread * (term.length >= 3 ? 1.25 : 1) * (tagHits.has(term) ? 1.5 : titleHits.has(term) ? 1.15 : 1),
      };
    })
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

  // 去掉被更长且同样高频的词包含的短词：「读书笔」「书笔记」都会被「读书笔记」吸收。
  // 这里对全部候选做判断（而不是只看已保留的词），结果与排序无关。
  const out = [];
  for (const item of scored) {
    const swallowed = scored.some(
      (o) => o !== item && o.term.length > item.term.length && o.term.includes(item.term) && o.count >= item.count * 0.8,
    );
    if (swallowed) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ 句子处理 */

export function splitSentences(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((s) => s.replace(/^\s*(?:[-*+•·]|\d+[.、)]|>)\s*/, '').trim())
    .filter((s) => s.length >= 8 && s.length <= 220);
}

/* ------------------------------------------------------------------ 主题分析 */

export function analyzeTopic(notes, { scope = {}, highlightLimit = 14 } = {}) {
  const total = notes.length;
  const kinds = new Map();
  const topics = new Map();
  const months = new Map();

  let first = null;
  let last = null;

  for (const n of notes) {
    kinds.set(n.kind, (kinds.get(n.kind) || 0) + 1);
    const s = n.topic || '（未填主题）';
    topics.set(s, (topics.get(s) || 0) + 1);
    months.set(n.noteDate.slice(0, 7), (months.get(n.noteDate.slice(0, 7)) || 0) + 1);
    if (!first || n.noteDate < first) first = n.noteDate;
    if (!last || n.noteDate > last) last = n.noteDate;
  }

  const keywordList = extractKeywords(notes, { limit: 24 });
  const keywordWeight = new Map(keywordList.map((k) => [k.term, k.score]));

  // 代表句：命中关键词多、长度适中、来自摘录/星标笔记的句子优先
  const candidates = [];
  for (const n of notes) {
    for (const s of splitSentences(n.content)) {
      let score = 0;
      for (const [term, weight] of keywordWeight) if (s.includes(term)) score += weight;
      if (score <= 0) continue;
      score = score / Math.log2(s.length + 4);
      if (n.kind === 'excerpt') score *= 1.45;
      if (n.starred) score *= 1.3;
      if (n.kind === 'summary') score *= 0.9;
      candidates.push({ score, noteId: n.id, text: s, topic: n.topic, location: n.location, date: n.noteDate, kind: n.kind });
    }
  }
  const highlights = [];
  const seenText = new Set();
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    const key = c.text.slice(0, 24);
    if (seenText.has(key)) continue;
    seenText.add(key);
    highlights.push(c);
    if (highlights.length >= highlightLimit) break;
  }

  // 主题共现：常与当前主题一起出现的标签
  const coTags = new Map();
  for (const n of notes) {
    for (const t of n.tags || []) {
      if (t.kind === 'time') continue;
      coTags.set(t.name, (coTags.get(t.name) || 0) + 1);
    }
  }
  const themes = [...coTags.entries()]
    .filter(([name]) => !(scope.tags || []).includes(name))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const byTopic = [...topics.entries()]
    .map(([name, count]) => ({
      name,
      count,
      notes: notes.filter((n) => (n.topic || '（未填主题）') === name),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    scope: {
      ...scope,
      noteCount: total,
      first,
      last,
      span: first && last ? (first === last ? first : `${first} ~ ${last}`) : '',
      topics: [...topics.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      kinds: [...kinds.entries()].map(([kind, count]) => ({ kind, label: KIND_LABEL[kind] || kind, count })).sort((a, b) => b.count - a.count),
      timeline: [...months.entries()].map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
    },
    keywords: keywordList,
    themes: themes.slice(0, 12),
    highlights,
    byTopic,
    questions: notes.filter((n) => n.kind === 'question'),
    todos: notes.filter((n) => n.kind === 'todo'),
    excerpts: notes.filter((n) => n.kind === 'excerpt'),
    ideas: notes.filter((n) => n.kind === 'idea' || n.kind === 'summary'),
    generatedAt: nowLocalStamp(),
  };
}

/* ------------------------------------------------------------------ 渲染读书笔记 */

function quote(text, indent = '') {
  return String(text)
    .split('\n')
    .map((l) => `${indent}> ${l}`.trimEnd())
    .join('\n');
}

function anchor(note) {
  const bits = [];
  if (note.topic) bits.push(note.topic);
  if (note.location) bits.push(note.location);
  bits.push(note.noteDate);
  return bits.join(' · ');
}

/**
 * 把分析结果渲染成一篇结构化的读书笔记（Markdown）。
 */
export function renderReadingNote(analysis, { title, llmSummary = '', includeIndex = true } = {}) {
  const s = analysis.scope;
  const name = title || (s.tags?.length ? s.tags.map((t) => `#${t}`).join(' ') : s.topic || '笔记主题');
  const L = [];

  L.push(`# ${name}${/读书笔记/.test(name) ? '' : ' · 读书笔记'}`);
  L.push('');
  L.push(
    `> 生成时间：${analysis.generatedAt} ｜ 覆盖 **${s.noteCount}** 条笔记 ｜ 主题 **${s.topics.length}** 个 ｜ 时间跨度 ${s.span || '—'}`,
  );
  const tagNames = (s.tags || []).map((t) => `#${t}`).join(' ');
  if (tagNames) L.push(`> 标签：${tagNames}${s.topic ? ` ｜ 主题：${s.topic}` : ''}`);
  L.push('');

  if (llmSummary && llmSummary.trim()) {
    L.push('## 一、综述');
    L.push('');
    L.push(llmSummary.trim());
    L.push('');
  }

  let n = llmSummary && llmSummary.trim() ? 2 : 1;

  L.push(`## ${cn(n++)}、概览`);
  L.push('');
  L.push(`- **笔记构成**：${s.kinds.map((k) => `${k.label} ${k.count} 条`).join(' · ')}`);
  L.push(`- **主要主题**：${s.topics.slice(0, 6).map((x) => `${x.name}（${x.count}）`).join(' · ') || '—'}`);
  if (s.timeline.length > 1) {
    L.push(`- **时间分布**：${s.timeline.map((t) => `${t.month}（${t.count}）`).join(' · ')}`);
  }
  L.push('');

  if (analysis.keywords.length) {
    L.push(`## ${cn(n++)}、关键词脉络`);
    L.push('');
    L.push(analysis.keywords.slice(0, 16).map((k) => `**${k.term}**`).join(' · '));
    L.push('');
  }

  if (analysis.highlights.length) {
    L.push(`## ${cn(n++)}、核心摘录`);
    L.push('');
    for (const h of analysis.highlights) {
      L.push(quote(h.text));
      L.push(`> — ${anchor({ topic: h.topic, location: h.location, noteDate: h.date })}`);
      L.push('');
    }
  }

  const byTopicGroups = analysis.byTopic.filter((g) => g.notes.some((x) => x.kind === 'excerpt'));
  if (byTopicGroups.length) {
    L.push(`## ${cn(n++)}、按主题整理`);
    L.push('');
    for (const g of byTopicGroups) {
      L.push(`### ${g.name}（${g.count} 条）`);
      L.push('');
      for (const note of g.notes) {
        L.push(`- **${note.title}**${note.location ? `（${note.location}）` : ''} · ${note.noteDate}`);
        if (note.content) {
          const body = note.content
            .split('\n')
            .filter((l) => l.trim())
            .slice(0, 6)
            .map((l) => `  ${l}`)
            .join('\n');
          if (body) L.push(body);
        }
      }
      L.push('');
    }
  }

  if (analysis.ideas.length) {
    L.push(`## ${cn(n++)}、想法与小结`);
    L.push('');
    for (const note of analysis.ideas) {
      L.push(`- **${note.title}**（${KIND_LABEL[note.kind] || note.kind}${note.topic ? ` · ${note.topic}` : ''} · ${note.noteDate}）`);
      const first = note.content.split('\n').filter((l) => l.trim()).slice(0, 3).join(' ');
      if (first) L.push(`  ${first.slice(0, 200)}`);
    }
    L.push('');
  }

  if (analysis.questions.length || analysis.todos.length) {
    L.push(`## ${cn(n++)}、疑问与待深入`);
    L.push('');
    for (const q of analysis.questions) L.push(`- [ ] ${q.title}：${q.content.split('\n')[0].slice(0, 160)}`);
    for (const t of analysis.todos) L.push(`- [ ] ${t.title}：${t.content.split('\n')[0].slice(0, 160)}`);
    L.push('');
  }

  if (analysis.themes.length) {
    L.push(`## ${cn(n++)}、关联主题`);
    L.push('');
    L.push(analysis.themes.map((t) => `#${t.name}（共现 ${t.count} 条）`).join(' · '));
    L.push('');
  }

  if (includeIndex) {
    L.push(`## ${cn(n++)}、原始笔记索引`);
    L.push('');
    const sorted = [...analysis.excerpts, ...analysis.ideas, ...analysis.questions, ...analysis.todos];
    const seen = new Set();
    let i = 1;
    for (const note of sorted) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      L.push(`${i++}. [${note.noteDate}] ${note.topic || '—'}${note.location ? ` ${note.location}` : ''} — ${note.title}（${KIND_LABEL[note.kind] || note.kind}）`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(`*由「读书笔记管理系统」自动汇总生成 · ${analysis.generatedAt}*`);
  return L.join('\n');
}

function cn(n) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (n <= 10) return digits[n];
  if (n < 20) return `十${digits[n - 10]}`;
  return String(n);
}

/**
 * 生成「分析素材」文本，交给 LLM 做深度综述。
 */
export function buildLLMPayload(analysis, { maxChars = 14000 } = {}) {
  const L = [];
  L.push(`# 主题：${(analysis.scope.tags || []).join(' ') || analysis.scope.topic || '（未命名）'}`);
  L.push(`笔记数：${analysis.scope.noteCount}，时间跨度：${analysis.scope.span}`);
  L.push(`主题：${analysis.scope.topics.map((s) => `${s.name}(${s.count})`).join('、')}`);
  L.push(`关键词：${analysis.keywords.slice(0, 20).map((k) => k.term).join('、')}`);
  L.push('');
  L.push('## 笔记原文');
  const all = [...analysis.excerpts, ...analysis.ideas, ...analysis.questions, ...analysis.todos];
  const seen = new Set();
  let used = L.join('\n').length;
  for (const note of all) {
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    const piece = `\n【${note.noteDate}｜${note.topic || '未填主题'}${note.location ? `｜${note.location}` : ''}｜${KIND_LABEL[note.kind] || note.kind}】${note.title}\n${note.content}\n`;
    if (used + piece.length > maxChars) break;
    L.push(piece);
    used += piece.length;
  }
  return L.join('\n');
}