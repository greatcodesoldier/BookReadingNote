/**
 * 笔记浏览视图：筛选、卡片流、行内改标签、编辑、批量操作。
 */
import { api } from '../api.js';
import { state, filterParams, activeFilterSummary, toggleTagFilter, loadNotes, refresh, navigate, setFilter, resetFilter, emit } from '../state.js';
import { getCapture } from './capture.js';
import {
  $, $$, el, esc, fmtDate, mdLite, toast, openModal, confirmDialog,
  kindText, kindBadge, highlight, copyText, download,
} from '../util.js';

const SORTS = [
  ['date-desc', '按笔记日期（新→旧）'],
  ['date-asc', '按笔记日期（旧→新）'],
  ['updated-desc', '按修改时间'],
  ['created-desc', '按录入时间'],
  ['topic-asc', '按主题归类'],
  ['starred-desc', '星标优先'],
];

/* ------------------------------------------------------------------ 图片放大 */

/** 点正文里的图片 → 弹一个大图看细节（截图里的字往往很小） */
export function openImagePreview(src, alt = '') {
  if (!src) return;
  openModal({
    title: alt && alt !== '图片' ? alt : '图片',
    wide: true,
    bodyHtml: `<div class="image-preview"><img src="${esc(src)}" alt="${esc(alt)}" /></div>
      <div class="hint" style="margin-top:10px">右键图片可以「图片另存为」或「复制图片」。按 Esc 关闭。</div>`,
  });
}

/* ------------------------------------------------------------------ 单条笔记卡片 */

function renderNoteCard(note) {
  const kind = kindText(note.kind);
  const badge = kindBadge(note.kind);
  const terms = state.filter.q ? state.filter.q.split(/\s+/).filter(Boolean) : [];
  const selected = state.selected.has(note.id);
  const bodyHtml = mdLite(note.content);

  const card = el(`
    <article class="card note-card ${selected ? 'selected' : ''}" data-id="${note.id}">
      <div class="note-head">
        <input type="checkbox" class="note-pick" ${selected ? 'checked' : ''} title="选中" />
        <h3 class="note-title">${highlight(note.title || '（无标题）', terms)}</h3>
        <button class="note-star ${note.starred ? 'on' : ''}" title="${note.starred ? '取消星标' : '加星标'}">${note.starred ? '★' : '☆'}</button>
      </div>
      <div class="note-meta">
        <span class="badge${badge.cls}"${badge.style}>${esc(kind)}</span>
        <span>${esc(fmtDate(note.noteDate))}</span>
        ${note.topic ? `<span class="sep">·</span><span title="点击只看这个主题" style="cursor:pointer" data-act="filter-topic">${highlight(note.topic, terms)}</span>` : ''}
        ${note.location ? `<span class="sep">·</span><span>${esc(note.location)}</span>` : ''}
        ${note.author ? `<span class="sep">·</span><span>${esc(note.author)}</span>` : ''}
      </div>
      <div class="note-body clamped">${bodyHtml}</div>
      <div class="note-tags"></div>
      <div class="note-actions">
        <button class="btn tiny ghost" data-act="edit">编辑</button>
        <button class="btn tiny ghost" data-act="copy">复制</button>
        <button class="btn tiny ghost" data-act="cite">复制出处</button>
        <span class="spacer"></span>
        <button class="btn tiny danger" data-act="del">删除</button>
      </div>
    </article>
  `);

  /* 正文折叠 */
  const bodyEl = $('.note-body', card);
  // 图片加载完才知道真实高度，所以图片加载后重新判断要不要折叠
  if (bodyEl.scrollHeight <= 150) bodyEl.classList.remove('clamped');
  for (const img of $$('img', bodyEl)) {
    img.addEventListener('load', () => {
      if (bodyEl.scrollHeight <= 150) bodyEl.classList.remove('clamped');
    });
  }
  bodyEl.addEventListener('click', (e) => {
    // 点图片 = 放大看，不要顺手把折叠状态改了
    if (e.target.tagName === 'IMG') {
      e.stopPropagation();
      openImagePreview(e.target.src, e.target.alt);
      return;
    }
    if (bodyEl.classList.contains('clamped')) bodyEl.classList.remove('clamped');
    else if (e.target === bodyEl) bodyEl.classList.add('clamped');
  });

  /* 选择 */
  $('.note-pick', card).addEventListener('change', (e) => {
    if (e.target.checked) state.selected.add(note.id); else state.selected.delete(note.id);
    card.classList.toggle('selected', e.target.checked);
    emit('selection');
  });

  /* 星标 */
  $('.note-star', card).addEventListener('click', async () => {
    const next = !note.starred;
    note.starred = next;
    $('.note-star', card).classList.toggle('on', next);
    $('.note-star', card).textContent = next ? '★' : '☆';
    try {
      await api.updateNote(note.id, { starred: next });
      loadNotes();
    } catch (err) { toast(err.message, 'err'); }
  });

  /* 标签 */
  renderTags($('.note-tags', card), note);

  /* 主题筛选 */
  const topicBtn = $('[data-act="filter-topic"]', card);
  if (topicBtn) {
    topicBtn.addEventListener('click', () => {
      setFilter({ topic: note.topic, tags: [] }, { label: `主题「${note.topic}」` });
      navigate('notes');
    });
  }

  /* 操作 */
  $('[data-act="edit"]', card).addEventListener('click', () => openEditModal(note));
  $('[data-act="copy"]', card).addEventListener('click', async () => {
    await copyText(note.content);
    toast('已复制正文');
  });
  $('[data-act="cite"]', card).addEventListener('click', async () => {
    const bits = [note.topic && `《${note.topic}》`, note.location, note.noteDate, note.author].filter(Boolean);
    await copyText(bits.join(' · '));
    toast('已复制出处信息');
  });
  $('[data-act="del"]', card).addEventListener('click', async () => {
    if (!(await confirmDialog({ title: '删除这条笔记？', message: note.title || note.content.slice(0, 40), confirmLabel: '删除' }))) return;
    try {
      await api.deleteNote(note.id);
      state.selected.delete(note.id);
      toast('已删除');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  return card;
}

function renderTags(host, note) {
  host.innerHTML = '';
  for (const tag of note.tags) {
    const isTime = tag.kind === 'time';
    const chip = el(`<span class="tag-chip ${isTime ? 'time' : ''} ${state.filter.tags.includes(tag.name) ? 'on' : ''}"
        title="${isTime ? '时间标签（自动）' : tag.auto ? '自动标签' : '手动标签'}">#${esc(tag.name)}${isTime ? '' : '<span class="x" title="移除标签">×</span>'}</span>`);
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) return;
      toggleTagFilter(tag.name);
    });
    const x = $('.x', chip);
    if (x) {
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const updated = await api.updateNoteTags(note.id, { remove: [tag.name] });
          Object.assign(note, updated);
          renderTags(host, note);
          refresh({ notes: false, tags: true });
        } catch (err) { toast(err.message, 'err'); }
      });
    }
    host.appendChild(chip);
  }

  const input = el('<input class="tag-add" placeholder="+ 标签" list="all-tags" />');
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const names = input.value.split(/[\s,，、#]+/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    input.value = '';
    try {
      const updated = await api.updateNoteTags(note.id, { add: names });
      Object.assign(note, updated);
      renderTags(host, note);
      refresh({ notes: false, tags: true });
      toast(`已加标签 ${names.map((n) => `#${n}`).join(' ')}`);
    } catch (err) { toast(err.message, 'err'); }
  });
  host.appendChild(input);
}

