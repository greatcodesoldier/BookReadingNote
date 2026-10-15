/**
 * 数据层：基于 Node 内置 node:sqlite（零外部依赖）。
 *
 * 设计要点
 *  - notes        : 每条「零散知识」= 一条笔记；topic 是自由填写的「主题」
 *  - tags         : 标签，分三类 kind = topic(主题标签) / time(时间) / custom(自定义)
 *  - note_tags    : 笔记↔标签，auto=1 表示由系统自动打出（时间标签、正文 #标签）
 *  - tag_suppress : 用户手动移除过的自动标签，避免重新解析时又被加回来
 *  - attachments  : 图片等二进制附件，直接以 BLOB 存在同一个库里
 *  - settings     : 键值配置（含可选的 LLM 配置）
 *
 * 图片为什么也放进这个 .db 文件：文档里承诺「备份 = 复制 data/notes.db」，
 * 图片一旦散落成目录里的散文件，这个承诺就不成立了（少拷一个目录 = 图全丢）。
 * 用 BLOB 存，备份、导出、迁移都还是「一个文件」的事。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { nowIso, timeTagNames, todayLocal, toDateStr, fingerprint } from './util.js';

/**
 * 内置类型。注意这只是「建议列表」和配色依据，**不是白名单** ——
 * 类型可以自由填写（比如自己写「金句」「案例」「金句摘抄」）。
 */
export const NOTE_KINDS = ['excerpt', 'idea', 'question', 'summary', 'todo'];
export const DEFAULT_KIND = 'idea';
export const TAG_KINDS = ['topic', 'time', 'custom'];

/** 类型最长长度，防止有人把整段话塞进类型里 */
const KIND_MAX = 16;

/**
 * 把填进来的类型规整一下：
 *  - 去首尾空白、压缩空格、限长
 *  - 内置类型的中文标签（摘录/想法/…）换算回内置键（excerpt/idea/…），
 *    这样界面上显示中文、存进去仍然是规范的键，配色和「疑问/待办」相关的分析都不受影响
 *  - 其它一律原样保留 —— 类型是自由文本
 */
export function normalizeKind(value, fallback = DEFAULT_KIND) {
  const raw = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, KIND_MAX);
  if (!raw) return fallback;
  return KIND_ALIAS.get(raw) || KIND_ALIAS.get(raw.toLowerCase()) || raw;
}

export const KIND_LABEL = {
  excerpt: '摘录',
  idea: '想法',
  question: '疑问',
  summary: '小结',
  todo: '待办',
};

/** 内置键 ⇄ 中文标签，两个方向都认 */
const KIND_ALIAS = new Map();
for (const [key, label] of Object.entries(KIND_LABEL)) {
  KIND_ALIAS.set(key, key);
  KIND_ALIAS.set(label, key);
}

const PALETTE = [
  '#5b8def', '#22a06b', '#e8912d', '#c65d9e', '#7c6cf0',
  '#0f9bb5', '#d4574e', '#6b7f8c', '#8a9c2a', '#b06a3b',
];

/*
 * 建表和建索引分成两段：老版本的列名是 source，需要先迁移列名再建索引，
 * 否则「CREATE INDEX ... ON notes(topic)」在旧库上会直接报错。
 */
/** 允许的图片类型；其它一律拒绝（这是个笔记工具，不是网盘） */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

/** 单张图片的大小上限（解码后） */
export const ATTACH_MAX_BYTES = 12 * 1024 * 1024;

/** 图片在正文里的引用形式：![](/api/attachments/<id>) */
export const ATTACH_URL_PREFIX = '/api/attachments/';

const TABLES = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL DEFAULT '',
  content      TEXT    NOT NULL,
  topic        TEXT    NOT NULL DEFAULT '',
  author       TEXT    NOT NULL DEFAULT '',
  location     TEXT    NOT NULL DEFAULT '',
  kind         TEXT    NOT NULL DEFAULT 'idea',
  note_date    TEXT    NOT NULL,
  starred      INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  fingerprint  TEXT    NOT NULL DEFAULT '',
  meta         TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  kind        TEXT    NOT NULL DEFAULT 'topic',
  color       TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  auto    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE IF NOT EXISTS tag_suppress (
  note_id INTEGER NOT NULL,
  tag_id  INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag_id)
);

