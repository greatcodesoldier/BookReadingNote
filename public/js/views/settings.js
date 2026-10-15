/**
 * 设置：数据备份/导入、标签自动规则、LLM 配置、外观、快捷键说明。
 */
import { api } from '../api.js';
import { state, loadSettings, refresh } from '../state.js';
import { $, el, esc, toast, confirmDialog } from '../util.js';

let stats = null;

export function renderSettings() {
  const root = el('<div class="view"></div>');
  root.appendChild(el(`
    <div class="view-head">
      <h1 class="view-title">设置</h1>
      <span class="view-sub">数据存在本机，不联网（除非你主动开启 AI 综述）</span>
    </div>
  `));

  root.appendChild(buildDataPanel());
  root.appendChild(buildBehaviorPanel());
  root.appendChild(buildLLMPanel());
  root.appendChild(buildAppearancePanel());
  root.appendChild(buildShortcutsPanel());

  loadStats().then((s) => {
    stats = s;
    const host = $('[data-act="stats"]', root);
    if (host) host.replaceWith(buildStats());
  });

  return root;
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function buildStats() {
  const s = stats || {};
  return el(`
    <div data-act="stats" class="stat-grid" style="margin-bottom:12px">
      <div class="stat"><div class="k">笔记</div><div class="v">${s.notes ?? '—'}</div></div>
      <div class="stat"><div class="k">标签</div><div class="v">${s.tags ?? '—'}</div></div>
      <div class="stat"><div class="k">主题</div><div class="v">${s.topics ?? '—'}</div></div>
      <div class="stat"><div class="k">图片</div><div class="v">${s.attachments ?? 0}</div>
        <div class="k" style="margin-top:2px">${fmtBytes(s.attachmentBytes)}</div></div>
    </div>
  `);
}

async function loadStats() {
  try { return await api.stats(); } catch { return null; }
}

/* ------------------------------------------------------------------ 数据 */

function buildDataPanel() {
  const card = el(`
    <div class="card panel">
      <h2 class="panel-title">数据</h2>
      ${buildStats().outerHTML}
      <div class="hint" style="margin-bottom:12px">数据库文件：<code>${esc(stats?.dbPath || 'data/notes.db')}</code>。停掉服务后复制这个文件就是一份完整备份；如果服务正在运行，建议用下面的「导出 JSON 备份」更稳妥。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn" href="/api/export/markdown">导出全部为 Markdown</a>
        <a class="btn" href="/api/export/json">导出 JSON 备份</a>
        <a class="btn" href="/api/export/csv">导出 CSV</a>
        <button class="btn" data-act="import">导入 JSON 备份</button>
        <input type="file" accept=".json,application/json" data-act="file" hidden />
        <button class="btn" data-act="gc-images">清理没用的图片</button>
      </div>
      <div class="hint" style="margin-top:10px">导入采用「跳过重复」策略：内容与主题都相同的笔记不会被重复写入。导出的 Markdown 会把图片按 base64 内嵌进去，所以换台机器打开也看得到图。</div>
      <div class="hint" style="margin-top:6px">「清理没用的图片」只删那些<b>没有任何笔记引用</b>的图（比如粘进记录台又没保存的），正在用的图片绝不会动。</div>
    </div>
  `);

  const file = $('[data-act="file"]', card);
  $('[data-act="import"]', card).addEventListener('click', () => file.click());
  $('[data-act="gc-images"]', card).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.gcAttachments(0);
      toast(res.removed ? `清理完成：删掉 ${res.removed} 张没人用的图片` : '没有可清理的图片', 'ok', 3600);
      await refresh();
    } catch (err) {
      toast(`清理失败：${err.message}`, 'err', 4200);
    } finally {
      btn.disabled = false;
    }
  });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      const res = await api.importData(data, 'skip');
      toast(`导入完成：新增 ${res.created} 条，跳过 ${res.skipped} 条`, 'ok', 4200);
      await refresh();
    } catch (err) {
      toast(`导入失败：${err.message}`, 'err', 4600);
    } finally {
      file.value = '';
    }
  });

  return card;
}

/* ------------------------------------------------------------------ 行为 */

function buildBehaviorPanel() {
  const auto = state.settings.autoTagFromContent !== '0';
  const card = el(`
    <div class="card panel">
      <h2 class="panel-title">标签与解析</h2>
      <label class="pick-item" style="padding-left:0">
        <input type="checkbox" data-act="auto" ${auto ? 'checked' : ''} />
        <span class="label">自动把正文中的 <code>#标签</code> 加入笔记标签</span>
      </label>
      <div class="hint">关闭后，正文里的 #标签 只作为文字保留，不再自动变成标签；时间标签（年/月/周）始终自动生成。</div>
    </div>
  `);
  $('[data-act="auto"]', card).addEventListener('change', async (e) => {
    try {
      await api.saveSettings({ autoTagFromContent: e.target.checked ? '1' : '0' });
      await loadSettings();
      toast('已保存');
    } catch (err) { toast(err.message, 'err'); }
  });
  return card;
}

