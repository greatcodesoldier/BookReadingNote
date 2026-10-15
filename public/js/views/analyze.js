/**
 * 主题分析视图：把同一主题下的零散笔记归拢、分析，并生成一篇结构化读书笔记。
 *
 * 左栏：选范围（标签 / 主题 / 勾选的笔记）→ 生成设置
 * 右栏：分析面板（概览、关键词、代表摘录、关联主题）+ 生成结果
 */
import { api } from '../api.js';
import { state, navigate, setFilter, refresh } from '../state.js';
import { $, esc, toast, download, copyText, debounce, el } from '../util.js';

let scope = { tags: [], tagMode: 'all', topic: '', ids: null };
let analysis = null;
let generated = null;
let tagFilterText = '';
let analyzing = false;
let currentRoot = null;

function scopeBody() {
  const body = { tagMode: scope.tagMode };
  if (scope.ids?.length) body.ids = scope.ids;
  if (scope.tags.length) body.tags = scope.tags;
  if (scope.topic) body.topic = scope.topic;
  return body;
}

function scopeLabel() {
  if (scope.ids?.length) return `已勾选的 ${scope.ids.length} 条笔记`;
  const bits = [];
  if (scope.tags.length) bits.push(scope.tags.map((t) => `#${t}`).join(' '));
  if (scope.topic) bits.push(`《${scope.topic}》`);
  return bits.join(' + ');
}

function hasScope() {
  return !!(scope.tags.length || scope.topic || scope.ids?.length);
}

function defaultTitle() {
  if (scope.tags.length) return scope.tags.map((t) => `#${t}`).join(' ');
  if (scope.topic) return `《${scope.topic}》`;
  if (scope.ids?.length) return '选中的笔记';
  return '我的读书笔记';
}

/* ------------------------------------------------------------------ 重建与焦点保持 */

function build(root) {
  const active = document.activeElement;
  const act = active?.dataset?.act;
  const rawValue = active && 'value' in active ? active.value : null;
  const selStart = active?.selectionStart ?? null;
  const selEnd = active?.selectionEnd ?? null;

  root.innerHTML = '';
  root.appendChild(buildHead());
  const layout = el('<div class="analysis-layout"></div>');
  const left = el('<div></div>');
  left.appendChild(buildScopePicker(root));
  left.appendChild(buildGeneratePanel());
  const right = el('<div></div>');
  right.appendChild(buildAnalysisPanel());
  right.appendChild(buildOutputPanel());
  layout.appendChild(left);
  layout.appendChild(right);
  root.appendChild(layout);

  if (act) {
    const next = root.querySelector(`[data-act="${act}"]`);
    if (next) {
      if (rawValue !== null && 'value' in next) next.value = rawValue;
      next.focus();
      if (selStart !== null && next.setSelectionRange) {
        try { next.setSelectionRange(selStart, selEnd); } catch { /* 某些 input 类型不支持 */ }
      }
    }
  }
}

function rerender() {
  if (currentRoot) build(currentRoot);
}

/* ------------------------------------------------------------------ 头部 */

function buildHead() {
  return el(`
    <div class="view-head">
      <h1 class="view-title">主题分析</h1>
      <span class="view-sub">${esc(scopeLabel() || '把散落的笔记按主题归拢、分析，写成一篇读书笔记')}</span>
    </div>
  `);
}

/* ------------------------------------------------------------------ ① 范围选择 */

