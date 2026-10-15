/**
 * 时间轴：按年 → 月浏览，点一下就把时间范围变成筛选条件。
 */
import { state, setFilter, navigate } from '../state.js';
import { $, el, esc, KIND_LABEL } from '../util.js';

export function renderTimeline() {
  const root = el('<div class="view"></div>');
  const timeline = state.facets?.timeline || [];

  root.appendChild(el(`
    <div class="view-head">
      <h1 class="view-title">时间轴</h1>
      <span class="view-sub">按阅读/记录的时间回看，共 ${state.facets?.totals?.total ?? 0} 条笔记</span>
      <span class="spacer"></span>
      ${state.filter.from || state.filter.to
        ? `<span class="hint">当前筛选：${esc(state.filter.from || '不限')} ~ ${esc(state.filter.to || '不限')}</span>
           <button class="btn small" data-act="clear">清除时间筛选</button>`
        : ''}
    </div>
  `));
  const clearBtn = $('[data-act="clear"]', root);
  if (clearBtn) clearBtn.addEventListener('click', () => setFilter({ from: '', to: '' }, { label: '' }));

  if (!timeline.length) {
    root.appendChild(el('<div class="empty"><h3>还没有笔记</h3><p>存下第一条笔记之后，这里会按年月自动出现时间轴。</p></div>'));
    return root;
  }

  const byYear = new Map();
  for (const item of timeline) {
    const year = item.month.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(item);
  }
  const maxCount = Math.max(...timeline.map((t) => t.count));

  const years = [...byYear.keys()].sort((a, b) => b.localeCompare(a));
  for (const year of years) {
    const months = byYear.get(year);
    const yearTotal = months.reduce((s, m) => s + m.count, 0);
    const active = (state.filter.from || '').startsWith(year) && !months.some((m) => isMonthActive(m.month));

    const block = el(`
      <div class="card panel tl-year">
        <h2 class="tl-year-title">
          <span style="cursor:pointer" data-act="year">${year} 年</span>
          <span class="hint" style="font-weight:400">${yearTotal} 条</span>
          <span class="spacer" style="flex:1"></span>
        </h2>
        <div class="tl-months"></div>
      </div>
    `);
    $('[data-act="year"]', block).addEventListener('click', () => {
      setFilter({ from: `${year}-01-01`, to: `${year}-12-31` }, { label: `${year} 年` });
    });
    if (active) block.style.borderColor = 'var(--accent)';

    const host = $('.tl-months', block);
    for (const m of months) {
      const on = isMonthActive(m.month);
      const btn = el(`
        <button class="tl-month ${on ? 'on' : ''}">
          <div class="m">${Number(m.month.slice(5, 7))} 月</div>
          <div class="c">${m.count} 条</div>
          <div class="tl-bar" style="width:${Math.max(8, Math.round((m.count / maxCount) * 100))}%"></div>
        </button>
      `);
      btn.addEventListener('click', () => {
        if (on) { setFilter({ from: '', to: '' }, { label: '' }); return; }
        const [y, mo] = m.month.split('-').map(Number);
        const last = new Date(y, mo, 0).getDate();
        setFilter(
          { from: `${m.month}-01`, to: `${m.month}-${String(last).padStart(2, '0')}` },
          { label: `${y} 年 ${mo} 月` },
        );
      });
      host.appendChild(btn);
    }
    root.appendChild(block);
  }

  const kinds = state.facets?.kinds || [];
  if (kinds.length) {
    const card = el('<div class="card panel"><h2 class="panel-title">按类型回看</h2><div class="kw-cloud"></div></div>');
    const cloud = $('.kw-cloud', card);
    for (const k of kinds) {
      const chip = el(`<span class="kw">${esc(KIND_LABEL[k.kind] || k.kind)} <b>${k.count}</b></span>`);
      chip.addEventListener('click', () => {
        setFilter({ kinds: [k.kind] }, { label: `类型：${KIND_LABEL[k.kind] || k.kind}` });
        navigate('notes');
      });
      cloud.appendChild(chip);
    }
    root.appendChild(card);
  }

  return root;
}

function isMonthActive(month) {
  return state.filter.from === `${month}-01` || (state.filter.from || '').startsWith(month);
}