/* ------------------------------------------------------------------ LLM */

function buildLLMPanel() {
  const s = state.settings;
  const llm = state.llm;
  const card = el(`
    <div class="card panel">
      <h2 class="panel-title">AI 综述（可选）<span style="flex:1"></span>
        <span class="hint">${llm.configured ? `已配置${llm.fromEnv ? '（来自环境变量）' : ''}` : '未配置'}</span>
      </h2>
      <div class="hint" style="margin-bottom:12px">
        不配置也完全可用 —— 读书笔记由本地分析引擎生成。配置后，生成的读书笔记开头会多出一段 AI 写的综述。
        兼容任何 OpenAI 风格的接口（DeepSeek、OpenAI、本地 Ollama 等）。
      </div>
      <label class="pick-item" style="padding-left:0;margin-bottom:10px">
        <input type="checkbox" data-act="enabled" ${s.llmEnabled !== '0' ? 'checked' : ''} />
        <span class="label">允许使用 AI 综述功能</span>
      </label>
      <div class="preview-fields">
        <div class="field" style="grid-column:span 2"><label>接口地址（Base URL）</label>
          <input data-act="baseUrl" value="${esc(s.llmBaseUrl || llm.baseUrl || 'https://api.deepseek.com/v1')}" placeholder="https://api.deepseek.com/v1" /></div>
        <div class="field"><label>模型</label>
          <input data-act="model" value="${esc(s.llmModel || llm.model || 'deepseek-chat')}" placeholder="deepseek-chat" /></div>
      </div>
      <div class="form-row" style="margin-top:11px"><label>API Key</label>
        <input class="input" data-act="apiKey" type="password" placeholder="${llm.configured && llm.fromEnv ? '由环境变量提供，可留空' : 'sk-…'}" value="${esc(s.llmApiKey || '')}" /></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button class="btn primary" data-act="save">保存</button>
        <button class="btn" data-act="test">测试连通性</button>
        <span class="hint" data-act="test-out"></span>
      </div>
      <div class="hint" style="margin-top:10px">也可以用环境变量提供：<code>DEEPSEEK_API_KEY</code>、<code>DEEPSEEK_BASE_URL</code>、<code>DEEPSEEK_MODEL</code>。Key 保存在本机数据库里，不会外传。</div>
    </div>
  `);

  $('[data-act="save"]', card).addEventListener('click', async () => {
    try {
      await api.saveSettings({
        llmBaseUrl: $('[data-act="baseUrl"]', card).value.trim(),
        llmModel: $('[data-act="model"]', card).value.trim(),
        llmApiKey: $('[data-act="apiKey"]', card).value.trim(),
        llmEnabled: $('[data-act="enabled"]', card).checked ? '1' : '0',
      });
      await loadSettings();
      toast('已保存 AI 配置');
      const host = $('#main');
      if (host && state.view === 'settings') host.replaceChildren(renderSettings());
    } catch (err) { toast(err.message, 'err'); }
  });

  $('[data-act="test"]', card).addEventListener('click', async () => {
    const out = $('[data-act="test-out"]', card);
    out.textContent = '测试中…';
    try {
      const res = await api.testLLM();
      out.textContent = '✅ 连通正常';
      toast(`连通正常：${res.sample.slice(0, 40)}…`);
    } catch (err) {
      out.textContent = `❌ ${err.message}`;
      toast(err.message, 'err', 4600);
    }
  });

  return card;
}

/* ------------------------------------------------------------------ 外观 */

function buildAppearancePanel() {
  const current = localStorage.getItem('theme') || 'auto';
  const card = el(`
    <div class="card panel">
      <h2 class="panel-title">外观</h2>
      <div style="display:flex;gap:8px">
        ${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']]
          .map(([v, l]) => `<button class="btn ${current === v ? 'primary' : ''}" data-theme-opt="${v}">${l}</button>`)
          .join('')}
      </div>
    </div>
  `);
  for (const btn of card.querySelectorAll('[data-theme-opt]')) {
    btn.addEventListener('click', () => {
      const v = btn.dataset.themeOpt;
      localStorage.setItem('theme', v);
      applyTheme(v);
      for (const b of card.querySelectorAll('[data-theme-opt]')) {
        b.classList.toggle('primary', b.dataset.themeOpt === v);
      }
    });
  }
  return card;
}

export function applyTheme(theme) {
  const t = theme || localStorage.getItem('theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

/* ------------------------------------------------------------------ 快捷键 */

function buildShortcutsPanel() {
  return el(`
    <div class="card panel">
      <h2 class="panel-title">快捷键</h2>
      <table class="tag-table">
        <tbody>
          <tr><td style="width:220px"><kbd>Ctrl</kbd>+<kbd>V</kbd></td><td>在页面任意位置粘贴 → 自动跳到记录台并解析</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td>在记录台保存当前解析出的所有笔记</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>聚焦搜索框</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>关闭弹窗 / 清空搜索</td></tr>
        </tbody>
      </table>
    </div>
  `);
}

export { confirmDialog };