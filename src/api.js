/**
 * REST API 路由。
 * 全部接口都挂在 /api 下，前端是一个零构建的原生 ES Module 应用。
 */
import { analyzeTopic, renderReadingNote, buildLLMPayload, extractKeywords } from './analyze.js';
import { KIND_LABEL, NOTE_KINDS } from './db.js';
import { parsePaste } from './parse.js';
import { resolveLLM, generateSummary, ping } from './llm.js';
import { toDateStr, todayLocal } from './util.js';

const KIND_BY_LABEL = Object.fromEntries(Object.entries(KIND_LABEL).map(([k, v]) => [v, k]));

/* ------------------------------------------------------------------ 查询语法 */

/**
 * 把搜索框里的一行文本解析成结构化过滤条件：
 *   关键词  #标签  @主题  类型:摘录  kind:idea  星标  is:starred
 *   after:2026-01-01  before:2026-06-30  date:2026-06  主题:决策  "精确短语"
 *
 * 类型和主题都是自由文本，所以这里不做枚举校验，原样带下去匹配即可
 * （「类型:」后面写内置的摘录/想法，或者你自己起的「金句」都行）。
 */
export function parseSearchQuery(q) {
  const out = { q: '', tags: [], kinds: [], topic: '', from: '', to: '', starred: false };
  const words = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(q || '')))) {
    const quoted = m[1];
    const tok = quoted ?? m[2];
    if (quoted) { words.push(tok); continue; }

    if (/^#/.test(tok) && tok.length > 1) out.tags.push(tok.slice(1));
    else if (/^@/.test(tok) && tok.length > 1) out.topic = tok.slice(1);
    else if (/^(kind|类型|类别):/i.test(tok)) {
      const raw = tok.split(':').slice(1).join(':');
      for (const piece of raw.split(/[,，]/).filter(Boolean)) {
        out.kinds.push(KIND_BY_LABEL[piece] || KIND_BY_LABEL[piece.toLowerCase()] || piece);
      }
    } else if (/^(is:starred|is:star|星标|收藏)$/i.test(tok)) out.starred = true;
    else if (/^after:/i.test(tok)) out.from = toDateStr(tok.slice(6)) || '';
    else if (/^before:/i.test(tok)) out.to = toDateStr(tok.slice(7)) || '';
    else if (/^(topic|主题|话题|来源|出自):/i.test(tok)) out.topic = tok.split(':').slice(1).join(':');
    else if (/^date:/i.test(tok)) {
      const v = tok.slice(5);
      const monthMatch = v.match(/^(\d{4})[-/.](\d{1,2})$/);
      if (monthMatch) {
        const y = monthMatch[1];
        const mo = String(monthMatch[2]).padStart(2, '0');
        out.from = `${y}-${mo}-01`;
        const last = new Date(Number(y), Number(mo), 0).getDate();
        out.to = `${y}-${mo}-${String(last).padStart(2, '0')}`;
      } else {
        const d = toDateStr(v);
        if (d) { out.from = d; out.to = d; }
      }
    } else words.push(tok);
  }
  out.q = words.join(' ');
  return out;
}

/**
 * 把 URL 查询串解析成 store 用的过滤条件。
 * q 里可以内嵌语法（#标签 / @主题 / 类型: / after: / 星标），
 * 这些会被拆出来，剩下的词才作为全文关键词。
 */
function parseListParams(params, { includeTagFilter = true } = {}) {
  const parsed = parseSearchQuery(params.get('q') || '');
  const filter = {
    q: parsed.q,
    tags: [...parsed.tags],
    kinds: [...parsed.kinds],
    topic: params.get('topic') || parsed.topic,
    from: params.get('from') || parsed.from,
    to: params.get('to') || parsed.to,
    starred: parsed.starred || params.get('starred') === '1',
    tagMode: params.get('tagMode') || 'all',
    sort: params.get('sort') || 'date-desc',
    limit: Number(params.get('limit') || 100),
    offset: Number(params.get('offset') || 0),
    includeArchived: params.get('includeArchived') === '1',
  };
  const qsTags = params.get('tags');
  if (qsTags) filter.tags.push(...qsTags.split(',').map((t) => t.trim()).filter(Boolean));
  const qsKinds = params.get('kind') || params.get('kinds');
  if (qsKinds) filter.kinds.push(...qsKinds.split(',').map((k) => k.trim()).filter(Boolean));
  filter.tags = [...new Set(filter.tags)];
  filter.kinds = [...new Set(filter.kinds)];
  if (!includeTagFilter) filter.tags = [];
  return filter;
}

