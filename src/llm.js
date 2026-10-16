// محرك Claude: استدعاء مع أدوات + حلقة تنفيذ حتى ينتهي الوكيل
const C = require('./config');

async function callClaude({ system, messages, tools, model = C.MODEL, maxTokens = 4096, toolChoice, container, mcpServers, betas = [] }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (toolChoice) body.tool_choice = toolChoice;
  if (container) body.container = container;
  const headers = { 'x-api-key': C.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (tools && tools.length) {
    body.tools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  }
  // خدمات خارجية (MCP): تنضاف بعد نقطة الكاش عشان ما تكسرها
  if (mcpServers && mcpServers.length) {
    body.mcp_servers = mcpServers.map(m => ({ type: 'url', url: m.url, name: m.name, ...(m.token ? { authorization_token: m.token } : {}) }));
    body.tools = [...(body.tools || []), ...mcpServers.map(m => ({ type: 'mcp_toolset', mcp_server_name: m.name }))];
    betas = [...betas, 'mcp-client-2025-11-20'];
  }
  if (betas.length) headers['anthropic-beta'] = [...new Set(betas)].join(',');
  let lastErr;
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
        method: 'POST', headers, body: payload, signal: AbortSignal.timeout(300000)
      });
    } catch (e) { // انقطاع شبكة (اتصال قديم انقفل، DNS...): نعيد المحاولة باتصال جديد
      const code = (e.cause && (e.cause.code || e.cause.name || e.cause.message)) || e.name || e.message;
      lastErr = new Error(`انقطع الاتصال بـ Claude (${String(code).slice(0, 60)})`); lastErr.network = true;
      console.error('claude fetch', attempt, code);
      if (e.name === 'TimeoutError' || attempt === 3) break;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    lastErr = new Error('Claude ' + res.status + ': ' + JSON.stringify(data).slice(0, 400)); lastErr.status = res.status;
    if (![429, 500, 502, 503, 529].includes(res.status) || attempt === 3) break;
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  require('./db').log('error', '⚠️ ' + lastErr.message.slice(0, 300)).catch(() => {});
  throw lastErr;
}

const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 16000);
const CODE_EXEC_STABLE = 'code_execution_20250825';
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
// ملفات أنتجها تنفيذ الكود (Excel/PowerPoint/Word/PDF/صور...) داخل حاوية Anthropic
function filesOf(content) {
  const ids = [];
  for (const b of content || []) {
    if (b.type === 'bash_code_execution_tool_result' && b.content && b.content.type === 'bash_code_execution_result')
      for (const o of b.content.content || []) if (o.file_id) ids.push(o.file_id);
    if (b.type === 'code_execution_tool_result' && b.content && Array.isArray(b.content.content))
      for (const o of b.content.content) if (o.file_id) ids.push(o.file_id);
  }
  return ids;
}

