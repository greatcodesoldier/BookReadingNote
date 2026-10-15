/**
 * 全局状态 + 极简发布订阅 + 数据加载。
 * 视图模块只依赖这里，不互相依赖。
 */
import { api } from './api.js';
import { toast } from './util.js';

export const state = {
  view: 'notes',
  filter: {
    q: '',
    tags: [],
    tagMode: 'all',
    topic: '',
    from: '',
    to: '',
    kinds: [],
    starred: false,
    sort: 'date-desc',
  },
  label: '',            // 当前筛选的人话描述
  notes: [],
  total: 0,
  offset: 0,
  limit: 60,
  facets: null,
  tags: [],
  settings: {},
  llm: {},
  selected: new Set(),
  selectionScope: null,   // 从列表页批量选中后带过来的笔记 id 列表
  tagSearch: '',
  sidebarTagKind: 'topic',
  loadingNotes: false,
  loadingFacets: false,
  lastCapture: null,
};

/* ------------------------------------------------------------------ 事件 */

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (err) { console.error(`[${event}]`, err); }
  }
}

/* ------------------------------------------------------------------ 路由 */

export const VIEWS = [
  { id: 'notes', label: '记录与浏览' },
  { id: 'analyze', label: '主题分析' },
  { id: 'timeline', label: '时间轴' },
  { id: 'tags', label: '标签管理' },
  { id: 'settings', label: '设置' },
];

export function navigate(view, { keepFilter = true } = {}) {
  if (!VIEWS.some((v) => v.id === view)) view = 'notes';
  state.view = view;
  if (!keepFilter) resetFilter();
  if (location.hash !== `#/${view}`) history.replaceState(null, '', `#/${view}`);
  emit('view', view);
}

function viewFromHash() {
  const m = (location.hash || '').match(/^#\/(\w+)/);
  return m && VIEWS.some((v) => v.id === m[1]) ? m[1] : 'notes';
}

export function initRouter() {
  state.view = viewFromHash();
  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v !== state.view) { state.view = v; emit('view', v); }
  });
}

/* ------------------------------------------------------------------ 筛选 */

export function resetFilter() {
  state.filter = { q: '', tags: [], tagMode: 'all', topic: '', from: '', to: '', kinds: [], starred: false, sort: 'date-desc' };
  state.label = '';
  state.selected.clear();
}

export function toggleTagFilter(name) {
  const tags = state.filter.tags;
  const i = tags.indexOf(name);
  if (i >= 0) tags.splice(i, 1); else tags.push(name);
  state.label = tags.length ? tags.map((t) => `#${t}`).join(' ') : '';
  state.offset = 0;
  emit('filter');
}

export function setFilter(patch, { label } = {}) {
  Object.assign(state.filter, patch);
  if (label !== undefined) state.label = label;
  state.offset = 0;
  emit('filter');
}

export function filterParams({ includeTags = true } = {}) {
  const f = state.filter;
  const p = {
    sort: f.sort,
    q: f.q,
    topic: f.topic,
    from: f.from,
    to: f.to,
    starred: f.starred ? 1 : undefined,
    kind: f.kinds.length ? f.kinds : undefined,
    tagMode: f.tagMode,
  };
  if (includeTags && f.tags.length) p.tags = f.tags;
  return p;
}

export function activeFilterSummary() {
  const f = state.filter;
  const bits = [];
  if (f.q) bits.push(`关键词「${f.q}」`);
  if (f.tags.length) bits.push(f.tags.map((t) => `#${t}`).join(' '));
  if (f.topic) bits.push(`主题「${f.topic}」`);
  if (f.from || f.to) bits.push(`${f.from || '不限'} ~ ${f.to || '不限'}`);
  if (f.kinds.length) bits.push(`类型：${f.kinds.join('/')}`);
  if (f.starred) bits.push('仅星标');
  return bits;
}

/* ------------------------------------------------------------------ 数据加载 */

let loadToken = 0;

export async function loadNotes({ append = false } = {}) {
  const token = ++loadToken;
  state.loadingNotes = true;
  emit('loading');
  try {
    const res = await api.listNotes({ ...filterParams(), limit: state.limit, offset: append ? state.offset : 0 });
    if (token !== loadToken) return;
    state.notes = append ? [...state.notes, ...res.notes] : res.notes;
    state.total = res.total;
    state.offset = append ? state.offset + res.notes.length : res.notes.length;
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (token === loadToken) { state.loadingNotes = false; emit('notes'); }
  }
}

export async function loadFacets() {
  state.loadingFacets = true;
  try {
    state.facets = await api.facets(filterParams({ includeTags: false }));
  } catch (err) {
    console.error(err);
  } finally {
    state.loadingFacets = false;
    emit('facets');
  }
}

export async function loadTags() {
  try {
    const res = await api.listTags({});
    state.tags = res.tags;
  } catch (err) {
    console.error(err);
  }
}

export async function loadSettings() {
  try {
    const res = await api.getSettings();
    state.settings = res.settings || {};
    state.llm = res.llm || {};
  } catch (err) {
    console.error(err);
  }
}

/** 任何会改变数据的操作之后调用 */
export async function refresh({ notes = true, facets = true, tags = true } = {}) {
  await Promise.all([
    facets ? loadFacets() : null,
    tags ? loadTags() : null,
  ]);
  if (notes) await loadNotes();
  else emit('notes');
}

export async function initState() {
  initRouter();
  await loadSettings();
  await Promise.all([loadFacets(), loadTags()]);
  await loadNotes();
}