/* ------------------------------------------------------------------ 编辑弹窗 */

export function openEditModal(note) {
  openModal({
    title: '编辑笔记',
    wide: true,
    bodyHtml: `
      <div class="form-row"><label>标题</label><input class="input" data-f="title" value="${esc(note.title)}" /></div>
      <div class="preview-fields" style="margin-bottom:11px">
        <div class="field"><label>主题</label><input data-f="topic" value="${esc(note.topic)}" placeholder="自由填写" list="all-topics" /></div>
        <div class="field"><label>位置</label><input data-f="location" value="${esc(note.location)}" /></div>
        <div class="field"><label>作者</label><input data-f="author" value="${esc(note.author)}" /></div>
        <div class="field"><label>日期</label><input data-f="noteDate" type="date" value="${esc(note.noteDate)}" /></div>
        <div class="field"><label>类型</label><input data-f="kind" value="${esc(kindText(note.kind))}" placeholder="自由填写" list="all-kinds" /></div>
      </div>
      <div class="form-row"><label>正文（支持 Markdown / #标签）</label><textarea class="textarea" data-f="content" style="min-height:260px">${esc(note.content)}</textarea></div>
      <div class="hint">正文里的 #标签 会在保存时自动加入笔记标签。</div>
    `,
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存',
        kind: 'primary',
        onClick: async (close, card) => {
          const patch = {};
          for (const input of $$('[data-f]', card)) patch[input.dataset.f] = input.value;
          try {
            await api.updateNote(note.id, patch);
            toast('已保存');
            refresh();
          } catch (err) { toast(err.message, 'err'); return false; }
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ 批量操作 */

function renderSelectionBar() {
  const bar = $('#selection-bar');
  const n = state.selected.size;
  if (!n) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <span class="n">已选 ${n} 条</span>
    <button class="btn small" data-act="tag">批量加标签</button>
    <button class="btn small primary" data-act="gen">汇总成读书笔记</button>
    <button class="btn small" data-act="export">导出所选</button>
    <button class="btn small danger" data-act="del">删除</button>
    <button class="btn small ghost" data-act="clear">取消</button>
  `;
  const ids = [...state.selected];

  $('[data-act="clear"]', bar).addEventListener('click', () => {
    state.selected.clear();
    emit('selection');
  });

  $('[data-act="tag"]', bar).addEventListener('click', () => {
    openModal({
      title: `给 ${n} 条笔记加标签`,
      bodyHtml: `<div class="form-row"><label>标签（空格或逗号分隔）</label><input class="input" id="bulk-tags" placeholder="例如：心理学 决策" list="all-tags" /></div>`,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '添加',
          kind: 'primary',
          onClick: async (close, card) => {
            const names = $('#bulk-tags', card).value.split(/[\s,，、#]+/).map((s) => s.trim()).filter(Boolean);
            if (!names.length) return false;
            try {
              for (const id of ids) await api.updateNoteTags(id, { add: names });
              toast(`已给 ${n} 条笔记加上标签`);
              state.selected.clear();
              emit('selection');
              refresh();
            } catch (err) { toast(err.message, 'err'); return false; }
          },
        },
      ],
    });
  });

  $('[data-act="gen"]', bar).addEventListener('click', () => {
    state.selectionScope = ids;
    navigate('analyze');
  });

  $('[data-act="export"]', bar).addEventListener('click', () => {
    const data = state.notes.filter((x) => state.selected.has(x.id));
    const md = data.map((x) => `## ${x.title}\n\n> ${[x.topic && `《${x.topic}》`, x.location, x.noteDate].filter(Boolean).join(' · ')}\n\n${x.content}\n`).join('\n---\n\n');
    download(`选中笔记-${new Date().toISOString().slice(0, 10)}.md`, `# 选中的 ${data.length} 条笔记\n\n${md}`);
  });

  $('[data-act="del"]', bar).addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `删除选中的 ${n} 条笔记？`, message: '此操作不可撤销。', confirmLabel: '删除' }))) return;
    try {
      for (const id of ids) await api.deleteNote(id);
      state.selected.clear();
      toast(`已删除 ${n} 条`);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ------------------------------------------------------------------ 视图 */

export function renderNotes() {
  const root = el('<div class="view"></div>');

  const summary = activeFilterSummary();
  const head = el(`
    <div class="view-head">
      <h1 class="view-title">${summary.length ? '筛选结果' : '全部笔记'}</h1>
      <span class="view-sub">${state.total} 条${summary.length ? ` · ${esc(summary.join(' · '))}` : ''}</span>
      <span class="spacer"></span>
      <select class="select" data-act="sort" style="width:auto">${SORTS.map(([v, l]) => `<option value="${v}" ${state.filter.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${summary.length ? '<button class="btn small" data-act="reset">清除筛选</button>' : ''}
      <a class="btn small" href="${api.exportUrl('markdown', filterParams())}">导出 Markdown</a>
    </div>
  `);
  $('[data-act="sort"]', head).addEventListener('change', (e) => setFilter({ sort: e.target.value }));
  const resetBtn = $('[data-act="reset"]', head);
  if (resetBtn) resetBtn.addEventListener('click', () => { resetFilter(); emit('filter'); });
  root.appendChild(head);

  root.appendChild(getCapture());

  if (state.loadingNotes && !state.notes.length) {
    root.appendChild(el('<div class="loading"><span class="spin">◐</span> 正在载入…</div>'));
    return root;
  }

  if (!state.notes.length) {
    root.appendChild(el(`
      <div class="empty">
        <h3>${state.total === 0 && !activeFilterSummary().length ? '还没有任何笔记' : '没有符合条件的笔记'}</h3>
        <p>${state.total === 0 && !activeFilterSummary().length
          ? '把读到的一段话粘到上面的输入框，按 Ctrl+Enter 就存好了。'
          : '试试放宽筛选条件，或清除筛选。'}</p>
      </div>
    `));
    return root;
  }

  const list = el('<div class="notes-list"></div>');
  for (const note of state.notes) list.appendChild(renderNoteCard(note));
  root.appendChild(list);

  if (state.notes.length < state.total) {
    const more = el(`<div style="text-align:center;margin-top:18px"><button class="btn">加载更多（还有 ${state.total - state.notes.length} 条）</button></div>`);
    $('button', more).addEventListener('click', () => loadNotes({ append: true }));
    root.appendChild(more);
  }

  return root;
}

export function renderSelectionBarExternal() {
  renderSelectionBar();
}