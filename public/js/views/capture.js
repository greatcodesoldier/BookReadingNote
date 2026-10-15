/**
 * 快速记录台：粘贴 → 自动解析预览 → 一键保存。
 *
 * 设计目标：从「复制到别处的一段文字」到「存进系统并且打好标签」，
 * 最好只需要一次粘贴 + 一次回车。
 */
import { api } from '../api.js';
import { state, refresh, loadNotes } from '../state.js';
import { $, $$, el, esc, debounce, toast, openModal, confirmDialog, KINDS, KIND_LABEL, kindText, todayStr, copyText, mdLite } from '../util.js';
import { readClipboard, readDropped, readClipboardAsync, pickImageFiles, uploadImage, imageMarkdown } from '../images.js';

const MODES = [
  { id: 'auto', label: '自动识别' },
  { id: 'separator', label: '按 --- 分段' },
  { id: 'heading', label: '按标题分段' },
  { id: 'single', label: '整段作为一条' },
];

let rootEl = null;
let textarea = null;
let previewHost = null;
let statusEl = null;
let modeSelect = null;
let blocks = [];
let mode = 'auto';
let busy = false;

const SAMPLES = [
  {
    label: '摘录（书 + 页码）',
    text: `《思考，快与慢》 作者：丹尼尔·卡尼曼
类型：摘录
页码：P32
> 直觉是有代价的：它让我们在熟悉的情境里高效，在陌生的情境里自信地犯错。
#心理学 #决策`,
  },
  {
    label: '想法 + 标签',
    text: `今天读到系统1和系统2的分工，感觉和认知失调能连起来：人一旦为某个立场付出了努力，就会自动替它辩护。 #认知失调 #自我辩护`,
  },
  {
    label: '网页剪藏',
    text: `标题：为什么我们把沉没成本看得那么重
主题：决策
链接：https://example.com/article/123
日期：${todayStr()}
真正的损失不是已经付出的，而是你为了证明已经付出的没有白费而继续投入。 #沉没成本 #决策`,
  },
];

/* ------------------------------------------------------------------ 预览卡片 */

function renderTagInput(block, index) {
  const wrap = el('<div class="preview-tags" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"></div>');
  for (const [i, tag] of block.tags.entries()) {
    const chip = el(`<span class="tag-chip on">#${esc(tag)}<span class="x" title="移除">×</span></span>`);
    $('.x', chip).addEventListener('click', () => {
      block.tags.splice(i, 1);
      rerenderCard(index);
    });
    wrap.appendChild(chip);
  }
  const input = el(`<input class="tag-add" placeholder="+ 标签（回车）" list="all-tags" />`);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value.trim().replace(/^#/, '');
    if (v && !block.tags.includes(v)) block.tags.push(v);
    input.value = '';
    rerenderCard(index);
  });
  wrap.appendChild(input);
  return wrap;
}

function renderPreviewCard(block, index) {
  const dup = block.duplicateOf;
  const card = el(`
    <div class="preview-card ${dup ? 'dup' : ''}">
      <div class="preview-top">
        <span class="preview-index">${index + 1}</span>
        <input class="preview-title-input" value="${esc(block.title)}" placeholder="标题" />
        <button class="btn tiny" data-act="save">保存</button>
        <button class="btn tiny ghost" data-act="drop" title="丢弃这一条">✕</button>
      </div>
      <div class="preview-fields">
        <div class="field"><label>主题</label><input data-f="topic" value="${esc(block.topic)}" placeholder="自由填写，例如：决策 / 认知科学" list="all-topics" /></div>
        <div class="field"><label>位置</label><input data-f="location" value="${esc(block.location)}" placeholder="页码 / 章节" /></div>
        <div class="field"><label>日期</label><input data-f="noteDate" type="date" value="${esc(block.noteDate)}" /></div>
        <div class="field"><label>类型</label><input data-f="kind" value="${esc(kindText(block.kind))}" placeholder="自由填写，如：摘录 / 金句 / 案例" list="all-kinds" /></div>
        <div class="field"><label>作者</label><input data-f="author" value="${esc(block.author)}" placeholder="可选" /></div>
      </div>
      <div class="preview-body">${mdLite(block.content)}</div>
      ${dup ? `<div class="hint" style="color:var(--warn);margin-bottom:6px">⚠️ 系统里可能已有相同内容：${esc(dup.title || '（无标题）')}（保存时会自动跳过重复项）</div>` : ''}
      <div class="preview-tagrow"></div>
    </div>
  `);

  $('.preview-title-input', card).addEventListener('input', (e) => { block.title = e.target.value; });
  for (const input of $$('[data-f]', card)) {
    input.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      block[f] = e.target.value;
      // 类型是自由文本：填的是内置词就显示中文标签，自己起的名字就原样显示
      if (f === 'kind') block.kindLabel = KIND_LABEL[e.target.value] || e.target.value;
    });
  }
  $('[data-act="save"]', card).addEventListener('click', () => saveOne(index));
  $('[data-act="drop"]', card).addEventListener('click', () => {
    blocks.splice(index, 1);
    renderPreview();
  });
  $('.preview-tagrow', card).appendChild(renderTagInput(block, index));

  return card;
}

