/**
 * 前端通用工具：DOM、格式化、轻量 Markdown 渲染、Toast、弹窗。
 */

export const KINDS = [
  { kind: 'excerpt', label: '摘录' },
  { kind: 'idea', label: '想法' },
  { kind: 'question', label: '疑问' },
  { kind: 'summary', label: '小结' },
  { kind: 'todo', label: '待办' },
];

export const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label]));

const BUILTIN_KINDS = new Set(KINDS.map((k) => k.kind));
/** 把内置的中文标签也认出来，方便「类型」输入框里手打了中文也能对上 */
export const KIND_BY_LABEL = Object.fromEntries(KINDS.map((k) => [k.label, k.kind]));

/** 显示用的类型文字：内置的显示中文，自定义的原样显示 */
export const kindText = (kind) => KIND_LABEL[kind] || String(kind ?? '');

/**
 * 类型角标的样式。
 * 类型是自由文本，所以**绝不能**把它直接拼进 class 属性（那等于把用户输入
 * 当 HTML/属性注入）。内置类型走 CSS 类配色，自定义类型按名字算一个稳定的色相。
 */
export function kindBadge(kind) {
  const raw = String(kind ?? '');
  if (BUILTIN_KINDS.has(raw)) return { cls: ` ${raw}`, style: '' };
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.codePointAt(0)) % 360;
  return { cls: ' kind-custom', style: ` style="--kind-h:${h}"` };
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/* ------------------------------------------------------------------ 时间显示 */

export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  const today = todayStr();
  if (dateStr === today) return '今天';
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (dateStr === todayStr(yest)) return '昨天';
  const thisYear = String(new Date().getFullYear());
  return y === thisYear ? `${Number(m)}月${Number(d)}日` : `${y}年${Number(m)}月${Number(d)}日`;
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ 轻量 Markdown */

/**
 * 允许出现在 src 里的图片地址：
 *  - 本系统自己的附件接口（粘贴图片后正文里就是它）
 *  - data:image/... （Markdown 导出会把图片内嵌成这种形式，再粘回来也要能看）
 *  - http(s) 外链
 * 其它一律不渲染成 <img>，原样当文字显示，避免莫名其妙的东西被当成图片加载。
 */
const IMG_SRC_OK = /^(?:\/api\/attachments\/[A-Za-z0-9_-]{4,64}|data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)]+)$/i;

/** ![说明](地址) → <img>；地址不合法就原样返回 */
function imgTag(alt, src) {
  if (!IMG_SRC_OK.test(src)) return null;
  const title = alt ? ` title="${alt}"` : '';
  return `<img src="${src}" alt="${alt || '图片'}"${title} loading="lazy" />`;
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 图片必须排在链接前面：否则 ![](x) 会先被当成链接，留下一个孤零零的 "!"
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, alt, src) => imgTag(alt, src) || whole);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s;
}