/*
 * 图片附件。id 是随机串，同时充当 URL，所以内容一旦写进去就永不改变
 * （可以放心用 immutable 缓存）。note_id 只是「方便查的索引」，
 * 判定一张图到底还有没有人用，靠的是扫描正文里有没有引用它 ——
 * 因为同一条笔记可能被存成两份（允许重复），它们会共用同一张图。
 */
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT    PRIMARY KEY,
  note_id    INTEGER,
  mime       TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  data       BLOB    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_notes_date    ON notes(note_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notes_topic   ON notes(topic);
CREATE INDEX IF NOT EXISTS idx_notes_kind    ON notes(kind);
CREATE INDEX IF NOT EXISTS idx_notes_fp      ON notes(fingerprint);
CREATE INDEX IF NOT EXISTS idx_notes_starred ON notes(starred);
CREATE INDEX IF NOT EXISTS idx_tags_kind     ON tags(kind);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_attach_note   ON attachments(note_id);
`;

/**
 * 迁移：老版本把「主题」这个字段叫 source，现在统一叫 topic。
 * 直接把列改名，已有数据原样保留。
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
  if (cols.includes('source') && !cols.includes('topic')) {
    db.exec('ALTER TABLE notes RENAME COLUMN source TO topic');
  }
  // 老索引名一并换掉（RENAME COLUMN 会让它指向新列，但名字还叫 source）
  db.exec('DROP INDEX IF EXISTS idx_notes_source');
}

/** 从正文中提取 #标签（排除 Markdown 标题的 "# " 写法） */
export function extractInlineTags(text) {
  const out = [];
  const re = /(^|[\s(（[【,，。;；:：])#([^\s#,，。;；:：！？!?()（）[\]【】"'`]{1,24})/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    const name = m[2].trim();
    if (!name || /^\d+$/.test(name)) continue;
    out.push(name);
  }
  return out;
}

function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 100000;
  return PALETTE[h % PALETTE.length];
}

function row2note(row, tags) {
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { meta = {}; }
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    topic: row.topic,
    author: row.author,
    location: row.location,
    kind: row.kind,
    kindLabel: KIND_LABEL[row.kind] || row.kind,
    noteDate: row.note_date,
    starred: !!row.starred,
    archived: !!row.archived,
    fingerprint: row.fingerprint,
    meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: tags || [],
  };
}

