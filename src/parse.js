/**
 * 粘贴解析引擎。
 *
 * 目标：把「随手粘进来的一段东西」尽可能自动地变成结构化笔记。
 * 输入可能长这样（真实用户粘贴的形态非常杂）：
 *
 *   #心理学 #认知
 *   《思考，快与慢》 作者：丹尼尔·卡尼曼
 *   类型：摘录  页码：P32
 *   > 人的一切痛苦，本质上都是对自己无能的愤怒。
 *   ---
 *   今晚读到这一段突然想到……
 *
 * 解析策略：
 *   1. 先按显式分隔符（单独一行的 --- 、*** 、===）或 Markdown 标题切分为多条
 *   2. 每条再逐行「吃掉」元信息行（标题/主题/作者/页码/类型/日期/标签）
 *   3. 剩余部分作为正文，并从正文中补齐《书名》/@主题/URL/#标签/类型判断
 */
import { todayLocal, toDateStr, truncate, uniq } from './util.js';
import { extractInlineTags, normalizeKind } from './db.js';

const SEPARATOR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,}|﹘{3,}|—{3,})\s*$/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const BULLET_RE = /^\s*(?:[-*+•·]|\d+[.、)])\s+/;
const QUOTE_RE = /^\s*>\s?/;

const KIND_WORDS = [
  [/(摘录|原文|原文摘录|引用|摘抄|quote|excerpt)/i, 'excerpt'],
  [/(想法|思考|感悟|评论|心得|随想|联想|idea|thought)/i, 'idea'],
  [/(疑问|问题|困惑|待查|存疑|不懂|question|\?$|？$)/i, 'question'],
  [/(小结|总结|归纳|梳理|summary|复盘)/i, 'summary'],
  [/(待办|行动|todo|to-do|下一步|要做)/i, 'todo'],
];

const META_KEYS = [
  ['title', /^(?:标题|题目|title)\s*[:：]\s*(.+)$/i],
  ['topic', /^(?:主题|话题|来源|出自|书名|书|topic|subject|from|book)\s*[:：]\s*(.+)$/i],
  ['author', /^(?:作者|著者|author|by)\s*[:：]\s*(.+)$/i],
  ['location', /^(?:页码|页数|位置|章节|出处|页)\s*[:：]?\s*(.+)$/],
  ['location', /^(?:location|page|loc|p)\s*[:：]\s*(.+)$/i],
  ['kind', /^(?:类型|类别|kind|type)\s*[:：]\s*(.+)$/i],
  ['noteDate', /^(?:日期|时间|读过|date)\s*[:：]\s*(.+)$/i],
  ['tags', /^(?:标签|tags?)\s*[:：]\s*(.+)$/i],
  ['url', /^(?:链接|网址|url|link)\s*[:：]\s*(.+)$/i],
];

// 行内的「作者：xxx」这类写法，只在元信息区、且行比较短时才认为是元信息
const INLINE_KEYS = [
  ['author', /作者\s*[:：]\s*([^\s，。;；、,]{1,20})/],
  ['location', /(?:页码|页)\s*[:：]?\s*([pP]?\.?\s*\d{1,4}(?:\s*[-–~]\s*\d{1,4})?)/],
  ['topic', /(?:主题|话题|来源|出自|书名)\s*[:：]\s*([^\s，。;；、,]{1,40})/],
  ['noteDate', /(?:日期|读过)\s*[:：]\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/],
  ['title', /标题\s*[:：]\s*(.+)$/],
];

/** 整行就是一个书名（可带「著/编著/译」或「作者：xxx」） */
const BOOK_ONLY_RE = /^《([^》]{1,60})》\s*(?:[\[【(（]?\s*([^\]】)）\s]{1,20})\s*[\]】)）]?\s*[著编著译]\s*)?$/;

/** 只表示位置的一小段：P61 / p.12-15 / 第 3 章 / 页码：45 */
const LOCATION_ONLY_RE = /^(?:[pP]{1,2}\.?\s*\d{1,4}(?:\s*[-–~]\s*\d{1,4})?|第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节页卷篇回讲部]|页\s*\d{1,4}|位置\s*\d{1,5})$/;

