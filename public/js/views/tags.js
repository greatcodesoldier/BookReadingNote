/**
 * 标签管理：重命名、改色、归类、合并、删除。
 */
import { api } from '../api.js';
import { state, refresh, setFilter, navigate, loadTags } from '../state.js';
import { $, $$, el, esc, toast, confirmDialog, openModal } from '../util.js';

const KINDS = [
  ['topic', '主题'],
  ['custom', '自定义'],
  ['time', '时间（自动）'],
];

const KIND_LABEL = Object.fromEntries(KINDS);

export function renderTags() {
  const root = el('<div class="view"></div>');

  const topicTags = state.tags.filter((t) => t.kind === 'topic');
  const customTags = state.tags.filter((t) => t.kind === 'custom');
  const timeTags = state.tags.filter((t) => t.kind === 'time');
  const orphan = state.tags.filter((t) => !t.count);

  root.appendChild(el(`
    <div class="view-head">
      <h1 class="view-title">标签管理</h1>
      <span class="view-sub">共 ${state.tags.length} 个标签${orphan.length ? ` · ${orphan.length} 个未被使用` : ''}</span>
      <span class="spacer"></span>
      <input class="input" data-act="new-tag" placeholder="新建标签，回车确认" style="width:190px" />
      <button class="btn" data-act="new">新建</button>
    </div>
  `));

  const newInput = $('[data-act="new-tag"]', root);
  const create = async () => {
    const name = newInput.value.trim().replace(/^#/, '');
    if (!name) return;
    try {
      await api.createTag({ name, kind: 'topic' });
      newInput.value = '';
      toast(`已创建 #${name}`);
      await loadTags();
      refreshView();
    } catch (err) { toast(err.message, 'err'); }
  };
  newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  $('[data-act="new"]', root).addEventListener('click', create);

  if (!state.tags.length) {
    root.appendChild(el('<div class="empty"><h3>还没有标签</h3><p>标签会在你粘贴时自动生成（正文里的 #标签、时间标签），也可以在上面的输入框里手动新建。</p></div>'));
    return root;
  }

  root.appendChild(buildSection('主题标签', topicTags, { rename: true, merge: true, del: true }));
  if (customTags.length) root.appendChild(buildSection('自定义标签', customTags, { rename: true, merge: true, del: true }));
  if (timeTags.length) root.appendChild(buildSection('时间标签（自动生成，不可改名）', timeTags, { rename: false, merge: false, del: true }));

  return root;
}

function refreshView() {
  const host = $('#main');
  if (host && state.view === 'tags') host.replaceChildren(renderTags());
}

function buildSection(title, tags, opts) {
  const card = el(`
    <div class="card panel">
      <h2 class="panel-title">${esc(title)}<span style="flex:1"></span><span class="hint">${tags.length} 个</span></h2>
      <table class="tag-table">
        <thead><tr>
          <th style="width:38%">名称</th>
          <th style="width:90px">颜色</th>
          <th style="width:110px">类型</th>
          <th style="width:70px">笔记</th>
          <th></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  `);
  const tbody = $('tbody', card);

  if (!tags.length) {
    tbody.appendChild(el('<tr><td colspan="5" class="hint" style="padding:14px 10px">暂无</td></tr>'));
    return card;
  }

  for (const tag of tags) {
    const tr = el(`<tr>
      <td><input class="rename-input" value="${esc(tag.name)}" ${opts.rename ? '' : 'disabled'} /></td>
      <td><input type="color" value="${esc(tag.color || '#888888')}" /></td>
      <td>
        <select class="select" style="height:26px;font-size:12px;padding:0 4px">
          ${KINDS.filter(([k]) => k !== 'time').map(([k, l]) => `<option value="${k}" ${tag.kind === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </td>
      <td><button class="btn tiny ghost" data-act="open">${tag.count ?? 0}</button></td>
      <td style="text-align:right;white-space:nowrap">
        ${opts.merge ? '<button class="btn tiny ghost" data-act="merge">合并…</button>' : ''}
        <button class="btn tiny danger" data-act="del">删除</button>
      </td>
    </tr>`);

    const nameInput = $('.rename-input', tr);
    nameInput.addEventListener('change', async () => {
      const name = nameInput.value.trim().replace(/^#/, '');
      if (!name || name === tag.name) { nameInput.value = tag.name; return; }
      try {
        await api.updateTag(tag.id, { name });
        toast(`已重命名为 #${name}`);
        await loadTags();
        refresh();
        refreshView();
      } catch (err) { toast(err.message, 'err'); nameInput.value = tag.name; }
    });

    $('input[type="color"]', tr).addEventListener('change', async (e) => {
      try {
        await api.updateTag(tag.id, { color: e.target.value });
        await loadTags();
        refreshView();
      } catch (err) { toast(err.message, 'err'); }
    });

    $('select', tr).addEventListener('change', async (e) => {
      try {
        await api.updateTag(tag.id, { kind: e.target.value });
        await loadTags();
        refreshView();
      } catch (err) { toast(err.message, 'err'); }
    });

    $('[data-act="open"]', tr).addEventListener('click', () => {
      setFilter({ tags: [tag.name], q: '', topic: '', kinds: [], from: '', to: '', starred: false }, { label: `#${tag.name}` });
      navigate('notes');
    });

    const mergeBtn = $('[data-act="merge"]', tr);
    if (mergeBtn) {
      mergeBtn.addEventListener('click', () => {
        openModal({
          title: `把 #${tag.name} 合并到…`,
          bodyHtml: `<p class="hint" style="margin-top:0">合并后，这个标签下的所有笔记都会转到目标标签，原标签会被删除。</p>
            <div class="form-row"><label>目标标签</label>
              <input class="input" id="merge-target" list="merge-options" placeholder="输入或选择已有标签" />
              <datalist id="merge-options">${state.tags.filter((t) => t.id !== tag.id).map((t) => `<option value="${esc(t.name)}"></option>`).join('')}</datalist>
            </div>`,
          actions: [
            { label: '取消', kind: 'ghost' },
            {
              label: '合并',
              kind: 'primary',
              onClick: async (close, card2) => {
                const target = $('#merge-target', card2).value.trim().replace(/^#/, '');
                if (!target) return false;
                try {
                  let targetTag = state.tags.find((t) => t.name === target);
                  if (!targetTag) targetTag = (await api.createTag({ name: target })).tag;
                  await api.mergeTags([tag.id], targetTag.id);
                  toast(`已把 #${tag.name} 合并到 #${target}`);
                  await loadTags();
                  refresh();
                  refreshView();
                } catch (err) { toast(err.message, 'err'); return false; }
              },
            },
          ],
        });
      });
    }

    $('[data-act="del"]', tr).addEventListener('click', async () => {
      const n = tag.count || 0;
      const ok = await confirmDialog({
        title: `删除标签 #${tag.name}？`,
        message: n ? `这个标签被 ${n} 条笔记使用。删除标签不会删除笔记本身。` : '这个标签还没有被使用。',
        confirmLabel: '删除标签',
      });
      if (!ok) return;
      try {
        await api.deleteTag(tag.id);
        toast('已删除标签');
        await loadTags();
        refresh();
        refreshView();
      } catch (err) { toast(err.message, 'err'); }
    });

    tbody.appendChild(tr);
  }
  return card;
}