function buildScopePicker(root) {
  const card = el(`
    <div class="card panel">
      <h2 class="panel-title">① 选择主题范围</h2>
      <div data-act="scope-current"></div>
      <input class="sb-search" data-act="tag-search" placeholder="搜索标签或主题…" />
      <div data-act="tag-list"></div>
      <div style="display:flex;gap:6px;margin-top:10px;align-items:center">
        <select class="select" data-act="tagmode" style="height:27px;font-size:12.5px;width:auto">
          <option value="any" ${scope.tagMode === 'any' ? 'selected' : ''}>满足任一标签</option>
          <option value="all" ${scope.tagMode === 'all' ? 'selected' : ''}>同时满足所有标签</option>
        </select>
        <span class="spacer" style="flex:1"></span>
        <button class="btn tiny ghost" data-act="clear-scope">清空</button>
      </div>
    </div>
  `);

  const search = $('[data-act="tag-search"]', card);
  search.value = tagFilterText;
  search.addEventListener('input', debounce(() => {
    tagFilterText = search.value;
    const old = $('[data-act="tag-list"]', card);
    old.replaceWith(buildTagList());
  }, 140));

  const current = $('[data-act="scope-current"]', card);
  if (hasScope()) {
    current.innerHTML = `<div style="padding:7px 9px;margin-bottom:9px;border-radius:6px;background:var(--accent-soft);color:var(--accent-text);font-size:12.5px">
      <b>当前主题</b>：${esc(scopeLabel())}
      ${scope.ids?.length ? '<button class="btn tiny ghost" data-act="drop-ids" style="margin-left:6px;color:inherit">改用标签</button>' : ''}
    </div>`;
    const dropBtn = $('[data-act="drop-ids"]', current);
    if (dropBtn) {
      dropBtn.addEventListener('click', () => {
        scope.ids = null;
        state.selectionScope = null;
        rerender();
        runAnalysis();
      });
    }
  } else {
    current.innerHTML = '<div class="hint" style="margin-bottom:9px">选一个或几个标签开始；也可以在笔记列表里勾选若干条再来汇总。</div>';
  }

  $('[data-act="tagmode"]', card).addEventListener('change', (e) => {
    scope.tagMode = e.target.value;
    runAnalysis();
  });
  $('[data-act="clear-scope"]', card).addEventListener('click', () => {
    scope = { tags: [], tagMode: 'all', topic: '', ids: null };
    state.selectionScope = null;
    analysis = null;
    generated = null;
    rerender();
  });

  $('[data-act="tag-list"]', card).replaceWith(buildTagList());
  void root;
  return card;
}

function buildTagList() {
  const host = el('<div data-act="tag-list" class="pick-list"></div>');
  const q = tagFilterText.trim();
  const tags = state.tags
    .filter((t) => t.kind !== 'time')
    .filter((t) => !q || t.name.includes(q))
    .sort((a, b) => (b.count || 0) - (a.count || 0));
  const topics = (state.facets?.topics || []).filter((s) => !q || s.name.includes(q));

  if (!tags.length && !topics.length) {
    host.appendChild(el(`<div class="sb-empty">没有匹配的标签${q ? '' : '，先在笔记上打几个标签吧'}</div>`));
    return host;
  }

  for (const tag of tags) {
    const on = scope.tags.includes(tag.name);
    const item = el(`<label class="pick-item ${on ? 'on' : ''}">
      <input type="checkbox" ${on ? 'checked' : ''} />
      <span class="dot" style="background:${esc(tag.color || '#888')}"></span>
      <span class="label">#${esc(tag.name)}</span>
      <span class="count">${tag.count ?? 0}</span>
    </label>`);
    $('input', item).addEventListener('change', (e) => {
      if (e.target.checked) { if (!scope.tags.includes(tag.name)) scope.tags.push(tag.name); }
      else scope.tags = scope.tags.filter((t) => t !== tag.name);
      scope.ids = null;
      state.selectionScope = null;
      rerender();
      runAnalysis();
    });
    host.appendChild(item);
  }

  if (topics.length) {
    host.appendChild(el('<div class="sb-empty" style="margin-top:8px;font-weight:700">按主题</div>'));
    for (const t of topics.slice(0, 20)) {
      const item = el(`<button class="pick-item ${scope.topic === t.name ? 'on' : ''}">
        <span class="label">${esc(t.name)}</span><span class="count">${t.count}</span>
      </button>`);
      item.addEventListener('click', () => {
        scope.topic = scope.topic === t.name ? '' : t.name;
        scope.ids = null;
        state.selectionScope = null;
        rerender();
        runAnalysis();
      });
      host.appendChild(item);
    }
  }
  return host;
}

/* ------------------------------------------------------------------ ② 生成设置 */

function buildGeneratePanel() {
  const card = el(`
    <div class="card panel">
      <h2 class="panel-title">② 生成读书笔记</h2>
      <div class="form-row"><label>标题</label><input class="input" data-act="title" value="${esc(defaultTitle())}" /></div>
      ${state.llm.configured
        ? `<label class="pick-item" style="padding-left:0"><input type="checkbox" data-act="usellm" ${state.settings.llmEnabled !== '0' ? 'checked' : ''} />
             <span class="label">用 AI 写一段综述（${esc(state.llm.model || '')}）</span></label>`
        : '<div class="hint" style="margin-bottom:8px">未配置 LLM API Key，将用本地分析引擎生成。功能完整，只是少一段 AI 综述 —— 可按需在「设置」里配置。</div>'}
      <label class="pick-item" style="padding-left:0"><input type="checkbox" data-act="save" />
        <span class="label">生成后存回系统（类型：小结）</span></label>
      <button class="btn primary" data-act="gen" style="width:100%;margin-top:10px" ${hasScope() ? '' : 'disabled'}>生成读书笔记</button>
    </div>
  `);
  $('[data-act="gen"]', card).addEventListener('click', doGenerate);
  return card;
}

