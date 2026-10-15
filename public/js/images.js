/**
 * 图片摄取：把「粘贴 / 拖进来 / 选中的图片文件」变成系统里的一个附件 URL。
 *
 * 流程是「先上传拿到 URL，再把 URL 插进正文」——
 * 这样正文里存的是稳定地址，刷新、换设备、导出都还是同一张图。
 */
import { api } from './api.js';

/** 与后端 src/db.js 里的 IMAGE_MIMES 保持一致 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

/**
 * 超过这个尺寸就想办法瘦身：截图动辄 3~8MB，
 * 直接进库会让数据库迅速膨胀，而笔记里根本用不到那么高的分辨率。
 */
const SHRINK_IF_BYTES = 2.5 * 1024 * 1024;
const MAX_EDGE = 2200;

export function isImageFile(file) {
  if (!file) return false;
  if (IMAGE_TYPES.includes(String(file.type || '').toLowerCase())) return true;
  // 有些截图工具给不出 type，只能看扩展名
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(file.name || ''));
}

/** 从剪贴板事件里挑出图片；同时把文字也带出来 */
export function readClipboard(event) {
  const dt = event.clipboardData;
  if (!dt) return { text: '', files: [] };
  const files = [];
  for (const item of dt.items || []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (isImageFile(file)) files.push(file);
  }
  // 有些浏览器（或从资源管理器复制的文件）只给 files 不给 items
  if (!files.length) {
    for (const file of dt.files || []) if (isImageFile(file)) files.push(file);
  }
  return { text: dt.getData('text/plain') || '', files };
}

/** 从拖拽事件里分出图片和文本文件 */
export function readDropped(dataTransfer) {
  const images = [];
  const texts = [];
  for (const file of dataTransfer?.files || []) {
    if (isImageFile(file)) images.push(file);
    else texts.push(file);
  }
  return { images, texts };
}

/**
 * 主动读剪贴板（「读剪贴板」按钮用）。
 * 需要浏览器支持 navigator.clipboard.read()，不支持或没授权就直接抛错，
 * 由调用方退回到「只读文字」的老路。
 */
export async function readClipboardAsync() {
  if (!navigator.clipboard?.read) throw new Error('这个浏览器不支持读剪贴板里的图片');
  const items = await navigator.clipboard.read();
  const files = [];
  let text = '';
  for (const item of items) {
    const imgType = item.types.find((t) => t.startsWith('image/'));
    if (imgType) {
      const blob = await item.getType(imgType);
      files.push(new File([blob], 'clipboard.png', { type: imgType }));
    } else if (item.types.includes('text/plain')) {
      text = await (await item.getType('text/plain')).text();
    }
  }
  return { text, files };
}

/** 弹一个系统文件选择框，返回用户选中的图片 */
export function pickImageFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      input.remove();
      resolve(files);
    });
    // 用户点了取消：Chrome 会触发 window 的 focus，用一次性监听收尾
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (document.body.contains(input)) {
          const files = [...(input.files || [])];
          input.remove();
          resolve(files);
        }
      }, 400);
    }, { once: true });
    input.click();
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读不出这个文件'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这不是一张能识别的图片'));
    img.src = dataUrl;
  });
}

/**
 * 把图片转成待上传的 data URL。
 * 太大的会等比缩到 MAX_EDGE 以内；GIF 一律原样上传（缩放会把动画弄没）。
 */
async function prepare(file) {
  const original = await readAsDataUrl(file);
  const mime = String(file.type || '').toLowerCase() || (original.match(/^data:([^;]+);/) || [])[1] || '';
  const out = { dataUrl: original, mime, name: file.name || '', shrunk: false };

  if (!IMAGE_TYPES.includes(mime)) throw new Error(`不支持的图片格式：${mime || '未知'}`);
  if (mime === 'image/gif') return out; // 保住动画

  let img;
  try { img = await loadImage(original); } catch { throw new Error('这不是一张能识别的图片'); }
  out.width = img.naturalWidth;
  out.height = img.naturalHeight;

  const tooBig = file.size > SHRINK_IF_BYTES || Math.max(out.width, out.height) > MAX_EDGE;
  if (!tooBig) return out;

  const scale = Math.min(1, MAX_EDGE / Math.max(out.width, out.height));
  const w = Math.max(1, Math.round(out.width * scale));
  const h = Math.max(1, Math.round(out.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return out;
  ctx.drawImage(img, 0, 0, w, h);

  // PNG 截图里大多是文字，重新编码成 JPEG 会糊，所以保持 PNG
  const targetMime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const shrunkUrl = canvas.toDataURL(targetMime, 0.9);
  if (!shrunkUrl || shrunkUrl.length >= original.length) return out;
  return { ...out, dataUrl: shrunkUrl, mime: targetMime, width: w, height: h, shrunk: true };
}

/**
 * 上传一张图片，返回 { url, shrunk, ... }。
 * 抛出的错误信息可以直接给用户看。
 */
export async function uploadImage(file) {
  const prepared = await prepare(file);
  const res = await api.uploadAttachment({
    dataUrl: prepared.dataUrl,
    name: prepared.name,
    width: prepared.width,
    height: prepared.height,
  });
  return { ...res.attachment, shrunk: prepared.shrunk, originalBytes: file.size };
}

/** 正文里插入图片用的 Markdown 片段 */
export function imageMarkdown(url, alt = '图片') {
  return `![${alt}](${url})`;
}