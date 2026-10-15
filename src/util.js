/**
 * 通用工具：时间、文本、指纹。
 */
import { createHash } from 'node:crypto';

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD */
export function todayLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时区的 YYYY-MM-DD HH:mm */
export function nowLocalStamp(d = new Date()) {
  return `${todayLocal(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function nowIso() {
  return new Date().toISOString();
}

/** ISO-8601 周序号 */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** 校验并归一化 YYYY-MM-DD；非法返回 null */
export function toDateStr(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-01`;
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  return null;
}

/** 一个日期归属的时间标签：年 / 月 / 周 */
export function timeTagNames(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(`${dateStr}T00:00:00`);
  return [`${y}年`, `${y}-${pad2(m)}`, `${y}-W${pad2(isoWeek(d))}`];
}

/** 去掉空白与常见格式差异，用于判重与指纹 */
export function normalizeForHash(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function fingerprint(text) {
  return createHash('sha1').update(normalizeForHash(text)).digest('hex').slice(0, 16);
}

export function pad(n) {
  return pad2(n);
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 截断字符串，尽量不切坏中文 */
export function truncate(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…`;
}

/** 第一行有意义的内容 */
export function firstMeaningfulLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

export function uniq(arr) {
  return [...new Set(arr)];
}