async function doGenerate() {
  const root = currentRoot;
  if (!root) return;
  const titleInput = $('[data-act="title"]', root);
  const useLLM = $('[data-act="usellm"]', root);
  const save = $('[data-act="save"]', root);
  const btn = $('[data-act="gen"]', root);
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    const res = await api.generate({
      ...scopeBody(),
      title: titleInput?.value?.trim() || defaultTitle(),
      useLLM: !!useLLM?.checked,
      save: !!save?.checked,
    });
    generated = res;
    analysis = res.analysis;
    if (res.llmError) toast(res.llmError, 'warn', 4600);
    else if (res.llmSummary) toast('已用 AI 生成综述');
    if (res.note) { toast('已作为一条「小结」存回系统'); refresh(); }
    rerender();
  } catch (err) {
    toast(err.message, 'err', 4600);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '生成读书笔记'; }
  }
}

/* ------------------------------------------------------------------ 分析面板 */

function buildAnalysisPanel() {
  if (!analysis) {
    return el(`<div class="empty"><h3>选择一个主题，看看能整理出什么</h3>
      <p>系统会把该主题下的所有笔记归拢起来：提炼关键词脉络、挑出有代表性的句子、找出与它同时出现的其他主题。</p>
      <p class="hint">也可以回到笔记列表勾选若干条，再点「汇总成读书笔记」。</p></div>`);
  }
  const host = el('<div></div>');
  const s = analysis.scope;

  host.appendChild(el(`
    <div class="card panel">
      <h2 class="panel-title">主题概览<span style="flex:1"></span><span class="hint">${esc(scopeLabel())}</span></h2>
      <div class="stat-grid">
        <div class="stat"><div class="k">笔记</div><div class="v">${s.noteCount}</div></div>
        <div class="stat"><div class="k">主题</div><div class="v">${s.topics.length}</div></div>
        <div class="stat"><div class="k">时间跨度</div><div class="v" style="font-size:13px;line-height:1.9">${esc(s.span || '—')}</div></div>
        <div class="stat"><div class="k">类型构成</div><div class="v" style="font-size:13px;line-height:1.9">${s.kinds.map((k) => `${k.label}${k.count}`).join(' / ')}</div></div>
      </div>
      ${s.topics.length ? `<div class="hint" style="margin-top:10px">主要主题：${s.topics.slice(0, 8).map((x) => `${esc(x.name)}${x.count}`).join(' · ')}</div>` : ''}
      ${s.timeline.length > 1 ? `<div class="hint" style="margin-top:4px">时间分布：${s.timeline.map((t) => `${esc(t.month)}(${t.count})`).join(' · ')}</div>` : ''}
    </div>
  `));

  if (analysis.keywords.length) {
    const panel = el(`<div class="card panel">
      <h2 class="panel-title">关键词脉络<span style="flex:1"></span><span class="hint">点击可在笔记中搜索</span></h2>
      <div class="kw-cloud"></div></div>`);
    const cloud = $('.kw-cloud', panel);
    for (const k of analysis.keywords.slice(0, 26)) {
      const chip = el(`<span class="kw" title="权重 ${k.count}"><b>${esc(k.term)}</b></span>`);
      chip.addEventListener('click', () => {
        setFilter({ q: k.term, tags: [] }, { label: `关键词「${k.term}」` });
        navigate('notes');
      });
      cloud.appendChild(chip);
    }
    host.appendChild(panel);
  }

  if (analysis.highlights.length) {
    const panel = el(`<div class="card panel">
      <h2 class="panel-title">代表性摘录<span style="flex:1"></span><span class="hint">按关键词权重与笔记类型挑选</span></h2>
      <div data-act="hl"></div></div>`);
    const hl = $('[data-act="hl"]', panel);
    for (const h of analysis.highlights) {
      const item = el(`<div class="hl-item" style="cursor:pointer" title="在笔记中定位">${esc(h.text)}
        <span class="src">— ${esc([h.topic && `《${h.topic}》`, h.location, h.date].filter(Boolean).join(' · '))}</span></div>`);
      item.addEventListener('click', () => {
        setFilter({ q: h.text.slice(0, 14), tags: [] }, { label: '定位到摘录' });
        navigate('notes');
      });
      hl.appendChild(item);
    }
    host.appendChild(panel);
  }

  if (analysis.themes.length) {
    const panel = el(`<div class="card panel">
      <h2 class="panel-title">关联主题<span style="flex:1"></span><span class="hint">常与当前主题一起出现，点一下加入范围</span></h2>
      <div class="kw-cloud"></div></div>`);
    const cloud = $('.kw-cloud', panel);
    for (const t of analysis.themes) {
      const chip = el(`<span class="kw">#${esc(t.name)} <b>${t.count}</b></span>`);
      chip.addEventListener('click', () => {
        if (!scope.tags.includes(t.name)) scope.tags.push(t.name);
        scope.ids = null;
        rerender();
        runAnalysis();
      });
      cloud.appendChild(chip);
    }
    host.appendChild(panel);
  }

  if (analysis.questions.length || analysis.todos.length) {
    const panel = el(`<div class="card panel"><h2 class="panel-title">疑问与待深入</h2><div data-act="q"></div></div>`);
    const qHost = $('[data-act="q"]', panel);
    for (const q of [...analysis.questions, ...analysis.todos]) {
      qHost.appendChild(el(`<div class="hl-item" style="border-left-color:var(--kind-question)">${esc(q.content.split('\n')[0])}
        <span class="src">— ${esc([q.topic && `《${q.topic}》`, q.location, q.noteDate].filter(Boolean).join(' · '))}</span></div>`));
    }
    host.appendChild(panel);
  }

  return host;
}

