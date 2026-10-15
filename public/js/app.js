/**
 * 应用外壳：导航、侧栏分面、路由、快捷键、全局粘贴。
 */
import {
  state, initState, on, emit, navigate, VIEWS, loadNotes, loadFacets,
  setFilter, toggleTagFilter, resetFilter, filterParams, loadTags,
} from './state.js';
import { renderNotes, renderSelectionBarExternal } from './views/notes.js';
import { renderAnalyze } from './views/analyze.js';
import { renderTags } from './views/tags.js';
import { renderTimeline } from './views/timeline.js';
import { renderSettings, applyTheme } from './views/settings.js';
import { getCapture, focusCapture, insertImagesIntoCapture } from './views/capture.js';
import { readClipboard } from './images.js';
import { $, el, esc, debounce, toast, todayStr, fmtDate } from './util.js';

const RENDERERS = {
  notes: renderNotes,
  analyze: renderAnalyze,
  timeline: renderTimeline,
  tags: renderTags,
  settings: renderSettings,
};

const main = $('#main');
const sidebar = $('#sidebar');
const nav = $('#nav');
const search = $('#search');

const expanded = new Set();

/* ------------------------------------------------------------------ 导航 */

function renderNav() {
  nav.innerHTML = '';
  for (const v of VIEWS) {
    const btn = el(`<button class="nav-btn ${state.view === v.id ? 'active' : ''}">${v.label}</button>`);
    btn.addEventListener('click', () => {
      if (state.view === v.id) { renderMain(); return; }
      navigate(v.id);
    });
    nav.appendChild(btn);
  }
}

/* ------------------------------------------------------------------ 侧栏 */

function sbItem({ label, count, active, color, onClick, title, bold }) {
  const item = el(`<button class="sb-item ${active ? 'active' : ''}" title="${esc(title || label)}">
    ${color ? `<span class="dot" style="background:${esc(color)}"></span>` : ''}
    <span class="label" ${bold ? 'style="font-weight:600"' : ''}>${esc(label)}</span>
    ${count !== undefined ? `<span class="count">${count}</span>` : ''}
  </button>`);
  item.addEventListener('click', onClick);
  return item;
}

function sbSection(title, nodes, { collapseKey } = {}) {
  const sec = el(`<div class="sb-section"><div class="sb-title"><span>${esc(title)}</span></div></div>`);
  const titleEl = $('.sb-title', sec);
  const list = el('<div class="sb-collapse"></div>');
  const isLong = nodes.length > 9;
  const isOpen = !collapseKey || expanded.has(collapseKey);
  const shown = isLong && !isOpen ? nodes.slice(0, 9) : nodes;
  for (const n of shown) list.appendChild(n);
  if (isLong) {
    const toggle = el(`<button class="sb-item" style="color:var(--text-faint);font-size:12px">
      <span class="label">${isOpen ? '收起' : `展开其余 ${nodes.length - 9} 个`}</span></button>`);
    toggle.addEventListener('click', () => {
      if (expanded.has(collapseKey)) expanded.delete(collapseKey); else expanded.add(collapseKey);
      renderSidebar();
    });
    list.appendChild(toggle);
  }
  if (list.childElementCount) sec.appendChild(list);
  else sec.appendChild(el('<div class="sb-empty">—</div>'));
  void titleEl;
  return sec;
}