/** 「《书名》 P61」这种书名 + 位置写在一行的形式 */
const BOOK_WITH_LOC_RE = /^《([^》]{1,60})》\s*(.*)$/;

/** 「摘录：xxx」这种把类型写在行首的写法 */
const KIND_PREFIX_RE = /^(摘录|原文|引用|摘抄|想法|思考|感悟|评论|心得|随想|疑问|问题|困惑|待查|小结|总结|归纳|复盘|待办|行动)\s*[:：]\s*(.*)$/;

const LOCATION_PATTERNS = [
  /第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节页卷篇回讲部]/g,
  /\b[pP]{1,2}\.?\s*\d{1,4}(?:\s*[-–~]\s*\d{1,4})?/g,
  /位置\s*[:：]?\s*\d{1,5}(?:\s*[-–~]\s*\d{1,5})?/g,
  /loc\.?\s*\d{1,5}(?:\s*[-–~]\s*\d{1,5})?/gi,
  /页\s*\d{1,4}(?:\s*[-–~]\s*\d{1,4})?/g,
];

const URL_RE = /https?:\/\/[^\s<>"')）】]+/g;
const BOOK_TITLE_RE = /《([^》]{1,60})》/g;

/** 整行只是一张图片（粘贴截图后正文里会是这种形式） */
const RE_IMG_LINE = /^\s*!\[[^\]\n]*\]\((?:data:image\/|\/api\/attachments\/|https?:)[^)\s]*\)\s*$/;

function detectKindFromWord(word) {
  const w = String(word || '').trim();
  for (const [re, kind] of KIND_WORDS) if (re.test(w)) return kind;
  return null;
}

/** 从一行里「吃掉」一个键值元信息 */
function matchMetaKey(line) {
  for (const [key, re] of META_KEYS) {
    const m = line.match(re);
    if (m) return { key, value: m[1].trim() };
  }
  return null;
}

function matchInlineMeta(line) {
  for (const [key, re] of INLINE_KEYS) {
    const m = line.match(re);
    if (m) return { key, value: m[1].trim() };
  }
  return null;
}

/** 一行是否只由 #标签 组成 */
function onlyTags(line) {
  const stripped = line.replace(/(^|\s)#[^\s#，。;；:：！？!?()（）[\]【】"'`]{1,24}/g, ' ').trim();
  return stripped === '' && /#\S/.test(line);
}

/** 从整块正文里补齐 主题 / 作者 / 位置 / URL / 日期 */
function scanBodyForMeta(lines) {
  const found = { topic: '', author: '', location: '', url: '', noteDate: '' };
  const text = lines.join('\n');

  const book = [...text.matchAll(BOOK_TITLE_RE)].map((m) => m[1].trim()).find(Boolean);
  if (book) found.topic = book;

  const authorMatch = text.match(/《[^》]{1,60}》\s*[\[【(（]?\s*([^\]】)）\s，。;；,]{1,20})\s*[\]】)）]?\s*[著编著译]/);
  if (authorMatch) found.author = authorMatch[1].trim();

  for (const re of LOCATION_PATTERNS) {
    const m = text.match(re);
    if (m) { found.location = m[0].trim(); break; }
  }

  const url = text.match(URL_RE);
  if (url) found.url = url[0];

  const dateMatch = text.match(/(?:^|[\s:：])(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)(?:\s|$)/);
  if (dateMatch) found.noteDate = toDateStr(dateMatch[1]) || '';

  return found;
}