const RE_FENCE = /^\s*```/;
const RE_QUOTE = /^\s*>\s?/;
const RE_HEADING = /^\s*(#{1,4})\s+(.*)$/;
const RE_UL = /^\s*(?:[-*+•])\s+/;
const RE_OL = /^\s*\d+[.、)]\s+/;
const RE_BLANK = /^\s*$/;
// 整行就是一张图 → 单独成块，不要塞进 <p> 里（否则图片和文字挤在一行）
const RE_IMG_LINE = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/;
// 段落遇到这些行就停止；必须与上面各分支的判断保持一致，
// 否则会出现「停止条件命中但没有任何分支消费该行」→ 死循环。
const RE_PARA_STOP = new RegExp(
  `(?:${RE_FENCE.source}|${RE_QUOTE.source}|${RE_HEADING.source}|${RE_UL.source}|${RE_OL.source}|${RE_BLANK.source}|${RE_IMG_LINE.source})`,
);

/**
 * 极简 Markdown 渲染：够用即可（引用、标题、列表、代码、粗体、链接）。
 * 先转义再插入标签，天然避免 XSS。
 */
export function mdLite(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const flushList = (type, items) => {
    const tag = type === 'ol' ? 'ol' : 'ul';
    out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(RE_FENCE);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) buf.push(lines[i++]);
      i++; // 连同收尾的 ``` 一起跳过
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 引用
    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) buf.push(lines[i++].replace(RE_QUOTE, ''));
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
      continue;
    }

    // 标题（# 后面必须有空格，否则 "#标签" 应当算普通文字）
    const heading = line.match(RE_HEADING);
    if (heading) {
      const level = Math.min(4, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // 无序列表
    if (RE_UL.test(line)) {
      const buf = [];
      while (i < lines.length && RE_UL.test(lines[i])) buf.push(lines[i++].replace(RE_UL, ''));
      flushList('ul', buf);
      continue;
    }

    // 有序列表
    if (RE_OL.test(line)) {
      const buf = [];
      while (i < lines.length && RE_OL.test(lines[i])) buf.push(lines[i++].replace(RE_OL, ''));
      flushList('ol', buf);
      continue;
    }

    if (RE_BLANK.test(line)) { i++; continue; }

    // 整行一张图
    const imgLine = line.match(RE_IMG_LINE);
    if (imgLine) {
      i++;
      const tag = imgTag(imgLine[1], imgLine[2]);
      out.push(tag ? `<p class="md-img">${tag}</p>` : `<p>${inline(line)}</p>`);
      continue;
    }

    // 普通段落
    const para = [];
    while (i < lines.length && !RE_PARA_STOP.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]); // 兜底：无论如何都要前进，绝不停在原地
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

/* ------------------------------------------------------------------ 交互反馈 */

export function toast(message, type = 'ok', ms = 2600) {
  const host = $('#toast-host');
  if (!host) return;
  const node = el(`<div class="toast ${type}">${esc(message)}</div>`);
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

let modalCleanup = null;

export function closeModal() {
  const host = $('#modal-host');
  if (!host) return;
  host.hidden = true;
  host.innerHTML = '';
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
}

/**
 * 打开弹窗。actions: [{label, kind, onClick(close)}]
 */
export function openModal({ title, bodyHtml = '', actions = [], wide = false, onMount }) {
  const host = $('#modal-host');
  host.hidden = false;
  host.innerHTML = '';

  const card = el(`
    <div class="modal-card ${wide ? 'wide' : ''}">
      <h2 class="modal-title">${esc(title)}</h2>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions"></div>
    </div>
  `);

  const actionsEl = $('.modal-actions', card);
  for (const a of actions) {
    const btn = el(`<button class="btn ${a.kind || ''}">${esc(a.label)}</button>`);
    btn.addEventListener('click', async () => {
      const keep = await a.onClick?.(closeModal, card);
      if (keep !== false) closeModal();
    });
    actionsEl.appendChild(btn);
  }

  host.appendChild(card);
  const onBackdrop = (e) => { if (e.target === host) closeModal(); };
  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  host.addEventListener('mousedown', onBackdrop);
  document.addEventListener('keydown', onKey);
  modalCleanup = () => {
    host.removeEventListener('mousedown', onBackdrop);
    document.removeEventListener('keydown', onKey);
  };

  onMount?.(card, closeModal);
  const firstInput = $('input, textarea, select', card);
  firstInput?.focus();
  return card;
}

export function confirmDialog({ title, message, confirmLabel = '确定', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    openModal({
      title,
      bodyHtml: `<p style="margin:0;font-size:13.5px;line-height:1.8">${esc(message)}</p>`,
      actions: [
        { label: '取消', kind: 'ghost', onClick: () => { settled = true; resolve(false); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { settled = true; resolve(true); } },
      ],
    });
    const host = $('#modal-host');
    const obs = new MutationObserver(() => {
      if (host.hidden && !settled) { settled = true; obs.disconnect(); resolve(false); }
    });
    obs.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  });
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function download(filename, text, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function highlight(text, terms) {
  let s = esc(text);
  for (const t of terms || []) {
    if (!t || t.length < 2) continue;
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    s = s.replace(re, '<mark style="background:var(--accent-soft);color:var(--accent-text);border-radius:3px;padding:0 2px">$1</mark>');
  }
  return s;
}