/* ------------------------------------------------------------------ ③ 输出 */

function buildOutputPanel() {
  if (!generated) return el('<div></div>');
  const card = el(`
    <div class="card panel">
      <h2 class="panel-title">③ 生成的读书笔记<span style="flex:1"></span>
        <button class="btn tiny" data-act="copy">复制</button>
        <button class="btn tiny" data-act="dl">下载 .md</button>
        <button class="btn tiny ghost" data-act="close">收起</button>
      </h2>
      <textarea class="md-out" spellcheck="false"></textarea>
      <div class="hint" style="margin-top:8px">可以直接在上面修改，改完再复制或下载。${generated.note ? ' 已作为一条「小结」存回系统。' : ''}</div>
    </div>
  `);
  $('.md-out', card).value = generated.markdown;
  $('[data-act="copy"]', card).addEventListener('click', async () => {
    await copyText($('.md-out', card).value);
    toast('已复制到剪贴板');
  });
  $('[data-act="dl"]', card).addEventListener('click', () => {
    const name = ($('[data-act="title"]', currentRoot)?.value || defaultTitle()).replace(/[\\/:*?"<>|#]/g, '').slice(0, 40);
    download(`${name}-读书笔记.md`, $('.md-out', card).value);
  });
  $('[data-act="close"]', card).addEventListener('click', () => { generated = null; rerender(); });
  return card;
}

/* ------------------------------------------------------------------ 分析触发 */

const runAnalysisDebounced = debounce(() => runAnalysis(), 200);

async function runAnalysis() {
  if (!hasScope()) {
    analysis = null;
    rerender();
    return;
  }
  if (analyzing) return;
  analyzing = true;
  try {
    analysis = await api.analyze(scopeBody());
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    analyzing = false;
    rerender();
  }
}

/* ------------------------------------------------------------------ 入口 */

export function renderAnalyze() {
  currentRoot = el('<div class="view"></div>');

  if (state.selectionScope?.length) {
    scope = { tags: [], tagMode: 'all', topic: '', ids: [...state.selectionScope] };
    state.selectionScope = null;
    generated = null;
  }

  // 首次进入且没有范围时，自动挑一个体量最大的主题，避免看到一个空页面
  if (!hasScope() && state.tags.length) {
    const top = state.tags
      .filter((t) => t.kind === 'topic')
      .sort((a, b) => (b.count || 0) - (a.count || 0))[0];
    if (top && (top.count || 0) >= 2) scope.tags = [top.name];
  }

  build(currentRoot);
  if (hasScope()) setTimeout(runAnalysis, 0);
  void runAnalysisDebounced;
  return currentRoot;
}