function renderSidebar() {
  sidebar.innerHTML = '';
  const f = state.filter;
  const facets = state.facets;
  const totals = facets?.totals || {};

  /* 快捷视图 */
  const quick = [];
  quick.push(sbItem({
    label: '全部笔记', count: totals.total ?? 0,
    active: !f.q && !f.tags.length && !f.topic && !f.from && !f.to && !f.kinds.length && !f.starred,
    onClick: () => { resetFilter(); search.value = ''; emit('filter'); },
    bold: true,
  }));
  quick.push(sbItem({
    label: '⭐ 星标', count: totals.starred ?? 0, active: f.starred,
    onClick: () => setFilter({ starred: true }, { label: '仅星标' }),
  }));
  quick.push(sbItem({
    label: '今天', active: f.from === todayStr() && f.to === todayStr(),
    onClick: () => setFilter({ from: todayStr(), to: todayStr() }, { label: '今天' }),
  }));
  const d7 = new Date(); d7.setDate(d7.getDate() - 6);
  quick.push(sbItem({
    label: '最近 7 天', active: f.from === todayStr(d7),
    onClick: () => setFilter({ from: todayStr(d7), to: '' }, { label: '最近 7 天' }),
  }));
  const d30 = new Date(); d30.setDate(d30.getDate() - 29);
  quick.push(sbItem({
    label: '最近 30 天', active: f.from === todayStr(d30),
    onClick: () => setFilter({ from: todayStr(d30), to: '' }, { label: '最近 30 天' }),
  }));
  sidebar.appendChild(sbSection('快捷视图', quick));

  /* 主题标签 */
  const tagSearchInput = el(`<input class="sb-search" placeholder="筛选标签…" value="${esc(state.tagSearch)}" />`);
  tagSearchInput.addEventListener('input', debounce(() => {
    state.tagSearch = tagSearchInput.value;
    renderSidebar();
    const next = $('.sb-search', sidebar);
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  }, 180));

  const topicTags = (facets?.tags || []).filter((t) => t.kind === 'topic' || t.kind === 'custom');
  const filtered = topicTags.filter((t) => !state.tagSearch || t.name.includes(state.tagSearch));
  const tagNodes = filtered.map((t) => sbItem({
    label: `#${t.name}`, count: t.count, color: t.color,
    active: f.tags.includes(t.name),
    title: `${t.name}（${t.count} 条）`,
    onClick: () => toggleTagFilter(t.name),
  }));
  // 这里叫「标签」是为了和下面那个自由填写的「主题」字段区分开
  const tagSection = sbSection('标签', tagNodes, { collapseKey: 'tags' });
  $('.sb-title', tagSection).appendChild(el('<span></span>'));
  tagSection.insertBefore(tagSearchInput, $('.sb-collapse', tagSection));
  sidebar.appendChild(tagSection);

  /* 时间标签（自动） */
  const timeTags = (facets?.tags || []).filter((t) => t.kind === 'time');
  const years = timeTags.filter((t) => /年$/.test(t.name));
  const monthTags = timeTags.filter((t) => /^\d{4}-\d{2}$/.test(t.name));
  const timeNodes = [...years, ...(state.sidebarTimeExpanded ? monthTags : [])].map((t) => sbItem({
    label: t.name, count: t.count, active: f.tags.includes(t.name),
    onClick: () => toggleTagFilter(t.name),
  }));
  if (monthTags.length && !state.sidebarTimeExpanded) {
    const more = el('<button class="sb-item"><span class="label" style="font-size:12px;color:var(--text-faint)">展开月份标签…</span></button>');
    more.addEventListener('click', () => { state.sidebarTimeExpanded = true; renderSidebar(); });
    timeNodes.push(more);
  } else if (monthTags.length) {
    const less = el('<button class="sb-item"><span class="label" style="font-size:12px;color:var(--text-faint)">收起月份标签</span></button>');
    less.addEventListener('click', () => { state.sidebarTimeExpanded = false; renderSidebar(); });
    timeNodes.push(less);
  }
  sidebar.appendChild(sbSection('时间（自动标签）', timeNodes, { collapseKey: 'time' }));

  /* 主题（每条笔记自由填写的那个「主题」字段） */
  const topics = (facets?.topics || []).filter((t) => !state.tagSearch || t.name.includes(state.tagSearch));
  const topicNodes = topics.map((t) => sbItem({
    label: t.name, count: t.count, active: f.topic === t.name,
    title: `${t.name}${t.first ? ` · ${fmtDate(t.first)} ~ ${fmtDate(t.last)}` : ''}`,
    onClick: () => {
      if (f.topic === t.name) setFilter({ topic: '' }, { label: '' });
      else setFilter({ topic: t.name, tags: [] }, { label: `主题「${t.name}」` });
    },
  }));
  sidebar.appendChild(sbSection('主题', topicNodes, { collapseKey: 'topics' }));

  /* 底部统计 */
  sidebar.appendChild(el(`<div class="sb-section">
    <div class="hint" style="padding:0 8px">
      ${totals.first ? `${fmtDate(totals.first)} 起，共 ${totals.total} 条` : '还没有笔记'}
      <br /><span style="opacity:.75">本地存储 · 数据库 data/notes.db</span>
    </div>
  </div>`));
}