function rerenderCard(index) {
  renderPreview();
}

function renderPreview() {
  previewHost.innerHTML = '';
  if (!blocks.length) return;
  const head = el(`
    <div class="preview-top" style="margin:2px 0 6px">
      <span class="hint">识别到 <b style="color:var(--accent-text)">${blocks.length}</b> 条笔记，
        确认无误后点「全部保存」；标题与字段都可以直接改。</span>
      <span class="spacer"></span>
      <button class="btn tiny" data-act="save-all">全部保存</button>
    </div>
  `);
  $('[data-act="save-all"]', head).addEventListener('click', saveAll);
  previewHost.appendChild(head);

  const list = el('<div class="preview-list"></div>');
  blocks.forEach((b, i) => list.appendChild(renderPreviewCard(b, i)));
  previewHost.appendChild(list);
}

/* ------------------------------------------------------------------ 解析 */

const doPreview = debounce(async () => {
  const text = textarea.value;
  if (!text.trim()) {
    blocks = [];
    previewHost.innerHTML = '';
    setStatus('');
    return;
  }
  setStatus('解析中…');
  try {
    const res = await api.previewPaste({ text, mode, defaultDate: todayStr() });
    blocks = res.blocks;
    renderPreview();
    const s = res.stats;
    const bits = [`识别到 ${s.blocks} 条`];
    if (s.withTopic) bits.push(`${s.withTopic} 条带主题`);
    if (s.withLocation) bits.push(`${s.withLocation} 条带页码`);
    if (s.tags.length) bits.push(`标签 ${s.tags.map((t) => `#${t}`).join(' ')}`);
    setStatus(bits.join(' · '));
  } catch (err) {
    setStatus('');
    toast(err.message, 'err');
  }
}, 320);

function setStatus(html) {
  statusEl.innerHTML = html;
}

/* ------------------------------------------------------------------ 保存 */

function cleanBlock(b) {
  return {
    title: b.title,
    content: b.content,
    topic: b.topic,
    author: b.author,
    location: b.location,
    kind: b.kind,
    noteDate: b.noteDate,
    tags: b.tags,
    meta: b.meta || {},
  };
}

async function saveBlocks(list, { clearOnDone = false } = {}) {
  if (busy || !list.length) return;
  busy = true;
  try {
    const res = await api.saveBlocks({ blocks: list.map(cleanBlock), allowDuplicate: false });
    const parts = [];
    if (res.createdCount) parts.push(`保存了 ${res.createdCount} 条`);
    if (res.duplicateCount) parts.push(`跳过 ${res.duplicateCount} 条重复`);
    if (res.failed?.length) parts.push(`${res.failed.length} 条失败`);
    toast(parts.join('，') || '没有需要保存的内容', res.failed?.length ? 'warn' : 'ok');

    if (res.created?.length) {
      // 让「最近记录」立刻显示出来
      await refresh({ notes: true, facets: true, tags: true });
      state.lastCapture = res.created[0]?.id || null;
    }
    if (clearOnDone) {
      textarea.value = '';
      blocks = [];
      previewHost.innerHTML = '';
      setStatus('');
    }
    return res;
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    busy = false;
  }
}

async function saveAll() {
  await saveBlocks(blocks, { clearOnDone: true });
  textarea.focus();
}

async function saveOne(index) {
  const block = blocks[index];
  await saveBlocks([block]);
  blocks.splice(index, 1);
  renderPreview();
  if (!blocks.length) {
    textarea.value = '';
    setStatus('');
  } else {
    setStatus(`还剩 ${blocks.length} 条待保存`);
  }
}

/* ------------------------------------------------------------------ 图片 */

/** 在光标处插入文字；没有焦点时就追加到末尾 */
function insertAtCaret(str) {
  if (!str) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + str + after;
  const pos = start + str.length;
  textarea.selectionStart = pos;
  textarea.selectionEnd = pos;
  doPreview();
}

/** 让插入位置自成一行，避免图片和文字糊在一起 */
function padForInsert() {
  const v = textarea.value;
  const start = textarea.selectionStart ?? v.length;
  if (!start) return '';
  return v[start - 1] === '\n' ? '' : '\n';
}

/** 追加一条新的内容块（用 --- 分隔），光标落在末尾 */
function appendBlock(str) {
  const cur = textarea.value.trim();
  textarea.value = cur ? `${cur}\n---\n${str}` : str;
  const pos = textarea.value.length;
  textarea.selectionStart = pos;
  textarea.selectionEnd = pos;
  doPreview();
}

let uploading = 0;

async function insertImages(files) {
  if (!files?.length) return;
  uploading += files.length;
  setStatus(uploading > 1 ? `正在插入 ${uploading} 张图片…` : '正在插入图片…');
  for (const file of files) {
    try {
      const att = await uploadImage(file);
      insertAtCaret(`${padForInsert()}${imageMarkdown(att.url)}\n`);
      if (att.shrunk) {
        toast(`图片已自动缩小到 ${att.width}×${att.height}（原图 ${(att.originalBytes / 1024 / 1024).toFixed(1)}MB）`, 'ok', 3600);
      }
    } catch (err) {
      toast(`图片没能插入：${err.message}`, 'err', 5200);
    } finally {
      uploading -= 1;
    }
  }
  if (!uploading) setStatus(blocks.length ? `识别到 ${blocks.length} 条，确认后保存` : '');
}

/**
 * 处理一次粘贴：文字照常落进输入框，图片上传后插在光标处。
 * 返回 true 表示这次粘贴里确实有图片（调用方就知道不用再走默认逻辑了）。
 */
export async function handlePasteWithImages(event) {
  const { text, files } = readClipboard(event);
  if (!files.length) return false;
  const plain = text.trim();
  insertAtCaret(plain ? `${padForInsert()}${plain}\n` : '');
  await insertImages(files);
  return true;
}

/** 给外部用（比如全局 Ctrl+V 粘了一张截图）：保证记录台存在，再插图 */
export async function insertImagesIntoCapture(files) {
  getCapture();
  textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  await insertImages(files);
}

/* ------------------------------------------------------------------ 剪贴板 / 文件 */

async function pasteFromClipboard() {
  // 优先走能拿到图片的接口
  try {
    const { text, files } = await readClipboardAsync();
    if (!text.trim() && !files.length) { toast('剪贴板是空的', 'warn'); return; }
    // 按钮的语义是「再来一条」，所以沿用 --- 分段，别和上一条糊在一起
    if (text.trim()) appendBlock(text.trim());
    else textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    if (files.length) await insertImages(files);
    return;
  } catch {
    // 拿不到图片（或没授权）就退回只读文字
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { toast('剪贴板是空的', 'warn'); return; }
    appendBlock(text.trim());
  } catch {
    toast('浏览器不允许读取剪贴板，请直接用 Ctrl+V 粘贴到输入框', 'warn', 4200);
    textarea.focus();
  }
}

function readFiles(fileList) {
  for (const file of fileList) {
    if (file.size > 2 * 1024 * 1024) { toast(`${file.name} 超过 2MB，已跳过`, 'warn'); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      textarea.value = textarea.value ? `${textarea.value}\n---\n${text}` : text;
      doPreview();
    };
    reader.readAsText(file, 'utf-8');
  }
}

/* ------------------------------------------------------------------ 构建 */

function build() {
  // 注意：用一层 wrapper 包住，因为 el() 只返回第一个元素，
  // 直接并列写 datalist 会被丢掉，自动补全就失效了。
  rootEl = el(`
    <div class="capture-wrap">
      <div class="card capture">
        <textarea class="capture-input" placeholder="把读到的东西直接粘进来 ⤵&#10;&#10;· #标签 会自动被识别&#10;· 《书名》 / 作者 / 页码 / 日期 会自动提取&#10;· 截图 / 图片可以直接粘进来，和文字一起存&#10;· 用单独一行的 --- 可以一次贴多条&#10;&#10;也可以直接把 .md / .txt / 图片文件拖到这里"></textarea>
        <div class="capture-toolbar">
          <button class="btn primary" data-act="save-all">全部保存 <kbd>Ctrl</kbd><kbd>↵</kbd></button>
          <button class="btn" data-act="clip">📋 读剪贴板</button>
          <button class="btn" data-act="image" title="选一张或多张图片插入（也可以直接 Ctrl+V 粘截图）">🖼 图片</button>
          <select class="select" data-act="mode" style="width:auto;height:34px"></select>
          <button class="btn ghost" data-act="sample">示例</button>
          <span class="spacer"></span>
          <span class="capture-status"></span>
          <button class="btn ghost" data-act="clear">清空</button>
        </div>
        <div class="preview-host"></div>
      </div>
      <datalist id="all-tags"></datalist>
      <datalist id="all-topics"></datalist>
      <datalist id="all-kinds"></datalist>
    </div>
  `);

  textarea = $('.capture-input', rootEl);
  previewHost = $('.preview-host', rootEl);
  statusEl = $('.capture-status', rootEl);
  modeSelect = $('[data-act="mode"]', rootEl);
  modeSelect.innerHTML = MODES.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  modeSelect.addEventListener('change', () => { mode = modeSelect.value; doPreview(); });

  textarea.addEventListener('input', doPreview);
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveAll();
    }
  });
  // 粘贴：里面若带图片，就地插到光标处（文字照常落地）
  textarea.addEventListener('paste', (e) => {
    const files = readClipboard(e).files;
    if (!files.length) return;    // 纯文字粘贴交给浏览器默认行为
    e.preventDefault();
    handlePasteWithImages(e);
  });
  textarea.addEventListener('dragover', (e) => {
    e.preventDefault();
    textarea.classList.add('drag-over');
  });
  textarea.addEventListener('dragleave', () => textarea.classList.remove('drag-over'));
  textarea.addEventListener('drop', (e) => {
    e.preventDefault();
    textarea.classList.remove('drag-over');
    const { images, texts } = readDropped(e.dataTransfer);
    if (images.length) {
      // 拖拽没有可靠的光标位置，统一追加到末尾
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      insertImages(images);
    }
    if (texts.length) readFiles(texts);
  });

  $('[data-act="save-all"]', rootEl).addEventListener('click', saveAll);
  $('[data-act="clip"]', rootEl).addEventListener('click', pasteFromClipboard);
  $('[data-act="image"]', rootEl).addEventListener('click', async () => {
    const files = await pickImageFiles();
    insertImages(files);
  });
  $('[data-act="clear"]', rootEl).addEventListener('click', () => {
    textarea.value = '';
    blocks = [];
    previewHost.innerHTML = '';
    setStatus('');
    textarea.focus();
  });
  $('[data-act="sample"]', rootEl).addEventListener('click', () => {
    openModal({
      title: '粘贴示例',
      bodyHtml: `<p class="hint" style="margin:0 0 12px">点一个示例填入输入框，看看系统能自动识别出什么。</p>
        <div style="display:grid;gap:8px">
          ${SAMPLES.map((s, i) => `<button class="btn" data-i="${i}" style="justify-content:flex-start;height:auto;padding:10px 12px;text-align:left;display:block">
            <b>${esc(s.label)}</b><pre style="margin:6px 0 0;white-space:pre-wrap;font-size:12px;color:var(--text-dim);font-family:inherit">${esc(s.text)}</pre>
          </button>`).join('')}
        </div>`,
      onMount: (card, close) => {
        for (const btn of $$('button[data-i]', card)) {
          btn.addEventListener('click', () => {
            const s = SAMPLES[Number(btn.dataset.i)];
            textarea.value = s.text;
            close();
            textarea.focus();
            doPreview();
          });
        }
      },
    });
  });

  return rootEl;
}

