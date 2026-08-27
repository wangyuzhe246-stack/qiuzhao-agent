// DeepSeek Responses API 封装
// 参考调用：
//   POST https://api.deepseek.com/v1/responses
//   { model: "deepseek-v4-flash", input: "...", tools: [{ type: "web_search", search_context_size: "medium" }] }
// 返回 data.output_text 为最终文本，data.output 的 message item 里带 url_citation 来源。
const store = require('./store');

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

function getApiKey() {
  const settings = store.load('settings', {});
  return (settings.apiKey && settings.apiKey.trim()) || process.env.DEEPSEEK_API_KEY || '';
}

function assertKey() {
  const key = getApiKey();
  if (!key) {
    throw new Error('还没有设置 DeepSeek API Key，请先到「设置」页填写并保存。');
  }
  return key;
}

// 一次 Responses API 请求；若因参数兼容问题返回 4xx，自动去掉 reasoning 重试一次
async function responses({ input, tools, reasoning, temperature, maxOutputTokens }) {
  const key = assertKey();

  async function call(withReasoning) {
    const body = { model: MODEL, input };
    if (tools) body.tools = tools;
    if (withReasoning && reasoning) body.reasoning = reasoning;
    if (temperature != null) body.temperature = temperature;
    if (maxOutputTokens) body.max_output_tokens = maxOutputTokens;
    const resp = await fetch(`${BASE}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp.json();
    let detail = '';
    try { detail = await resp.text(); } catch (e) {}
    return { _status: resp.status, _detail: detail.slice(0, 500) };
  }

  let data = await call(true);
  if (data._status) {
    // 4xx/5xx：若与 reasoning/参数相关，去掉 reasoning 再试一次
    if ((data._status === 400 || data._status === 422) && reasoning) {
      const retry = await call(false);
      if (!retry._status) return retry;
    }
    throw new Error(`DeepSeek API 请求失败（HTTP ${data._status}）：${data._detail}`);
  }
  return data;
}

// 把任意可能的结构（string / array / object）安全转成字符串
function coerceText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(coerceText).join('');
  if (v && typeof v === 'object') return coerceText(v.text ?? v.content ?? '');
  return '';
}

// 从 responses 返回中抽取最终文本（DeepSeek 不返回 output_text，需遍历 output 数组）
function extractOutputText(data) {
  const parts = [];
  for (const item of data.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text' && part.text) parts.push(part.text);
      }
    }
  }
  return parts.join('');
}

// 统一出口：永远返回字符串（多种结构兜底）
function outputText(data) {
  return extractOutputText(data) || coerceText(data.output_text) || coerceText(data.text) || '';
}

// 从 responses 返回中提取 URL（DeepSeek 不返回 url_citation 标注，需从文本里扫描兜底）
function extractCitations(data) {
  const out = [];
  const seen = new Set();
  const add = (u, t) => {
    const clean = coerceText(u).replace(/[.,;:!?，。；：]+$/, '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push({ url: clean, title: coerceText(t).slice(0, 200) });
    }
  };
  // 1) annotations（OpenAI 风格）
  for (const item of data.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        for (const a of part.annotations || []) {
          if (a.type === 'url_citation') add(a.url, a.title);
        }
      }
    }
  }
  // 2) 从输出文本里扫描 http(s) URL
  const text = outputText(data);
  const urls = text.match(/https?:\/\/[^\s"'<>，。）；】\]]+/g) || [];
  urls.forEach((u) => add(u, ''));
  return out;
}

// 联网搜索：返回 { text, citations }
async function search(prompt, { searchContextSize = 'medium' } = {}) {
  const data = await responses({
    input: prompt,
    tools: [{ type: 'web_search', search_context_size: searchContextSize }],
    reasoning: { effort: 'low' },
  });
  return { text: outputText(data), citations: extractCitations(data) };
}

// 普通对话（不联网）
async function chat(prompt, { reasoning = 'medium', temperature } = {}) {
  const data = await responses({ input: prompt, reasoning: { effort: reasoning }, temperature });
  return outputText(data);
}

// 从 LLM 输出中稳定提取 JSON（容忍代码块围栏与前后杂质）
function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[\[{]/);
  if (start === -1) throw new Error('AI 输出中没有找到 JSON 结构，请重试。');
  for (let i = t.length; i > start; i--) {
    try {
      return JSON.parse(t.slice(start, i));
    } catch (e) {
      /* 尝试更短前缀 */
    }
  }
  throw new Error('AI 输出 JSON 解析失败，请重试。');
}

// 测试 key 是否可用
async function testConnection() {
  const data = await responses({ input: '你好，请只回复：OK', reasoning: { effort: 'low' } });
  const reply = outputText(data);
  return { ok: true, model: MODEL, reply: reply.trim().slice(0, 50) };
}

module.exports = { search, chat, extractJson, testConnection, getApiKey };