/* ------------------------------------------------------------------ 主区域 */

function renderMain() {
  const active = document.activeElement;
  const isCapture = !!(active && active.classList && active.classList.contains('capture-input'));
  const selStart = isCapture ? active.selectionStart : null;
  const selEnd = isCapture ? active.selectionEnd : null;

  const renderer = RENDERERS[state.view] || renderNotes;
  const node = renderer();
  main.replaceChildren(node);

  if (isCapture) {
    const ta = $('.capture-input', main);
    if (ta) {
      ta.focus();
      try { ta.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
    }
  }
  renderSelectionBarExternal();
  renderNav();
}

/* ------------------------------------------------------------------ 事件绑定 */

const applySearch = debounce(() => {
  const q = search.value.trim();
  if (q === state.filter.q) return;
  state.filter.q = q;
  state.label = q ? `关键词「${q}」` : '';
  state.offset = 0;
  emit('filter');
}, 260);

search.addEventListener('input', applySearch);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    search.value = '';
    applySearch();
    search.blur();
  }
});

on('view', () => {
  renderNav();
  renderMain();
  updateHashTitle();
});

on('filter', () => {
  // 主区域等数据回来再渲染（loadNotes 完成会发 'notes'），侧栏立刻更新
  renderSidebar();
  const p = Promise.all([loadNotes(), loadFacets()]);
  p.then(() => { renderSidebar(); renderMain(); });
});

on('notes', () => renderMain());
on('facets', () => renderSidebar());
on('loading', () => {
  if (state.view === 'notes' && !state.notes.length) renderMain();
});
on('selection', () => renderSelectionBarExternal());

document.addEventListener('keydown', (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    search.focus();
    search.select();
    return;
  }
  if (e.key === 'Escape' && document.activeElement === search && search.value) {
    search.value = '';
    applySearch();
  }
});

/* 任意位置粘贴 → 自动跳到记录台 */
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const { text, files } = readClipboard(e);
  if (!text.trim() && !files.length) return;
  e.preventDefault();
  if (state.view !== 'notes') navigate('notes');
  setTimeout(async () => {
    if (text.trim()) focusCapture({ withText: text });
    else getCapture();
    // 图片（比如截图）走上传 → 插到记录台里
    if (files.length) await insertImagesIntoCapture(files);
    toast(
      files.length ? `已粘贴 ${files.length} 张图片到记录台，确认后按 Ctrl+Enter 保存` : '已粘贴到记录台，确认后按 Ctrl+Enter 保存',
      'ok', 3200,
    );
  }, 40);
});

function updateHashTitle() {
  const v = VIEWS.find((x) => x.id === state.view);
  document.title = v ? `${v.label} · 读书笔记` : '读书笔记';
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  applyTheme();
  main.replaceChildren(el('<div class="loading"><span class="spin">◐</span> 正在启动…</div>'));
  renderNav();
  try {
    await initState();
  } catch (err) {
    main.replaceChildren(el(`<div class="empty"><h3>连接后端失败</h3><p>${esc(err.message)}</p>
      <p class="hint">请确认服务是通过 <code>node src/index.js</code> 启动的，并且这个页面是从 http://127.0.0.1:7788 打开的。</p></div>`));
    return;
  }
  search.value = state.filter.q;
  renderSidebar();
  renderMain();
  updateHashTitle();

  // 侧栏与主区域共享的自动补全列表
  getCapture();
}

boot();

// 调试用：暴露到 window
window.__notes = { state, navigate, getCapture, focusCapture, loadTags };
void filterParams;