/**
 * 可选的 LLM 增强：把本地汇总好的素材交给大模型，写一段更连贯的「综述」。
 *
 * 完全可选 —— 不配置 API Key 时，系统用纯本地的分析引擎生成读书笔记，
 * 功能不受影响；配置后会在读书笔记最前面多出一节 AI 综述。
 *
 * 配置优先级：环境变量 > 设置页里的配置。
 *   DEEPSEEK_API_KEY / OPENAI_API_KEY
 *   DEEPSEEK_BASE_URL（默认 https://api.deepseek.com/v1）
 *   DEEPSEEK_MODEL（默认 deepseek-chat）
 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

export function resolveLLM(store) {
  const s = store.settings.all();
  const apiKey =
    process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || s.llmApiKey || '';
  return {
    baseUrl: (process.env.DEEPSEEK_BASE_URL || s.llmBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || s.llmModel || DEFAULT_MODEL,
    apiKey,
    configured: !!apiKey,
    fromEnv: !!(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY),
    enabled: s.llmEnabled !== '0',
  };
}

const SYSTEM_PROMPT = `你是一位严谨的读书笔记整理助手。用户会给你一批他自己读书时随手记下的零散笔记（摘录、想法、疑问、待办），以及它们所属的主题。

请输出一段 Markdown 格式的「综述」，要求：
1. 用 3-5 个小标题组织，例如「这一主题在讲什么」「几条主线」「笔记之间的矛盾或张力」「可以继续追问的问题」。
2. 只使用素材中真实出现的信息、概念和原话，绝对不要编造书中没有的观点、人名、数据或页码。
3. 需要引用原文时用 > 引用块，并保留出处（书名/页码/日期）。
4. 语言凝练，不要写"综上所述""总而言之"这类空话，不要重复罗列素材本身。
5. 直接输出 Markdown 正文，不要写一级标题，不要写代码块包裹。`;

export async function generateSummary({ material, title, config, timeoutMs = 120000 }) {
  if (!config?.apiKey) throw new Error('尚未配置 LLM API Key（可在「设置」里填写，或设置环境变量 DEEPSEEK_API_KEY）');

  const body = {
    model: config.model,
    temperature: 0.3,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `主题：${title || '（未命名）'}\n\n以下是素材：\n\n${material}` },
    ],
  };

  let res;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`调用 LLM 失败：${err?.message || err}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`LLM 返回 ${res.status}：${text.slice(0, 300)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`LLM 返回内容无法解析：${text.slice(0, 200)}`); }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 没有返回内容');
  return String(content).replace(/^```(?:markdown)?\n?|```$/g, '').trim();
}

/** 测试连通性 */
export async function ping(config) {
  const out = await generateSummary({
    material: '摘录：测试。\n想法：这是一次连通性测试。',
    title: '连通性测试',
    config,
    timeoutMs: 30000,
  });
  return out.slice(0, 200);
}