async function runAgent({ system, input, history = [], tools = [], model = C.MODEL, maxSteps = 16, ctx = {}, onStep, skills, mcpServers }) {
  const clientTools = tools.filter(t => t.handler);
  const byName = Object.fromEntries(clientTools.map(t => [t.name, t]));
  let apiTools = tools.map(t => t.handler ? { name: t.name, description: t.description, input_schema: t.input_schema } : t.spec);
  const messages = [...history, { role: 'user', content: input }];
  const steps = [], files = [];
  let usage = { in: 0, out: 0 }, containerId = null;
  let mcp = mcpServers && mcpServers.length ? mcpServers : null, betas = [];
  const call = async (extra = {}) => {
    const container = skills && skills.length ? { ...(containerId ? { id: containerId } : {}), skills: skills.map(id => ({ type: 'anthropic', skill_id: id, version: 'latest' })) } : (containerId || undefined);
    try { return await callClaude({ system, messages, tools: apiTools, model, maxTokens: AGENT_MAX_TOKENS, container, mcpServers: mcp, betas, ...extra }); }
    catch (e) { // خدمة MCP خارجية معطلة: نكمل بدونها بدل ما يفشل الطلب كله
      if (mcp && /mcp/i.test(e.message)) { console.error('mcp off:', e.message.slice(0, 200)); mcp = null; steps.push({ tool: 'mcp', ok: false, result: 'تعذر الاتصال بخدمة خارجية' }); return call(extra); }
      // نسخة أداة تشغيل الكود غير مدعومة: نرجع للنسخة المستقرة
      const ce = apiTools.find(t => t && t.type && /^code_execution_/.test(t.type) && t.type !== CODE_EXEC_STABLE);
      if (ce && /code_execution|tool|type/i.test(e.message) && / 400/.test(e.message)) { console.error('code exec fallback:', e.message.slice(0, 200)); apiTools = apiTools.map(t => t === ce ? { ...t, type: CODE_EXEC_STABLE } : t); betas = ['code-execution-2025-08-25', 'skills-2025-10-02', 'files-api-2025-04-14']; return call(extra); }
      throw e;
    }
  };

  for (let i = 0; i < maxSteps; i++) {
    const data = await call();
    if (data.container && data.container.id) containerId = data.container.id;
    files.push(...filesOf(data.content));
    usage.in += (data.usage?.input_tokens || 0) + (data.usage?.cache_read_input_tokens || 0);
    usage.out += data.usage?.output_tokens || 0;
    messages.push({ role: 'assistant', content: data.content });

    for (const b of data.content || []) {
      if (b.type === 'server_tool_use') steps.push({ tool: b.name, input: b.input });
      if (b.type === 'mcp_tool_use') steps.push({ tool: (b.server_name || 'mcp') + ':' + b.name, input: b.input });
    }

    if (data.stop_reason === 'pause_turn') continue;
    // انقطع لأنه طول: إذا انقطع وسط أداة نطلب منه يكمل باختصار
    if (data.stop_reason === 'max_tokens' && (data.content || []).some(b => b.type === 'tool_use')) {
      messages.pop();
      const partial = textOf(data.content);
      if (partial) messages.push({ role: 'assistant', content: partial });
      messages.push({ role: 'user', content: 'ردك طلع طويل وانقطع. كمّل بنفس المطلوب لكن قسّمه: لو مستند طويل اكتبه أقصر ومركز، ولو أدوات نفذها وحدة وحدة.' });
      continue;
    }
    if (data.stop_reason !== 'tool_use') {
      let text = textOf(data.content);
      if (!String(text || '').trim()) { // أحياناً ينهي بدون نص: نطلب الرد النهائي صراحة
        messages.push({ role: 'user', content: 'اكتب الحين ردك النهائي للمالك (وش انعمل وش الخطوة الجاية) بدون أدوات.' });
        const fin = await call({ toolChoice: { type: 'none' } }).catch(() => null);
        text = fin ? textOf(fin.content) : '';
      }
      if (!String(text || '').trim()) text = files.length ? '✅ جهزت الملفات المطلوبة' : fallbackText(steps);
      return { text, steps, usage, files: [...new Set(files)] };
    }

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
      const blocks = out && out.__blocks; // نتيجة فيها صور (لقطة شاشة)
      const str = blocks ? String(out.__text || '') : typeof out === 'string' ? out : JSON.stringify(out, null, 0);
      const shown = tool && tool.redact ? tool.redact(b.input || {}) : b.input; // ما نحفظ الأرقام الحساسة في السجل
      steps.push({ tool: b.name, input: shown, ok: !isError, result: str.slice(0, 300) });
      if (onStep) { try { await onStep(b.name, shown, isError); } catch (_) {} }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: blocks || str.slice(0, 20000), is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }
  // تجاوز الحد: نطلب خلاصة نهائية
  messages.push({ role: 'user', content: 'توقف عن استخدام الأدوات الآن واكتب خلاصة ما أنجزته وما بقي.' });
  const final = await call({ toolChoice: { type: 'none' } }).catch(() => null);
  if (final) files.push(...filesOf(final.content));
  const text = final ? textOf(final.content) : '';
  return { text: String(text || '').trim() ? text : fallbackText(steps), steps, usage, files: [...new Set(files)] };
}

// لو ما رجع نص أبداً: نلخص وش انعمل من الأدوات بدل رد فاضي
function fallbackText(steps) {
  const done = steps.filter(s => s.ok !== false && s.result).slice(-4).map(s => '• ' + String(s.result).replace(/^"|"$/g, '').slice(0, 220));
  return done.length ? '✅ تم:\n' + done.join('\n') : 'تمام 👍 وش تبيني أسوي بالضبط؟';
}

// خطأ مفهوم للمالك بدل رسائل تقنية
function friendlyError(e) {
  const m = String((e && e.message) || e || '');
  if (e && e.network || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(m)) return '⚠️ انقطع الاتصال لحظة وأعدت المحاولة أكثر من مرة وما زبط. أرسل طلبك مرة ثانية بعد دقيقة.';
  if (/credit balance|billing/i.test(m)) return '⚠️ رصيد Anthropic (الذكاء الاصطناعي) خلص. اشحن الرصيد من console.anthropic.com ← Billing وبعدها أرجع أشتغل على طول.';
  if (/Claude 401|authentication|invalid x-api-key/i.test(m)) return '⚠️ مفتاح Anthropic (ANTHROPIC_API_KEY) غير صالح. لازم يتحدث في إعدادات السيرفر.';
  if (/Claude (429|529)|overloaded|rate_limit/i.test(m)) return '⚠️ الذكاء الاصطناعي مزحوم الحين. جرب بعد دقيقة.';
  if (/TimeoutError|aborted due to timeout/i.test(m)) return '⚠️ الطلب طوّل أكثر من اللازم ووقف. جرب تقسمه لطلبات أصغر.';
  return '⚠️ صار خطأ: ' + m.slice(0, 250);
}

module.exports = { callClaude, ask, runAgent, parseJson, textOf, filesOf, friendlyError };
