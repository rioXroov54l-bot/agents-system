// محرك Claude: استدعاء مع أدوات + حلقة تنفيذ حتى ينتهي الوكيل
const C = require('./config');

async function callClaude({ system, messages, tools, model = C.MODEL, maxTokens = 4096, toolChoice }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (toolChoice) body.tool_choice = toolChoice;
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (tools && tools.length) {
    body.tools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': C.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    lastErr = new Error('Claude ' + res.status + ': ' + JSON.stringify(data).slice(0, 400));
    if (![429, 500, 502, 503, 529].includes(res.status)) break;
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw lastErr;
}

const textOf = content => (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

// استدعاء بسيط بدون أدوات (نص فقط)
async function ask(system, userText, { model = C.MODEL, maxTokens = 1500 } = {}) {
  const data = await callClaude({ system, messages: [{ role: 'user', content: userText }], model, maxTokens });
  return textOf(data.content);
}
function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; }
}

/**
 * يشغّل وكيل بأدوات حتى ينتهي.
 * tools: [{name, description, input_schema, handler(input, ctx)}] أو أدوات خادم (type: web_search_...)
 */
async function runAgent({ system, input, history = [], tools = [], model = C.MODEL, maxSteps = 16, ctx = {}, onStep }) {
  const clientTools = tools.filter(t => t.handler);
  const byName = Object.fromEntries(clientTools.map(t => [t.name, t]));
  const apiTools = tools.map(t => t.handler ? { name: t.name, description: t.description, input_schema: t.input_schema } : t.spec);
  const messages = [...history, { role: 'user', content: input }];
  const steps = [];
  let usage = { in: 0, out: 0 };

  for (let i = 0; i < maxSteps; i++) {
    const data = await callClaude({ system, messages, tools: apiTools, model });
    usage.in += (data.usage?.input_tokens || 0) + (data.usage?.cache_read_input_tokens || 0);
    usage.out += data.usage?.output_tokens || 0;
    messages.push({ role: 'assistant', content: data.content });

    for (const b of data.content || []) {
      if (b.type === 'server_tool_use') steps.push({ tool: b.name, input: b.input });
    }

    if (data.stop_reason === 'pause_turn') continue;
    if (data.stop_reason !== 'tool_use') return { text: textOf(data.content), steps, usage };

    const results = [];
    for (const b of data.content) {
      if (b.type !== 'tool_use') continue;
      const tool = byName[b.name];
      let out, isError = false;
      try {
        if (!tool) throw new Error('أداة غير معروفة: ' + b.name);
        out = await tool.handler(b.input || {}, ctx);
      } catch (e) {
        isError = true; out = 'خطأ: ' + e.message;
      }
      const str = typeof out === 'string' ? out : JSON.stringify(out, null, 0);
      steps.push({ tool: b.name, input: b.input, ok: !isError, result: str.slice(0, 300) });
      if (onStep) { try { await onStep(b.name, b.input, isError); } catch (_) {} }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: str.slice(0, 20000), is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }
  // تجاوز الحد: نطلب خلاصة نهائية
  messages.push({ role: 'user', content: 'توقف عن استخدام الأدوات الآن واكتب خلاصة ما أنجزته وما بقي.' });
  const final = await callClaude({ system, messages, tools: apiTools, model, toolChoice: { type: 'none' } });
  return { text: textOf(final.content), steps, usage };
}

module.exports = { callClaude, ask, runAgent, parseJson, textOf };
