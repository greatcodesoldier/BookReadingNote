/**
 * 后端接口封装。
 */

async function request(path, { method = 'GET', body, params } = {}) {
  let url = path;
  if (params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '' ) continue;
      if (Array.isArray(v)) { if (v.length) usp.set(k, v.join(',')); }
      else usp.set(k, String(v));
    }
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

/** 上传图片时可能撞到「图片太大」这类错误，直接把后端的话原样抛出去 */
async function upload(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `上传失败（${res.status}）`);
  return data;
}

export const api = {
  /* 笔记 */
  listNotes: (params) => request('/api/notes', { params }),
  previewPaste: (body) => request('/api/notes/preview', { method: 'POST', body }),
  saveBlocks: (body) => request('/api/notes/bulk', { method: 'POST', body }),
  createNote: (note) => request('/api/notes', { method: 'POST', body: { note } }),
  getNote: (id) => request(`/api/notes/${id}`),
  updateNote: (id, patch) => request(`/api/notes/${id}`, { method: 'PATCH', body: patch }),
  deleteNote: (id) => request(`/api/notes/${id}`, { method: 'DELETE' }),
  updateNoteTags: (id, payload) => request(`/api/notes/${id}/tags`, { method: 'POST', body: payload }),

  /* 图片附件 */
  uploadAttachment: (payload) => upload('/api/attachments', payload),
  attachmentMeta: (id) => request(`/api/attachments/${id}/meta`),
  deleteAttachment: (id) => request(`/api/attachments/${id}`, { method: 'DELETE' }),
  gcAttachments: (graceDays) => request('/api/attachments/gc', { method: 'POST', body: { graceDays } }),

  /* 标签 */
  listTags: (params) => request('/api/tags', { params }),
  createTag: (tag) => request('/api/tags', { method: 'POST', body: tag }),
  updateTag: (id, patch) => request(`/api/tags/${id}`, { method: 'PATCH', body: patch }),
  deleteTag: (id, purge = false) => request(`/api/tags/${id}`, { method: 'DELETE', params: purge ? { purge: 1 } : undefined }),
  mergeTags: (from, into) => request('/api/tags/merge', { method: 'POST', body: { from, into } }),

  /* 统计与分析 */
  facets: (params) => request('/api/facets', { params }),
  stats: () => request('/api/stats'),
  analyze: (body) => request('/api/analyze', { method: 'POST', body }),
  generate: (body) => request('/api/generate', { method: 'POST', body }),
  suggestTags: (text) => request('/api/suggest-tags', { method: 'POST', body: { text } }),

  /* 设置与数据 */
  getSettings: () => request('/api/settings'),
  saveSettings: (patch) => request('/api/settings', { method: 'PATCH', body: patch }),
  testLLM: () => request('/api/llm/test', { method: 'POST' }),
  importData: (data, mode = 'skip') => request('/api/import', { method: 'POST', body: { data, mode } }),
  health: () => request('/api/health'),

  exportUrl(kind, params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) { if (v.length) usp.set(k, v.join(',')); }
      else usp.set(k, String(v));
    }
    const qs = usp.toString();
    return `/api/export/${kind}${qs ? `?${qs}` : ''}`;
  },
};