/** 拿到（并复用）记录台 DOM，保证输入内容在视图切换时不丢 */
export function getCapture() {
  if (!rootEl) build();
  // 刷新标签/主题/类型的自动补全（都只是建议，可以随便填别的）
  const tagList = $('#all-tags', rootEl);
  const topicList = $('#all-topics', rootEl);
  const kindList = $('#all-kinds', rootEl);
  if (tagList) {
    tagList.innerHTML = state.tags
      .filter((t) => t.kind !== 'time')
      .map((t) => `<option value="${esc(t.name)}"></option>`)
      .join('');
  }
  if (topicList) {
    topicList.innerHTML = (state.facets?.topics || [])
      .map((t) => `<option value="${esc(t.name)}"></option>`)
      .join('');
  }
  if (kindList) {
    // 内置类型 + 你已经用过的自定义类型，全部只是候选
    const used = (state.facets?.kinds || []).map((k) => KIND_LABEL[k.kind] || k.kind);
    const builtin = KINDS.map((k) => k.label);
    kindList.innerHTML = [...new Set([...builtin, ...used])]
      .map((v) => `<option value="${esc(v)}"></option>`)
      .join('');
  }
  return rootEl;
}

export function focusCapture({ withText } = {}) {
  const node = getCapture();
  if (withText) {
    // 记录台里可能还有没保存的草稿，追加而不是覆盖，避免误丢内容
    const cur = textarea.value.trim();
    textarea.value = cur ? `${cur}\n---\n${withText.trim()}` : withText;
    doPreview();
  }
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 30);
}

export function captureInitialized() {
  return !!rootEl;
}