export function createStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(TABLES);
  migrate(db);
  db.exec(INDEXES);

  /* ------------------------------------------------------------------ 内部工具 */

  const cacheTagId = new Map();

  function ensureTag(name, kind = 'topic', color = '') {
    const clean = String(name || '').trim().replace(/^#/, '');
    if (!clean) return null;
    const hit = cacheTagId.get(clean);
    if (hit) {
      if (kind !== 'topic') db.prepare('UPDATE tags SET kind = ? WHERE id = ? AND kind = \'topic\'').run(kind, hit);
      return hit;
    }
    const found = db.prepare('SELECT id FROM tags WHERE name = ?').get(clean);
    if (found) {
      cacheTagId.set(clean, found.id);
      return found.id;
    }
    const info = db
      .prepare('INSERT INTO tags (name, kind, color, description, created_at) VALUES (?,?,?,?,?)')
      .run(clean, TAG_KINDS.includes(kind) ? kind : 'topic', color || colorFor(clean), '', nowIso());
    const id = Number(info.lastInsertRowid);
    cacheTagId.set(clean, id);
    return id;
  }

  function tagIdByName(name) {
    const clean = String(name || '').trim().replace(/^#/, '');
    if (!clean) return null;
    const hit = cacheTagId.get(clean);
    if (hit) return hit;
    const found = db.prepare('SELECT id FROM tags WHERE name = ?').get(clean);
    if (found) { cacheTagId.set(clean, found.id); return found.id; }
    return null;
  }

  function tagsOf(noteId) {
    return db
      .prepare(
        `SELECT t.id, t.name, t.kind, t.color, nt.auto
           FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = ?
          ORDER BY CASE t.kind WHEN 'topic' THEN 0 WHEN 'custom' THEN 1 WHEN 'time' THEN 2 ELSE 3 END, t.name`,
      )
      .all(noteId)
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind, color: r.color, auto: !!r.auto }));
  }

  /** 时间标签：始终跟随 note_date 自动同步 */
  function syncTimeTags(noteId, dateStr) {
    const wanted = timeTagNames(dateStr).map((n) => ensureTag(n, 'time'));
    const current = db
      .prepare(`SELECT nt.tag_id AS id FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                 WHERE nt.note_id = ? AND t.kind = 'time'`)
      .all(noteId)
      .map((r) => r.id);
    const wantSet = new Set(wanted);
    for (const id of current) {
      if (!wantSet.has(id)) db.prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?').run(noteId, id);
    }
    for (const id of wanted) {
      if (id) db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id, auto) VALUES (?,?,1)').run(noteId, id);
    }
  }

  /** 正文中的 #标签 → 自动主题标签 */
  function syncContentTags(noteId, content) {
    for (const name of extractInlineTags(content)) {
      const id = ensureTag(name, 'topic');
      if (!id) continue;
      const suppressed = db.prepare('SELECT 1 FROM tag_suppress WHERE note_id = ? AND tag_id = ?').get(noteId, id);
      if (suppressed) continue;
      db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id, auto) VALUES (?,?,1)').run(noteId, id);
    }
  }

  function attachTags(noteId, names, { auto = 0, kind = 'topic' } = {}) {
    for (const raw of names || []) {
      const id = ensureTag(raw, kind);
      if (!id) continue;
      db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id, auto) VALUES (?,?,?)').run(noteId, id, auto ? 1 : 0);
    }
  }

  function getSetting(key, fallback = '') {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  function autoTagEnabled() {
    return getSetting('autoTagFromContent', '1') !== '0';
  }

  function getNote(id) {
    const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(id));
    if (!row) return null;
    return row2note(row, tagsOf(row.id));
  }

  /* ------------------------------------------------------------------ 图片附件 */

  /** 去掉路径和多余字符，只留一个能看的文件名 */
  function cleanName(name) {
    return String(name || '')
      .replace(/[\\/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  /** 从 data URL（或裸 base64）里解出图片字节 */
  function decodeImagePayload(input = {}) {
    const dataUrl = String(input.dataUrl || input.data || '');
    let mime = String(input.mime || '').toLowerCase().trim();
    let b64 = dataUrl;
    const m = dataUrl.match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s);
    if (m) { mime = m[1].toLowerCase(); b64 = m[2]; }
    if (!mime) throw new Error('缺少图片类型');
    if (!IMAGE_MIMES.includes(mime)) {
      throw new Error(`不支持的图片格式：${mime}（只收 PNG / JPEG / GIF / WebP / BMP）`);
    }
    if (!b64 || !b64.trim()) throw new Error('图片内容是空的');
    // base64 解出来之前先按长度粗算一遍，避免为大图先分配一整块内存
    const approx = Math.floor(b64.replace(/\s/g, '').length * 3 / 4);
    if (approx > ATTACH_MAX_BYTES) {
      throw new Error(`图片太大了（约 ${(approx / 1024 / 1024).toFixed(1)}MB，上限 ${ATTACH_MAX_BYTES / 1024 / 1024}MB）`);
    }
    const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    if (!buf.length) throw new Error('图片解码失败');
    if (buf.length > ATTACH_MAX_BYTES) {
      throw new Error(`图片太大了（${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${ATTACH_MAX_BYTES / 1024 / 1024}MB）`);
    }
    return { mime, buf };
  }

  /**
   * 存一张图片。此时它还没有归属（note_id 为空）——
   * 等正文被保存时，linkAttachments() 会把引用它的笔记认出来。
   */
  function putAttachment(input = {}) {
    const { mime, buf } = decodeImagePayload(input);
    const id = randomBytes(9).toString('base64url'); // 12 个字符，URL 安全
    const width = Number(input.width) > 0 ? Math.round(Number(input.width)) : 0;
    const height = Number(input.height) > 0 ? Math.round(Number(input.height)) : 0;
    db.prepare(
      `INSERT INTO attachments (id, note_id, mime, name, bytes, width, height, data, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, null, mime, cleanName(input.name), buf.length, width, height, buf, nowIso());
    return attachmentMeta(id);
  }

  /** 附件元信息（不含字节） */
  function attachmentMeta(id) {
    const row = db
      .prepare('SELECT id, note_id, mime, name, bytes, width, height, created_at FROM attachments WHERE id = ?')
      .get(String(id));
    if (!row) return null;
    return {
      id: row.id,
      noteId: row.note_id ?? null,
      mime: row.mime,
      name: row.name,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      url: ATTACH_URL_PREFIX + row.id,
      createdAt: row.created_at,
    };
  }

  /** 附件字节（含 mime），供 HTTP 直接返回 */
  function attachmentData(id) {
    const row = db.prepare('SELECT id, mime, name, bytes, data FROM attachments WHERE id = ?').get(String(id));
    if (!row) return null;
    return { id: row.id, mime: row.mime, name: row.name, bytes: row.bytes, data: Buffer.from(row.data) };
  }

  /**
   * 正文存下来之后，把里面的图片认领到这条笔记上。
   * 用纯 SQL 在正文里找 '/api/attachments/<id>'，不用把正文捞到 JS 里。
   */
  function linkAttachments(noteId, content) {
    const text = String(content || '');
    if (!text.includes(ATTACH_URL_PREFIX)) return 0;
    // 连右括号一起匹配，避免 id 互为前缀时认错人（abc 撞上 abcdef）
    const info = db
      .prepare(`UPDATE attachments SET note_id = ? WHERE note_id IS NULL AND instr(?, ? || id || ')') > 0`)
      .run(Number(noteId), text, ATTACH_URL_PREFIX);
    return info.changes;
  }

  /**
   * 清理没人用的图片：既不属于任何现存笔记、正文里也没人引用、而且放置超过 graceDays 天。
   * graceDays 是为了不误删「刚粘进记录台、还没点保存」的草稿里的图。
   */
  function gcAttachments({ graceDays = 7 } = {}) {
    /*
     * graceDays = 0 表示「不设宽限」：凡是没人引用的立刻清理。
     * 不能简单写成 now - 0 天 —— 那样分界线就是此刻，而此刻刚存进来的图
     * created_at 并不「小于」此刻，结果一张都清不掉。
     */
    const cutoff = graceDays > 0
      ? new Date(Date.now() - graceDays * 86400000).toISOString()
      : '9999-12-31T23:59:59.999Z';
    const candidates = db
      .prepare(
        `SELECT id FROM attachments
          WHERE created_at < ?
            AND (note_id IS NULL OR note_id NOT IN (SELECT id FROM notes))`,
      )
      .all(cutoff);
    let removed = 0;
    for (const { id } of candidates) {
      // 同一条笔记可能存了两份，共用一张图：只要还有任意一条正文引用它就不能删
      const used = db.prepare('SELECT 1 FROM notes WHERE instr(content, ?) > 0 LIMIT 1').get(ATTACH_URL_PREFIX + id + ')');
      if (used) continue;
      db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
      removed++;
    }
    return { removed, scanned: candidates.length };
  }

  function attachmentStats() {
    const row = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(bytes),0) AS b FROM attachments').get();
    return { attachments: row.c, attachmentBytes: row.b };
  }

  /** 还有没有笔记在正文里引用这张图 */
  function attachmentInUse(id) {
    return !!db.prepare('SELECT 1 FROM notes WHERE instr(content, ?) > 0 LIMIT 1').get(ATTACH_URL_PREFIX + id + ')');
  }

  /**
   * 删掉一张图片。被笔记引用着的会被拒绝 ——
   * 否则那条笔记里就会留下一张永远加载不出来的破图。
   */
  function removeAttachment(id) {
    const meta = attachmentMeta(id);
    if (!meta) return { deleted: false, reason: 'not-found' };
    if (attachmentInUse(id)) return { deleted: false, reason: 'in-use' };
    db.prepare('DELETE FROM attachments WHERE id = ?').run(String(id));
    return { deleted: true };
  }

  /* ------------------------------------------------------------------ 笔记写入 */

  function createNote(input = {}, opts = {}) {
    const content = String(input.content ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!content.trim()) throw new Error('内容为空，无法保存');
    const date = toDateStr(input.noteDate || input.note_date) || todayLocal();
    // 类型可以自由填写，内置的几种只是建议值
    const kind = normalizeKind(input.kind);
    const fp = fingerprint(content);

    if (opts.allowDuplicate !== true) {
      const dup = db
        .prepare('SELECT * FROM notes WHERE fingerprint = ? AND topic = ? LIMIT 1')
        .get(fp, String(input.topic ?? ''));
      if (dup) return { duplicate: true, note: row2note(dup, tagsOf(dup.id)) };
    }

    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO notes (title, content, topic, author, location, kind, note_date, starred, archived, fingerprint, meta, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        String(input.title ?? '').slice(0, 200),
        content,
        String(input.topic ?? '').slice(0, 200),
        String(input.author ?? '').slice(0, 120),
        String(input.location ?? '').slice(0, 80),
        kind,
        date,
        input.starred ? 1 : 0,
        input.archived ? 1 : 0,
        fp,
        JSON.stringify(input.meta ?? {}),
        input.createdAt || now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    attachTags(id, input.tags || [], { auto: input.tagsAuto ? 1 : 0 });
    syncTimeTags(id, date);
    if (autoTagEnabled()) syncContentTags(id, content);
    linkAttachments(id, content); // 正文里的图片归到这条笔记名下
    return { duplicate: false, note: getNote(id) };
  }

  function updateNote(id, patch = {}) {
    const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(id));
    if (!existing) return null;
    const fields = {
      title: patch.title ?? existing.title,
      content: patch.content ?? existing.content,
      topic: patch.topic ?? existing.topic,
      author: patch.author ?? existing.author,
      location: patch.location ?? existing.location,
      // 类型可以自由填写；显式清空时退回默认的「想法」
      kind: patch.kind === undefined ? existing.kind : normalizeKind(patch.kind),
      note_date: toDateStr(patch.noteDate ?? patch.note_date) || existing.note_date,
      starred: patch.starred === undefined ? existing.starred : (patch.starred ? 1 : 0),
      archived: patch.archived === undefined ? existing.archived : (patch.archived ? 1 : 0),
      meta: patch.meta === undefined ? existing.meta : JSON.stringify(patch.meta),
    };
    fields.fingerprint = fingerprint(fields.content);
    db.prepare(
      `UPDATE notes SET title=?, content=?, topic=?, author=?, location=?, kind=?, note_date=?,
              starred=?, archived=?, fingerprint=?, meta=?, updated_at=? WHERE id=?`,
    ).run(
      fields.title, fields.content, fields.topic, fields.author, fields.location, fields.kind,
      fields.note_date, fields.starred, fields.archived, fields.fingerprint, fields.meta, nowIso(), Number(id),
    );
    if (patch.content !== undefined && autoTagEnabled()) syncContentTags(Number(id), fields.content);
    if (patch.content !== undefined) linkAttachments(Number(id), fields.content);
    if (patch.noteDate !== undefined || patch.note_date !== undefined) syncTimeTags(Number(id), fields.note_date);
    return getNote(id);
  }

  function deleteNote(id) {
    const info = db.prepare('DELETE FROM notes WHERE id = ?').run(Number(id));
    db.prepare('DELETE FROM tag_suppress WHERE note_id = ?').run(Number(id));
    return info.changes > 0;
  }

  function addTags(id, names, { auto = 0, kind = 'topic' } = {}) {
    const noteId = Number(id);
    if (!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(noteId)) return null;
    for (const raw of names || []) {
      const clean = String(raw || '').trim().replace(/^#/, '');
      if (!clean) continue;
      const tid = ensureTag(clean, kind);
      if (!tid) continue;
      db.prepare('DELETE FROM tag_suppress WHERE note_id = ? AND tag_id = ?').run(noteId, tid);
      db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id, auto) VALUES (?,?,?)').run(noteId, tid, auto ? 1 : 0);
    }
    return getNote(noteId);
  }

  function removeTags(id, refs) {
    const noteId = Number(id);
    for (const ref of refs || []) {
      let tid = Number.isInteger(ref) ? ref : tagIdByName(ref);
      if (!tid && ref && typeof ref === 'object') tid = ref.id;
      if (!tid) continue;
      db.prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?').run(noteId, tid);
      // 记住「用户不想要这个自动标签」，避免下次解析又被加回来
      const tag = db.prepare('SELECT kind FROM tags WHERE id = ?').get(tid);
      if (tag && tag.kind === 'topic') {
        db.prepare('INSERT OR IGNORE INTO tag_suppress (note_id, tag_id) VALUES (?,?)').run(noteId, tid);
      }
    }
    return getNote(noteId);
  }

  /* ------------------------------------------------------------------ 清单 / 检索 */

  function buildWhere(filter = {}) {
    const where = [];
    const params = [];
    if (!filter.includeArchived) where.push('n.archived = 0');

    if (filter.q) {
      for (const term of String(filter.q).split(/\s+/).filter(Boolean)) {
        where.push('(n.title LIKE ? OR n.content LIKE ? OR n.topic LIKE ? OR n.author LIKE ?)');
        const like = `%${term}%`;
        params.push(like, like, like, like);
      }
    }
    if (filter.topic) { where.push('n.topic LIKE ?'); params.push(`%${filter.topic}%`); }
    if (filter.author) { where.push('n.author LIKE ?'); params.push(`%${filter.author}%`); }
    if (filter.kinds?.length) {
      where.push(`n.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
    if (filter.from) { where.push('n.note_date >= ?'); params.push(filter.from); }
    if (filter.to) { where.push('n.note_date <= ?'); params.push(filter.to); }
    if (filter.starred) where.push('n.starred = 1');
    if (filter.ids?.length) {
      where.push(`n.id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids.map(Number));
    }

    const tagNames = (filter.tags || []).map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean);
    if (tagNames.length) {
      const ph = tagNames.map(() => '?').join(',');
      if ((filter.tagMode || 'all') === 'any') {
        where.push(`n.id IN (SELECT nt.note_id FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE t.name IN (${ph}))`);
      } else {
        where.push(`n.id IN (
            SELECT nt.note_id FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
             WHERE t.name IN (${ph}) GROUP BY nt.note_id HAVING COUNT(DISTINCT t.id) = ?)`);
      }
      params.push(...tagNames);
      if ((filter.tagMode || 'all') !== 'any') params.push(tagNames.length);
    }
    if (filter.excludeTags?.length) {
      const names = filter.excludeTags.map((t) => String(t).replace(/^#/, ''));
      where.push(`n.id NOT IN (SELECT nt.note_id FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE t.name IN (${names.map(() => '?').join(',')}))`);
      params.push(...names);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  const SORT_MAP = {
    'date-desc': 'n.note_date DESC, n.id DESC',
    'date-asc': 'n.note_date ASC, n.id ASC',
    'created-desc': 'n.created_at DESC, n.id DESC',
    'updated-desc': 'n.updated_at DESC, n.id DESC',
    'topic-asc': "n.topic ASC, n.note_date DESC",
    'starred-desc': 'n.starred DESC, n.note_date DESC, n.id DESC',
  };

  function listNotes(filter = {}) {
    const { sql, params } = buildWhere(filter);
    const order = SORT_MAP[filter.sort] || SORT_MAP['date-desc'];
    const limit = Math.min(1000, Math.max(1, Number(filter.limit) || 100));
    const offset = Math.max(0, Number(filter.offset) || 0);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM notes n ${sql}`).get(...params).c;
    const rows = db.prepare(`SELECT n.* FROM notes n ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const ids = rows.map((r) => r.id);
    const tagMap = new Map();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      for (const r of db
        .prepare(`SELECT nt.note_id, t.id, t.name, t.kind, t.color, nt.auto
                    FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                   WHERE nt.note_id IN (${ph})
                   ORDER BY CASE t.kind WHEN 'topic' THEN 0 WHEN 'custom' THEN 1 ELSE 2 END, t.name`)
        .all(...ids)) {
        if (!tagMap.has(r.note_id)) tagMap.set(r.note_id, []);
        tagMap.get(r.note_id).push({ id: r.id, name: r.name, kind: r.kind, color: r.color, auto: !!r.auto });
      }
    }
    return { total, count: rows.length, offset, limit, notes: rows.map((r) => row2note(r, tagMap.get(r.id) || [])) };
  }

  function findDuplicate(content, topic = '') {
    const row = db.prepare('SELECT id, title FROM notes WHERE fingerprint = ? AND topic = ? LIMIT 1').get(fingerprint(content), topic);
    return row || null;
  }

  /* ------------------------------------------------------------------ 标签管理 */

  function listTags({ withCounts = true, includeTime = true } = {}) {
    const rows = db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
                       WHERE nt.tag_id = t.id AND n.archived = 0) AS count
           FROM tags t ORDER BY t.kind, t.name`,
      )
      .all();
    return rows
      .filter((r) => includeTime || r.kind !== 'time')
      .map((r) => ({
        id: r.id, name: r.name, kind: r.kind, color: r.color || colorFor(r.name),
        description: r.description, count: withCounts ? r.count : undefined,
      }));
  }

  function getTagByName(name) {
    return db.prepare('SELECT * FROM tags WHERE name = ?').get(String(name).replace(/^#/, '')) || null;
  }

  function createTag({ name, kind = 'topic', color = '', description = '' }) {
    const id = ensureTag(name, kind, color);
    if (!id) throw new Error('标签名不能为空');
    if (description) db.prepare('UPDATE tags SET description = ? WHERE id = ?').run(description, id);
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
  }

  function updateTag(id, patch = {}) {
    const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(id));
    if (!row) return null;
    const name = patch.name !== undefined ? String(patch.name).trim().replace(/^#/, '') : row.name;
    if (!name) throw new Error('标签名不能为空');
    const kind = TAG_KINDS.includes(patch.kind) ? patch.kind : row.kind;
    if (name !== row.name) {
      const clash = db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(name, row.id);
      // 重名 → 先把对方并进来，避免出现两个同名标签
      if (clash) mergeTags([clash.id], row.id);
      cacheTagId.delete(row.name);
    }
    db.prepare('UPDATE tags SET name=?, kind=?, color=?, description=? WHERE id=?').run(
      name, kind, patch.color ?? row.color, patch.description ?? row.description, row.id,
    );
    cacheTagId.set(name, row.id);
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(row.id);
  }

  function mergeTags(fromIds, intoId) {
    const target = Number(intoId);
    for (const fid of (fromIds || []).map(Number)) {
      if (!fid || fid === target) continue;
      const src = db.prepare('SELECT * FROM tags WHERE id = ?').get(fid);
      if (!src) continue;
      const rows = db.prepare('SELECT note_id, auto FROM note_tags WHERE tag_id = ?').all(fid);
      for (const r of rows) {
        db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id, auto) VALUES (?,?,?)').run(r.note_id, target, r.auto);
      }
      db.prepare('DELETE FROM tags WHERE id = ?').run(fid);
      cacheTagId.delete(src.name);
    }
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(target);
  }

  function deleteTag(id, { purge = false } = {}) {
    const tagId = Number(id);
    if (purge) db.prepare('DELETE FROM notes WHERE id IN (SELECT note_id FROM note_tags WHERE tag_id = ?)').run(tagId);
    const info = db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
    if (info.changes) {
      for (const [k, v] of cacheTagId) if (v === tagId) cacheTagId.delete(k);
    }
    return info.changes > 0;
  }

  /* ------------------------------------------------------------------ 分面统计 */

  function facets(filter = {}) {
    const base = buildWhere({ ...filter, limit: undefined, offset: undefined });
    const scope = `n.id IN (SELECT n.id FROM notes n ${base.sql})`;

    const tags = db
      .prepare(
        `SELECT t.id, t.name, t.kind, t.color, COUNT(*) AS count
           FROM note_tags nt JOIN tags t ON t.id = nt.tag_id JOIN notes n ON n.id = nt.note_id
          WHERE n.archived = 0 AND ${scope}
          GROUP BY t.id ORDER BY count DESC, t.name`,
      )
      .all(...base.params)
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind, color: r.color || colorFor(r.name), count: r.count }));

    const topics = db
      .prepare(
        `SELECT n.topic AS name, COUNT(*) AS count, MIN(n.note_date) AS first, MAX(n.note_date) AS last
           FROM notes n WHERE n.archived = 0 AND n.topic <> '' AND ${scope}
          GROUP BY n.topic ORDER BY count DESC, name`,
      )
      .all(...base.params);

    const kinds = db
      .prepare(`SELECT n.kind, COUNT(*) AS count FROM notes n WHERE n.archived = 0 AND ${scope} GROUP BY n.kind ORDER BY count DESC`)
      .all(...base.params);

    const timeline = db
      .prepare(
        `SELECT substr(n.note_date,1,7) AS month, COUNT(*) AS count
           FROM notes n WHERE n.archived = 0 AND ${scope}
          GROUP BY month ORDER BY month DESC`,
      )
      .all(...base.params);

    const totals = db
      .prepare(`SELECT COUNT(*) AS total, SUM(n.starred) AS starred, MIN(n.note_date) AS first, MAX(n.note_date) AS last
                  FROM notes n WHERE n.archived = 0 AND ${scope}`)
      .get(...base.params);

    return {
      tags, topics, kinds, timeline,
      totals: {
        total: totals.total || 0,
        starred: totals.starred || 0,
        first: totals.first || null,
        last: totals.last || null,
      },
    };
  }

  /* ------------------------------------------------------------------ 设置 / 导入导出 */

  function getSettings() {
    const out = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
    return out;
  }

  function setSettings(patch = {}) {
    for (const [k, v] of Object.entries(patch)) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(k, String(v ?? ''));
    }
    return getSettings();
  }

  function exportAll() {
    const rows = db.prepare('SELECT * FROM notes ORDER BY note_date, id').all();
    const tagRows = db.prepare('SELECT * FROM tags').all();
    const links = db.prepare('SELECT * FROM note_tags').all();
    const byId = new Map(tagRows.map((t) => [t.id, t]));
    const tagMap = new Map();
    for (const l of links) {
      if (!tagMap.has(l.note_id)) tagMap.set(l.note_id, []);
      const t = byId.get(l.tag_id);
      if (t) tagMap.get(l.note_id).push({ name: t.name, kind: t.kind, auto: !!l.auto });
    }
    // 图片也一起装进备份（base64）：这样「导出 → 换台机器 → 导入」之后图还在
    const attachments = db
      .prepare('SELECT id, mime, name, bytes, width, height, data, created_at FROM attachments ORDER BY created_at')
      .all()
      .map((a) => ({
        id: a.id, mime: a.mime, name: a.name, bytes: a.bytes,
        width: a.width, height: a.height, createdAt: a.created_at,
        data: Buffer.from(a.data).toString('base64'),
      }));
    return {
      format: 'reading-notes/v1',
      exportedAt: nowIso(),
      count: rows.length,
      notes: rows.map((r) => {
        const n = row2note(r, []);
        return { ...n, tags: tagMap.get(r.id) || [] };
      }),
      attachments,
    };
  }

  function importAll(payload, { mode = 'skip' } = {}) {
    const notes = Array.isArray(payload) ? payload : payload?.notes;
    if (!Array.isArray(notes)) throw new Error('导入数据格式不正确：缺少 notes 数组');
    // 先把图片恢复进去，这样后面保存笔记时正文里的图片引用就立刻有效了
    let attachments = 0, attachmentsSkipped = 0;
    for (const a of (Array.isArray(payload) ? [] : payload?.attachments) || []) {
      const id = String(a?.id || '').trim();
      if (!id || !a?.data) { attachmentsSkipped++; continue; }
      if (db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(id)) { attachmentsSkipped++; continue; }
      try {
        const { mime, buf } = decodeImagePayload({ data: a.data, mime: a.mime, name: a.name });
        db.prepare(
          `INSERT INTO attachments (id, note_id, mime, name, bytes, width, height, data, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(id, null, mime, cleanName(a.name), buf.length,
          Number(a.width) > 0 ? Math.round(Number(a.width)) : 0,
          Number(a.height) > 0 ? Math.round(Number(a.height)) : 0,
          buf, a.createdAt || nowIso());
        attachments++;
      } catch { attachmentsSkipped++; }
    }

    let created = 0, skipped = 0;
    for (const n of notes) {
      const content = String(n.content ?? '');
      if (!content.trim()) { skipped++; continue; }
      if (mode === 'skip' && findDuplicate(content, String(n.topic ?? n.source ?? ''))) { skipped++; continue; }
      createNote({
        title: n.title || '', content,
        // 兼容旧备份：那时候「主题」这个字段叫 source
        topic: n.topic ?? n.source ?? '',
        author: n.author || '',
        location: n.location || '', kind: n.kind || DEFAULT_KIND, noteDate: n.noteDate || n.note_date,
        starred: n.starred, meta: n.meta || {},
        tags: (n.tags || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean),
      });
      created++;
    }
    return { created, skipped, total: notes.length, attachments, attachmentsSkipped };
  }

  function stats() {
    const n = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE archived = 0').get().c;
    const t = db.prepare('SELECT COUNT(*) AS c FROM tags').get().c;
    const s = db.prepare("SELECT COUNT(DISTINCT topic) AS c FROM notes WHERE topic <> '' AND archived = 0").get().c;
    return { notes: n, tags: t, topics: s, ...attachmentStats(), dbPath };
  }

  /** 直接执行只读 SQL（供分析模块使用） */
  function query(sql, params = []) {
    return db.prepare(sql).all(...params);
  }

  return {
    dbPath,
    raw: db,
    notes: { create: createNote, get: getNote, list: listNotes, update: updateNote, delete: deleteNote, addTags, removeTags, findDuplicate },
    tags: {
      list: listTags, create: createTag, update: updateTag, remove: deleteTag, merge: mergeTags,
      byName: getTagByName, ensure: ensureTag,
    },
    facets,
    settings: { all: getSettings, set: setSettings, get: getSetting },
    attachments: {
      put: putAttachment, meta: attachmentMeta, data: attachmentData, remove: removeAttachment,
      inUse: attachmentInUse, gc: gcAttachments, stats: attachmentStats,
    },
    io: { exportAll, importAll },
    stats,
    query,
  };
}