/* ------------------------------------------------------------------ 标签推荐 */

function suggestTags(store, text, limit = 8) {
  const inline = [];
  const existing = store.tags.list({ withCounts: true });
  const content = String(text || '');

  const scores = new Map();
  const bigrams = (s) => {
    const out = new Set();
    for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const textGrams = bigrams(content);

  for (const tag of existing) {
    if (tag.kind === 'time') continue;
    let score = 0;
    if (content.includes(tag.name)) score += 6;
    const tg = bigrams(tag.name);
    let hit = 0;
    for (const g of tg) if (textGrams.has(g)) hit++;
    if (tg.size) score += (hit / tg.size) * 3;
    score += Math.min(2, (tag.count || 0) / 20); // 稍微偏好已有规模的标签
    if (score > 2.2) scores.set(tag.name, score);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, score]) => {
      const tag = existing.find((t) => t.name === name);
      return { name, score: Math.round(score * 100) / 100, kind: tag?.kind || 'topic', count: tag?.count || 0 };
    });
}

/* ------------------------------------------------------------------ 工具 */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

/** 直接回二进制（图片附件） */
function sendBytes(res, status, buf, headers = {}) {
  res.writeHead(status, { 'content-length': buf.length, ...headers });
  res.end(buf);
}

async function readBody(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw Object.assign(new Error(`请求体过大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`), { status: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error('请求体不是合法 JSON'); }
}

function csvEscape(s) {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

/* ------------------------------------------------------------------ 路由 */

export function createRouter(store) {
  /* ---- 笔记 ---- */

  function listNotes(params) {
    return store.notes.list(parseListParams(params));
  }

  function previewPaste(body) {
    const result = parsePaste(body.text || '', {
      defaultDate: body.defaultDate || todayLocal(),
      defaultTopic: body.defaultTopic || '',
      defaultAuthor: body.defaultAuthor || '',
      defaultTags: body.defaultTags || [],
      mode: body.mode || 'auto',
      forceSingle: !!body.forceSingle,
    });
    return {
      ...result,
      blocks: result.blocks.map((b) => {
        const dup = store.notes.findDuplicate(b.content, b.topic);
        return { ...b, duplicateOf: dup ? { id: dup.id, title: dup.title } : null };
      }),
    };
  }

  function saveBlocks(body) {
    const blocks = Array.isArray(body.blocks) ? body.blocks : [];
    const allowDuplicate = body.allowDuplicate === true;
    const created = [];
    const duplicates = [];
    const failed = [];
    for (const b of blocks) {
      try {
        const res = store.notes.create(
          {
            title: b.title, content: b.content, topic: b.topic, author: b.author,
            location: b.location, kind: b.kind, noteDate: b.noteDate, starred: b.starred,
            meta: b.meta || {}, tags: b.tags || [], tagsAuto: true,
          },
          { allowDuplicate },
        );
        if (res.duplicate) duplicates.push(res.note);
        else created.push(res.note);
      } catch (err) {
        failed.push({ block: b, error: String(err?.message || err) });
      }
    }
    return { created, duplicates, failed, createdCount: created.length, duplicateCount: duplicates.length };
  }

  /* ---- 主题分析 ---- */

  function scopeNotes(body) {
    const parsed = parseSearchQuery(body.q || '');
    const filter = {
      q: parsed.q,
      tags: [...new Set([...(body.tags || []), ...(body.tagNames || []), ...parsed.tags])],
      kinds: [...new Set([...(body.kinds || []), ...parsed.kinds])],
      topic: body.topic !== undefined ? body.topic : parsed.topic,
      from: body.from || parsed.from,
      to: body.to || parsed.to,
      starred: !!body.starred || parsed.starred,
      tagMode: body.tagMode || 'all',
      sort: body.sort || 'date-desc',
      limit: 1000,
      offset: 0,
      includeArchived: !!body.includeArchived,
    };
    // 支持「从列表页勾选若干条笔记再汇总」的场景
    if (Array.isArray(body.ids) && body.ids.length) filter.ids = body.ids.map(Number);
    const result = store.notes.list(filter);
    return { filter, notes: result.notes, total: result.total };
  }

  function analyze(body) {
    const { notes, filter } = scopeNotes(body);
    const analysis = analyzeTopic(notes, {
      scope: {
        tags: filter.tags,
        topic: filter.topic,
        q: filter.q,
        from: filter.from,
        to: filter.to,
        kinds: filter.kinds,
      },
    });
    return analysis;
  }

  async function generate(body) {
    const { notes, filter } = scopeNotes(body);
    if (!notes.length) throw new Error('该范围内没有笔记，无法生成读书笔记');
    const title = body.title
      || (filter.tags.length ? filter.tags.map((t) => `#${t}`).join(' ') : filter.topic || '我的读书笔记');

    const analysis = analyzeTopic(notes, {
      scope: { tags: filter.tags, topic: filter.topic, q: filter.q, from: filter.from, to: filter.to, kinds: filter.kinds },
    });

    let llmSummary = '';
    let llmError = '';
    const config = resolveLLM(store);
    if (body.useLLM && config.configured && config.enabled) {
      try {
        llmSummary = await generateSummary({ material: buildLLMPayload(analysis), title, config });
      } catch (err) {
        llmError = String(err?.message || err);
      }
    } else if (body.useLLM && !config.configured) {
      llmError = '未配置 LLM API Key，已改用本地分析结果';
    }

    const markdown = renderReadingNote(analysis, { title, llmSummary });
    let saved = null;
    if (body.save) {
      const res = store.notes.create({
        title: `${title} · 读书笔记`.slice(0, 200),
        content: markdown,
        // 生成出来的笔记，主题默认沿用当前范围（旧字段名 noteSource 继续兼容）
        topic: body.noteTopic ?? body.noteSource ?? (filter.topics?.length === 1 ? filter.topic : ''),
        kind: 'summary',
        noteDate: body.noteDate || todayLocal(),
        tags: filter.tags,
        meta: { generated: true, fromNoteIds: notes.map((n) => n.id), generatedAt: analysis.generatedAt, llm: !!llmSummary },
      });
      saved = res.note;
    }
    return { markdown, analysis, llmSummary, llmError, note: saved };
  }

  /* ---- 导出 ---- */

  function exportMarkdown(params) {
    const filter = parseListParams(params);
    filter.limit = 1000;
    const { notes, total } = store.notes.list(filter);

    /*
     * 导出的 .md 要能脱离本系统单独看，所以把图片内嵌成 data URI。
     * 只在真的用到图片时才做这件事（没图片的库导出结果和以前一模一样）。
     */
    const imgCache = new Map();
    const embedImages = (text) => String(text).replace(
      /(!\[[^\]\n]*\]\()\/api\/attachments\/([A-Za-z0-9_-]{4,64})(\))/g,
      (whole, head, id, tail) => {
        if (!imgCache.has(id)) {
          const found = store.attachments.data(id);
          imgCache.set(id, found ? `data:${found.mime};base64,${found.data.toString('base64')}` : null);
        }
        const uri = imgCache.get(id);
        return uri ? `${head}${uri}${tail}` : whole;
      },
    );
    const imageCount = new Set(
      notes.flatMap((n) => [...String(n.content).matchAll(/\/api\/attachments\/([A-Za-z0-9_-]{4,64})\)/g)].map((m) => m[1])),
    ).size;

    const L = [`# 读书笔记全库导出`, '', `> 导出时间：${new Date().toLocaleString('zh-CN')} ｜ 共 ${total} 条`, ''];
    if (imageCount) {
      L.push(`> 内含 ${imageCount} 张图片，已按 base64 内嵌进本文件，换台机器打开也能看到。`, '');
    }
    const byTopic = new Map();
    for (const n of notes) {
      const key = n.topic || '（未填主题）';
      if (!byTopic.has(key)) byTopic.set(key, []);
      byTopic.get(key).push(n);
    }
    const ordered = [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length);
    L.push('## 目录', '');
    for (const [name, list] of ordered) L.push(`- ${name}（${list.length}）`);
    L.push('');
    for (const [name, list] of ordered) {
      L.push(`## ${name}`, '');
      for (const n of list) {
        L.push(`### ${n.title}`);
        L.push('');
        // 类型可以是自定义的，取不到中文标签就直接显示原文
        const metaBits = [n.noteDate, n.location, n.author && `作者：${n.author}`, KIND_LABEL[n.kind] || n.kind].filter(Boolean);
        L.push(`\`${metaBits.join(' · ')}\``);
        if (n.tags?.length) L.push(`标签：${n.tags.map((t) => `#${t.name}`).join(' ')}`);
        L.push('');
        L.push(embedImages(n.content));
        L.push('');
      }
    }
    return L.join('\n');
  }

  /* ---- 路由表 ---- */

  const routes = [
    ['GET', /^\/api\/health$/, async () => ({ ok: true, ...store.stats() })],

    ['GET', /^\/api\/notes$/, async (_m, _b, _p, q) => listNotes(q)],

    ['POST', /^\/api\/notes$/, async (_m, body) => {
      if (body.text) {
        const parsed = parsePaste(body.text, {
          defaultDate: body.defaultDate || todayLocal(),
          defaultTopic: body.defaultTopic || '',
          defaultAuthor: body.defaultAuthor || '',
          defaultTags: body.defaultTags || [],
          mode: body.mode || 'auto',
          forceSingle: !!body.forceSingle,
        });
        return saveBlocks({ blocks: parsed.blocks, allowDuplicate: body.allowDuplicate });
      }
      const res = store.notes.create(body.note || body, { allowDuplicate: body.allowDuplicate === true });
      return res.duplicate ? { duplicates: [res.note], created: [], createdCount: 0, duplicateCount: 1 } : { created: [res.note], duplicates: [], createdCount: 1, duplicateCount: 0 };
    }],

    ['POST', /^\/api\/notes\/preview$/, async (_m, body) => previewPaste(body)],

    ['POST', /^\/api\/notes\/bulk$/, async (_m, body) => saveBlocks(body)],

    /* ---- 图片附件 ---- */

    // 上传：先存下来拿到一个稳定 URL，前端再把它插进正文
    ['POST', /^\/api\/attachments$/, async (_m, body) => {
      const attachment = store.attachments.put({
        dataUrl: body.dataUrl, data: body.data, mime: body.mime, name: body.name,
        width: body.width, height: body.height,
      });
      return { attachment };
    }],

    // 取图：id 一旦生成内容就不会再变，所以可以放心让浏览器长期缓存
    ['GET', /^\/api\/attachments\/([A-Za-z0-9_-]{4,64})$/, async (m) => {
      const found = store.attachments.data(m[1]);
      if (!found) throw Object.assign(new Error('图片不存在'), { status: 404 });
      return {
        __binary: found.data,
        headers: {
          'content-type': found.mime,
          'content-length': found.data.length,
          'cache-control': 'public, max-age=31536000, immutable',
          etag: `"att-${found.id}"`,
        },
      };
    }],

    ['GET', /^\/api\/attachments\/([A-Za-z0-9_-]{4,64})\/meta$/, async (m) => {
      const meta = store.attachments.meta(m[1]);
      if (!meta) throw Object.assign(new Error('图片不存在'), { status: 404 });
      return { attachment: meta };
    }],

    // 删掉一张图片；还被笔记引用着的会拒绝（否则正文里会留下破图）
    ['DELETE', /^\/api\/attachments\/([A-Za-z0-9_-]{4,64})$/, async (m) => {
      const res = store.attachments.remove(m[1]);
      if (res.reason === 'not-found') throw Object.assign(new Error('图片不存在'), { status: 404 });
      if (res.reason === 'in-use') throw new Error('这张图片还被笔记引用着，先从正文里删掉对它的引用');
      return { deleted: true };
    }],

    // 手动清理没人引用的图片（启动时也会自动清一次）
    ['POST', /^\/api\/attachments\/gc$/, async (_m, body) => {
      // 注意别写成 Number(x) || 7：graceDays=0（立刻清理）会被当成「没传」而变成 7 天
      const raw = body?.graceDays;
      const days = raw === undefined || raw === null || raw === '' ? 7 : Number(raw);
      if (!Number.isFinite(days) || days < 0) throw new Error('graceDays 必须是不小于 0 的数字');
      return store.attachments.gc({ graceDays: days });
    }],

    ['GET', /^\/api\/notes\/(\d+)$/, async (m) => {
      const note = store.notes.get(Number(m[1]));
      if (!note) throw Object.assign(new Error('笔记不存在'), { status: 404 });
      return note;
    }],

    ['PATCH', /^\/api\/notes\/(\d+)$/, async (m, body) => {
      const note = store.notes.update(Number(m[1]), body);
      if (!note) throw Object.assign(new Error('笔记不存在'), { status: 404 });
      return note;
    }],

    ['DELETE', /^\/api\/notes\/(\d+)$/, async (m) => ({ deleted: store.notes.delete(Number(m[1])) })],

    ['POST', /^\/api\/notes\/(\d+)\/tags$/, async (m, body) => {
      let note = store.notes.get(Number(m[1]));
      if (!note) throw Object.assign(new Error('笔记不存在'), { status: 404 });
      if (body.add?.length) note = store.notes.addTags(note.id, body.add, { kind: body.kind || 'topic' });
      if (body.remove?.length) note = store.notes.removeTags(note.id, body.remove);
      return note;
    }],

    ['GET', /^\/api\/tags$/, async (_m, _b, _p, q) => ({
      tags: store.tags.list({ withCounts: q.get('counts') !== '0', includeTime: q.get('includeTime') !== '0' }),
    })],

    ['POST', /^\/api\/tags$/, async (_m, body) => ({ tag: store.tags.create(body) })],

    ['PATCH', /^\/api\/tags\/(\d+)$/, async (m, body) => {
      const tag = store.tags.update(Number(m[1]), body);
      if (!tag) throw Object.assign(new Error('标签不存在'), { status: 404 });
      return { tag };
    }],

    ['DELETE', /^\/api\/tags\/(\d+)$/, async (m, _b, p) => ({ deleted: store.tags.remove(Number(m[1]), { purge: p.get('purge') === '1' }) })],

    ['POST', /^\/api\/tags\/merge$/, async (_m, body) => ({ tag: store.tags.merge(body.from || [], body.into) })],

    ['GET', /^\/api\/facets$/, async (_m, _b, _p, q) => {
      // 分面统计刻意忽略「已选标签」这个条件，这样侧栏才能继续多选别的标签
      return store.facets(parseListParams(q, { includeTagFilter: false }));
    }],

    ['GET', /^\/api\/stats$/, async () => store.stats()],

    ['POST', /^\/api\/analyze$/, async (_m, body) => analyze(body)],

    ['POST', /^\/api\/generate$/, async (_m, body) => generate(body)],

    ['POST', /^\/api\/suggest-tags$/, async (_m, body) => ({ suggestions: suggestTags(store, body.text || '') })],

    ['POST', /^\/api\/keywords$/, async (_m, body) => {
      const { notes } = scopeNotes(body);
      return { keywords: extractKeywords(notes, { limit: body.limit || 30 }) };
    }],

    ['GET', /^\/api\/export\/markdown$/, async (_m, _b, _p, q) => {
      const md = exportMarkdown(q);
      const stamp = todayLocal();
      const filename = encodeURIComponent(`读书笔记导出-${stamp}.md`);
      return { __raw: md, headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${filename}` } };
    }],

    ['GET', /^\/api\/export\/json$/, async () => {
      const data = store.io.exportAll();
      const filename = encodeURIComponent(`读书笔记备份-${todayLocal()}.json`);
      return { __raw: JSON.stringify(data, null, 2), headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${filename}` } };
    }],

    ['GET', /^\/api\/export\/csv$/, async (_m, _b, _p, q) => {
      const filter = parseListParams(q);
      filter.limit = 1000;
      const { notes } = store.notes.list(filter);
      const rows = [['id', 'date', 'title', 'topic', 'author', 'location', 'kind', 'tags', 'content'].join(',')];
      for (const n of notes) {
        rows.push([
          n.id, n.noteDate, csvEscape(n.title), csvEscape(n.topic), csvEscape(n.author),
          csvEscape(n.location), n.kind, csvEscape((n.tags || []).map((t) => t.name).join(' ')),
          csvEscape(n.content.replace(/\n/g, '\\n')),
        ].join(','));
      }
      return { __raw: `\uFEFF${rows.join('\n')}`, headers: { 'content-type': 'text/csv; charset=utf-8' } };
    }],

    ['POST', /^\/api\/import$/, async (_m, body) => store.io.importAll(body.data ?? body, { mode: body.mode || 'skip' })],

    ['GET', /^\/api\/settings$/, async () => {
      const s = store.settings.all();
      const llm = resolveLLM(store);
      return {
        settings: { ...s, llmApiKey: s.llmApiKey ? '••••••••' : '' },
        llm: { configured: llm.configured, baseUrl: llm.baseUrl, model: llm.model, fromEnv: llm.fromEnv, enabled: llm.enabled },
        kinds: NOTE_KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k] })),
      };
    }],

    ['PATCH', /^\/api\/settings$/, async (_m, body) => {
      const patch = { ...body };
      if (patch.llmApiKey === '••••••••') delete patch.llmApiKey;
      store.settings.set(patch);
      const llm = resolveLLM(store);
      return { settings: { ...store.settings.all(), llmApiKey: llm.apiKey ? '••••••••' : '' }, llm: { configured: llm.configured, baseUrl: llm.baseUrl, model: llm.model, fromEnv: llm.fromEnv, enabled: llm.enabled } };
    }],

    ['POST', /^\/api\/llm\/test$/, async () => {
      const config = resolveLLM(store);
      if (!config.configured) throw new Error('未配置 API Key');
      const sample = await ping(config);
      return { ok: true, sample };
    }],
  ];

  return async function handleApi(req, res, url) {
    const path = url.pathname;
    const method = req.method.toUpperCase();
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = path.match(re);
      if (!match) continue;
      try {
        /*
         * 图片走 base64 JSON 上传：前端本来就在把 File 读成 data URL，
         * 复用同一套 JSON 管线就不必再手写 multipart 解析（零依赖）。
         * 代价是 base64 多占 ~33%，所以上限开得比普通接口宽。
         */
        const limit = /^\/api\/attachments$/.test(path) ? 24 * 1024 * 1024 : 8 * 1024 * 1024;
        const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req, limit);
        const result = await fn(match, body, url.searchParams, url.searchParams);
        if (result && result.__raw !== undefined) {
          return sendText(res, 200, result.__raw, result.headers);
        }
        if (result && result.__binary) {
          return sendBytes(res, 200, result.__binary, result.headers);
        }
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, err?.status || 400, { error: String(err?.message || err) });
      }
    }
    return sendJson(res, 404, { error: `未知接口：${method} ${path}` });
  };
}