/** 判断正文形态 → note kind */
function detectKind(bodyLines, explicit) {
  if (explicit) {
    const k = detectKindFromWord(explicit) || explicit.trim().toLowerCase();
    if (['excerpt', 'idea', 'question', 'summary', 'todo'].includes(k)) return k;
  }
  const meaningful = bodyLines.filter((l) => l.trim());
  if (!meaningful.length) return 'idea';

  const quoteLines = meaningful.filter((l) => QUOTE_RE.test(l));
  if (quoteLines.length && quoteLines.length >= Math.ceil(meaningful.length * 0.6)) return 'excerpt';
  if (/^\s*[-*+]\s*\[[ xX]\]/.test(meaningful[0])) return 'todo';

  const body = meaningful.join('\n').trim();
  const bare = body.replace(QUOTE_RE, '').replace(/^[「『“"]|[」』”"]$/g, '').trim();
  const sentences = bare.split(/[。！？!?；;\n]+/).filter((s) => s.trim());
  if (/[？?]\s*$/.test(bare) && bare.length <= 120) return 'question';
  if (/(疑问|问题|困惑|存疑|待查|不懂|求解答)/.test(bare.slice(0, 40))) return 'question';
  if (meaningful.filter((l) => BULLET_RE.test(l)).length >= 3) return 'summary';
  if (sentences.length >= 4 && bare.length > 160) return 'summary';
  if (bare.length <= 60 && /^[「『“"]/.test(bare)) return 'excerpt';
  return 'idea';
}

/** 为没有标题的笔记生成一个可读标题 */
function deriveTitle(bodyLines) {
  // 跳过「整行就是一张图」的行，否则标题会变成 ![](/api/attachments/xxx) 这种东西
  const first = bodyLines.find((l) => l.trim() && !RE_IMG_LINE.test(l));
  if (!first) return '（未命名笔记）';
  const bare = first.replace(QUOTE_RE, '').replace(BULLET_RE, '').replace(/^[「『“"]/, '').trim();
  const sentence = bare.split(/[。！？!?；;\n]/)[0].trim() || bare;
  const cleaned = sentence.replace(/^[「『“"]|[」』”"]$/g, '').trim();
  return truncate(cleaned, 24) || '（未命名笔记）';
}

/**
 * 把一整块文本解析成一条结构化笔记。
 */
function parseBlock(rawBlock, { defaultDate, defaultTopic = '', defaultAuthor = '' } = {}) {
  const lines = rawBlock.replace(/\r\n?/g, '\n').split('\n');
  const meta = { title: '', topic: '', author: '', location: '', kind: '', noteDate: '', url: '' };
  const tagList = [];
  const bodyLines = [];

  // 只从靠前的一小段「元信息区」里提取字段，遇到第一行真正的正文就停止，
  // 避免把正文里恰好长得像 "作者：xxx" 的句子吃掉。
  let inMetaZone = true;
  let budget = 12;
  /*
   * 记下哪些字段是用户「显式写出来的」（例如 主题：xxx / 类型：金句）。
   * 显式写的必须能盖过推测出来的值 —— 否则
   *   《反脆弱》 P61
   *   摘录：xxx
   *   主题：不确定性      ← 会被前面推测出来的「反脆弱」压掉
   *   类型：金句          ← 会被前面推测出来的「摘录」压掉
   * 这类粘贴就会莫名其妙地丢掉用户真正想写的东西。
   * 同名字段仍然是「第一个显式值胜出」，避免互相覆盖。
   */
  const explicitKeys = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (inMetaZone) {
      if (budget-- <= 0) {
        inMetaZone = false;
      } else if (!trimmed) {
        continue; // 元信息区里的空行直接跳过
      } else if (onlyTags(trimmed)) {
        tagList.push(...extractInlineTags(trimmed));
        continue;
      } else {
        // 1) 整行就是一个书名
        const bookOnly = trimmed.match(BOOK_ONLY_RE);
        if (bookOnly) {
          if (!meta.topic) meta.topic = bookOnly[1].trim();
          if (bookOnly[2] && !meta.author) meta.author = bookOnly[2].trim();
          continue;
        }
        // 1b) 《书名》后面只跟一个位置（P61 / 第 3 章 / 页码 45）
        const bookLoc = trimmed.match(BOOK_WITH_LOC_RE);
        if (bookLoc && (!meta.topic || !meta.location)) {
          const tail = bookLoc[2].trim().replace(/^[（(]\s*|\s*[)）]$/g, '');
          if (!tail || LOCATION_ONLY_RE.test(tail) || /^(?:页码|位置|出处)\s*[:：]?\s*\d+/.test(tail)) {
            if (!meta.topic) meta.topic = bookLoc[1].trim();
            const loc = tail.replace(/^(?:页码|位置|出处)\s*[:：]?\s*/, '');
            if (loc && !meta.location) meta.location = loc;
            continue;
          }
        }
        // 1c) 整行只是一个位置
        if (!meta.location && LOCATION_ONLY_RE.test(trimmed)) {
          meta.location = trimmed;
          continue;
        }
        // 2) 行首的键值元信息（显式写的可以覆盖推测值；标签可以多行累加）
        const kv = matchMetaKey(trimmed);
        if (kv && (kv.key === 'tags' || !explicitKeys.has(kv.key))) {
          if (kv.key === 'tags') {
            tagList.push(...String(kv.value).split(/[\s,，、#]+/).filter(Boolean));
          } else {
            meta[kv.key] = kv.value;
            explicitKeys.add(kv.key);
          }
          continue;
        }
        // 3) 「摘录：xxx」「想法：xxx」——类型写在行首
        const kindPrefix = trimmed.match(KIND_PREFIX_RE);
        if (kindPrefix) {
          if (!meta.kind) meta.kind = kindPrefix[1];
          const rest = kindPrefix[2].trim();
          if (rest) bodyLines.push(rest);
          continue;
        }
        // 4) 短行里的行内元信息，例如「《书名》 作者：某某」
        if (trimmed.length <= 60 && !/[。！？!?]$/.test(trimmed)) {
          const inline = matchInlineMeta(trimmed);
          if (inline && !meta[inline.key]) {
            const book = [...trimmed.matchAll(BOOK_TITLE_RE)][0];
            if (book && !meta.topic) meta.topic = book[1].trim();
            meta[inline.key] = inline.value;
            continue;
          }
        }
        // 5) Markdown 标题
        const asHeading = trimmed.match(HEADING_RE);
        if (asHeading && !meta.title) {
          meta.title = asHeading[2].trim();
          continue;
        }
        /*
         * 5b) 单独一行的图片：它属于正文，但不要因为出现图片就结束元信息区。
         * 否则「粘一张截图进来、末尾还带着 日期：」这种最常见的写法里，
         * 日期那一行就会被当成正文留在下面（正文里多出一行「日期：…」）。
         */
        if (RE_IMG_LINE.test(trimmed)) {
          bodyLines.push(line);
          continue;
        }
        inMetaZone = false;
      }
    }
    bodyLines.push(line);
  }

  let body = bodyLines.join('\n').trim();
  const bodyArr = () => body.split('\n');

  // 元信息区之外，正文首行若写着「摘录：xxx」「想法：xxx」，同样视为类型标记
  if (!meta.kind && body) {
    const arr = body.split('\n');
    const m = arr[0].match(KIND_PREFIX_RE);
    if (m) {
      meta.kind = m[1];
      const rest = m[2].trim();
      const tail = arr.slice(1).join('\n').trim();
      body = [rest, tail].filter(Boolean).join('\n');
    }
  }

  // 正文内联 #标签
  tagList.push(...extractInlineTags(body));

  // 正文里的《书名》/URL/日期/页码
  const scanned = scanBodyForMeta(bodyArr());
  for (const [k, v] of Object.entries(scanned)) if (v && !meta[k]) meta[k] = v;

  if (meta.url && !meta.topic) {
    try { meta.topic = new URL(meta.url).hostname.replace(/^www\./, ''); } catch { /* 忽略非法 URL */ }
  }

  /*
   * 「类型：xxx」是用户显式写下的，必须尊重：
   * 能对上内置的 5 种就用内置键（配色、分析里的「疑问/待办」都靠它），
   * 对不上就原样当作自定义类型（比如「类型：金句」）。
   */
  const explicitKind = meta.kind
    ? (detectKindFromWord(meta.kind) || normalizeKind(meta.kind))
    : null;
  const kind = explicitKind || detectKind(bodyArr(), meta.kind);

  // 没有标题时，尝试用正文首行做标题
  if (!meta.title && body) {
    const arr = bodyArr();
    const idx = arr.findIndex((l) => l.trim());
    if (idx >= 0) {
      const bare = arr[idx].trim();
      const asHeading = bare.match(HEADING_RE);
      const plain = bare.replace(QUOTE_RE, '').replace(/[:：]\s*$/, '').trim();
      const cleaned = asHeading ? asHeading[2].trim() : plain;
      const isShort = cleaned.length <= 40;
      const endsClean = !/[。！？!?；;，,]$/.test(cleaned);
      const meaningful = arr.filter((l) => l.trim()).length;
      const nextIsBlank = idx + 1 < arr.length && !arr[idx + 1].trim();
      if (cleaned && (asHeading || (isShort && endsClean && (nextIsBlank || meaningful > 2)))) {
        meta.title = cleaned;
        const rest = arr.slice();
        rest.splice(idx, 1);
        const trimmedRest = rest.join('\n').trim();
        if (trimmedRest) body = trimmedRest;
      }
    }
  }
  if (!meta.title) meta.title = deriveTitle(bodyArr());

  return {
    title: meta.title.slice(0, 200),
    content: body.trim(),
    topic: (meta.topic || defaultTopic || '').slice(0, 200),
    author: (meta.author || defaultAuthor || '').slice(0, 120),
    location: (meta.location || '').slice(0, 80),
    kind,
    kindExplicit: !!explicitKind,
    noteDate: toDateStr(meta.noteDate) || defaultDate || todayLocal(),
    tags: uniq(tagList),
    meta: { url: meta.url || '' },
  };
}

/** 切分成多个块 */
function splitBlocks(text, mode = 'auto') {
  const norm = text.replace(/\r\n?/g, '\n').trim();
  if (!norm) return [];

  const lines = norm.split('\n');
  const hasSeparator = lines.some((l) => SEPARATOR_RE.test(l));
  const headingIdx = [];
  lines.forEach((l, i) => {
    const m = l.match(HEADING_RE);
    if (m && m[1].length <= 2) headingIdx.push(i);
  });

  if (mode === 'single') return [norm];

  if (mode === 'separator' || (mode === 'auto' && hasSeparator)) {
    const blocks = [];
    let cur = [];
    for (const l of lines) {
      if (SEPARATOR_RE.test(l)) { if (cur.join('\n').trim()) blocks.push(cur.join('\n')); cur = []; }
      else cur.push(l);
    }
    if (cur.join('\n').trim()) blocks.push(cur.join('\n'));
    return blocks;
  }

  if ((mode === 'heading' || mode === 'auto') && headingIdx.length >= 2) {
    const blocks = [];
    for (let i = 0; i < headingIdx.length; i++) {
      const start = headingIdx[i];
      const end = i + 1 < headingIdx.length ? headingIdx[i + 1] : lines.length;
      const chunk = lines.slice(start, end).join('\n').trim();
      if (chunk) blocks.push(chunk);
    }
    // 标题之前的引言部分
    if (headingIdx[0] > 0) {
      const pre = lines.slice(0, headingIdx[0]).join('\n').trim();
      if (pre) blocks.unshift(pre);
    }
    return blocks;
  }

  return [norm];
}

/**
 * 主入口：解析粘贴内容。
 * @returns {{ blocks: object[], stats: object, raw: string }}
 */
export function parsePaste(text, options = {}) {
  const {
    defaultDate = todayLocal(),
    defaultTopic = '',
    defaultAuthor = '',
    mode = 'auto',
    defaultTags = [],
    defaultKind = '',
    forceSingle = false,
  } = options;

  const raw = String(text ?? '');
  const chunks = forceSingle ? (raw.trim() ? [raw.trim()] : []) : splitBlocks(raw, mode);

  const blocks = chunks.map((chunk) => {
    const parsed = parseBlock(chunk, { defaultDate, defaultTopic, defaultAuthor });
    if (defaultKind && !parsed.kindExplicit) parsed.kind = defaultKind;
    parsed.tags = uniq([...(parsed.tags || []), ...defaultTags]);
    parsed.meta.raw = chunk;
    parsed.meta.pastedAt = new Date().toISOString();
    if (!parsed.content.trim() && parsed.title) {
      // 只有标题没有正文的情况：用标题兜底，避免存空笔记
      parsed.content = parsed.title;
    }
    return parsed;
  }).filter((b) => b.content.trim() || b.title.trim());

  return {
    raw,
    blocks,
    stats: {
      blocks: blocks.length,
      chars: raw.length,
      withTopic: blocks.filter((b) => b.topic).length,
      withLocation: blocks.filter((b) => b.location).length,
      tags: uniq(blocks.flatMap((b) => b.tags)),
    },
  };
}

/** 供 UI 展示的可读摘要 */
export function describeBlock(block) {
  const bits = [block.kind, block.topic, block.location].filter(Boolean);
  return bits.join(' · ');
}