// الاعتمادية والتحكم: حساب الاستهلاك والتكلفة، ميزانية شهرية، مراقب صحة يبلغ المالك فوراً بأي عطل،
// طلبات ما تضيع (لو الذكاء الاصطناعي انقطع أو خلص الرصيد تنحفظ وتتنفذ تلقائياً أول ما يرجع)، واختيار قوة العقل.
const C = require('./config');
const db = require('./db');
const U = require('./util');
const ch = require('./channels');
const { T } = require('./tools');

const API = () => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const MODELS = { economy: 'claude-haiku-5-5', balanced: 'claude-sonnet-5-5', max: 'claude-opus-5-5' };
const MODE_NAME = { economy: 'اقتصادي (Haiku)', balanced: 'متوازن (Sonnet)', max: 'الأقوى (Opus)' };

// ---------- قوة العقل ----------
// economy: الكل Haiku ما عدا وكيل الملفات ووكيل المواقع (Sonnet)؛ balanced: Sonnet؛ max: Opus للمدير والوكلاء
async function modelFor(agent) {
  const s = await db.getSettings().catch(() => ({}));
  const mode = MODELS[s.ai_mode] ? s.ai_mode : 'balanced';
  if (process.env.CLAUDE_MODEL && mode === 'balanced') return process.env.CLAUDE_MODEL;
  if (mode === 'economy' && ['builder', 'web'].includes(agent)) return MODELS.balanced;
  return MODELS[mode];
}

// ---------- الأسعار والتكلفة (دولار لكل مليون توكن — تقديرية وقابلة للتعديل من الإعدادات ai_prices) ----------
const PRICES = {
  haiku: { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125, hi: { at: 100000, in: 0.50, out: 2.50, cr: 0.05, cw: 0.625 } },
  sonnet: { in: 2.00, out: 10.00, cr: 0.10, cw: 2.50 },
  opus: { in: 4.00, out: 20.00, cr: 0.20, cw: 5.00 }
};
const SEARCH_COST = 0.01; // لكل عملية بحث في الإنترنت
const family = m => /haiku/.test(m) ? 'haiku' : /opus/.test(m) ? 'opus' : 'sonnet';
function costOf(model, u, prices) {
  let p = (prices && prices[family(model)]) || PRICES[family(model)];
  const prompt = (u.input || 0) + (u.cache_read || 0) + (u.cache_write || 0);
  if (p.hi && prompt > p.hi.at) p = p.hi;
  return ((u.input || 0) * p.in + (u.output || 0) * p.out + (u.cache_read || 0) * p.cr + (u.cache_write || 0) * p.cw) / 1e6 + (u.searches || 0) * SEARCH_COST;
}

let budgetCheckAt = 0;
async function recordUsage(agent, model, usage) {
  if (!usage) return;
  const u = { input: usage.input_tokens || 0, output: usage.output_tokens || 0, cache_read: usage.cache_read_input_tokens || 0, cache_write: usage.cache_creation_input_tokens || 0,
    searches: (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0 };
  const s = await db.getSettings().catch(() => ({}));
  const cost = costOf(model, u, s.ai_prices);
  await db.q('INSERT INTO ai_usage (agent, model, input, output, cache_read, cache_write, searches, cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [agent || 'other', model, u.input, u.output, u.cache_read, u.cache_write, u.searches, cost]).catch(e => console.error('usage', e.message));
  if (Date.now() - budgetCheckAt > 5 * 6e4) { budgetCheckAt = Date.now(); checkBudget().catch(() => {}); }
}

const SAR = usd => Math.round(usd * 3.75 * 100) / 100;
const money = usd => `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)} (≈ ${SAR(usd)} ريال)`;
async function totals() {
  const r = await db.one(`SELECT
    coalesce(sum(cost) FILTER (WHERE at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'),0) AS today,
    coalesce(sum(cost) FILTER (WHERE at >= now() - interval '7 days'),0) AS week,
    coalesce(sum(cost) FILTER (WHERE at >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'),0) AS month,
    count(*) FILTER (WHERE at >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh') AS calls FROM ai_usage`);
  return { today: Number(r.today), week: Number(r.week), month: Number(r.month), calls: Number(r.calls) };
}
const AGENT_NAMES = { manager: '🧠 المدير', builder: '🛠️ الملفات والتحليل', web: '🌐 المواقع', research: '🔎 البحث والتقارير', travel: '✈️ السفر', money: '💰 المالية', shopping: '🛒 التسوق', writer: '✍️ الكتابة', planner: '🎯 التخطيط', gov: '🏛️ الحكومية', health: '🩺 الصحة', secretary: '📋 السكرتير', quick: '⚡ ردود سريعة', routine: '🔁 المهام المتكررة', pricewatch: '🔔 متابعة الأسعار', other: '• أخرى' };
async function usageReport() {
  const s = await db.getSettings();
  const t = await totals();
  const byAgent = await db.many(`SELECT agent, sum(cost) AS c, count(*) AS n FROM ai_usage WHERE at >= now() - interval '30 days' GROUP BY agent ORDER BY c DESC LIMIT 8`);
  const budget = Number(s.monthly_budget || 0);
  const L = ['💰 **استهلاك الذكاء الاصطناعي** (تقديري)', '',
    `• اليوم: ${money(t.today)}`, `• آخر 7 أيام: ${money(t.week)}`, `• هالشهر: ${money(t.month)} — ${t.calls} طلب`];
  if (budget) L.push(`• الميزانية الشهرية: $${budget} — مستهلك ${Math.round(t.month / budget * 100)}%`);
  const days = Number(U.riyadhDay().slice(8, 10)) || 1;
  if (t.month > 0) L.push(`• المتوقع لنهاية الشهر بنفس المعدل: ${money(t.month / days * 30)}`);
  if (byAgent.length) L.push('', '**وين يروح الاستهلاك (آخر 30 يوم):**', ...byAgent.map(a => `${AGENT_NAMES[a.agent] || a.agent}: $${Number(a.c).toFixed(2)} (${a.n} طلب)`));
  L.push('', `🧠 قوة العقل الحالية: ${MODE_NAME[s.ai_mode] || MODE_NAME.balanced}`, 'تغيّرها وتحدد ميزانية من لوحة التحكم ← الإعدادات ← «العقل والاستهلاك».');
  return L.join('\n');
}
async function checkBudget() {
  const s = await db.getSettings();
  const budget = Number(s.monthly_budget || 0);
  if (!budget) return;
  const { month } = await totals();
  const key = U.riyadhDay().slice(0, 7);
  const sent = (s.budget_alerts && s.budget_alerts.month === key) ? s.budget_alerts : { month: key };
  const pct = month / budget * 100;
  for (const lvl of [100, 80]) {
    if (pct >= lvl && !sent['p' + lvl]) {
      for (const l of [100, 80]) if (l <= lvl) sent['p' + l] = true;
      await db.setSetting('budget_alerts', sent);
      await ch.notifyOwner(`💰 **تنبيه الميزانية:** صرف السكرتير هالشهر ${money(month)} = ${Math.round(pct)}% من ميزانيتك ($${budget}).${lvl === 100 ? '\nتقدر ترفع الميزانية أو تحوّل العقل لـ«اقتصادي» من لوحة التحكم. (ما وقفته — يكمل شغله عادي)' : ''}`);
      return;
    }
  }
}

// ---------- الرصيد ----------
let creditOut = null;
async function noteError(err) {
  if (/credit balance|billing/i.test(String(err && err.message)) && !creditOut) {
    creditOut = new Date().toISOString();
    await db.setSetting('ai_credit_out', creditOut).catch(() => {});
    await ch.notifyOwner('🔴 **رصيد الذكاء الاصطناعي (Anthropic) خلص.**\nالسكرتير ما يقدر يفكر لين تشحن: console.anthropic.com ← Billing.\n✅ طلباتك ما بتضيع: أي رسالة ترسلها الحين أحفظها وأنفذها تلقائياً أول ما يرجع الرصيد.\n⚡ الأوامر السريعة (اليوم، حالة النظام، القائمة) والتذكيرات شغالة عادي.').catch(() => {});
  }
}
async function noteSuccess() {
  if (!creditOut) return;
  creditOut = null;
  await db.setSetting('ai_credit_out', null).catch(() => {});
  await ch.notifyOwner('🟢 رجع رصيد الذكاء الاصطناعي، والسكرتير رجع يشتغل كامل. أي طلبات محفوظة بنفذها الحين.').catch(() => {});
  setTimeout(() => processQueue().catch(() => {}), 2000);
}
const isCreditOut = () => !!creditOut;

// ---------- طلبات ما تضيع ----------
const retryable = e => !!(e && (e.network || [429, 500, 502, 503, 529, 401].includes(e.status) || /credit balance|billing|overloaded/i.test(e.message)));
async function enqueue({ channel, text, attachments = [] }, e) {
  const n = await db.one("SELECT count(*) AS n FROM pending_requests WHERE status='pending'");
  if (Number(n.n) >= 20) return null;
  await db.q('INSERT INTO pending_requests (channel, text, attachments, reason) VALUES ($1,$2,$3,$4)', [channel, text || '', JSON.stringify(attachments || []), String(e && e.message || '').slice(0, 200)]);
  const why = /credit balance|billing/i.test(e && e.message) ? 'رصيد الذكاء الاصطناعي خلص' : e && e.status === 401 ? 'مفتاح الذكاء الاصطناعي فيه مشكلة' : 'الاتصال بالذكاء الاصطناعي متقطع';
  return `⏳ ${why} الحين، بس **طلبك محفوظ** وبنفذه تلقائياً أول ما يرجع وأرسل لك النتيجة هنا — ما تحتاج تعيده.`;
}
// يحاول ينفذ الطلب، ولو فشل بسبب مؤقت يحفظه. يرجع نص الرد للمالك
async function runOrQueue(req, run) {
  try { return await run(); }
  catch (e) {
    if (retryable(e)) { await noteError(e); const q = await enqueue(req, e).catch(() => null); if (q) return q; }
    throw e;
  }
}
async function sendTo(channel, text) {
  if (channel === 'telegram' && ch.tgEnabled()) { const id = await ch.ownerTelegramId(); if (id) return ch.tgSend(id, text); }
  if (channel === 'whatsapp' && C.OWNER_PHONE) return ch.sendWhatsApp(C.OWNER_PHONE, text);
  return ch.notifyOwner(text);
}
let qBusy = false;
async function processQueue() {
  if (qBusy || creditOut) return;
  qBusy = true;
  try {
    for (let i = 0; i < 5; i++) {
      const r = await db.one("UPDATE pending_requests SET status='running', attempts=attempts+1 WHERE id=(SELECT id FROM pending_requests WHERE status='pending' ORDER BY id LIMIT 1) RETURNING *");
      if (!r) break;
      const when = U.fmt(r.created_at).slice(11);
      if (Date.now() - new Date(r.created_at).getTime() > 24 * 3600e3) {
        await db.q("UPDATE pending_requests SET status='expired', done_at=now() WHERE id=$1", [r.id]);
        await sendTo(r.channel, `⌛ طلبك من ${U.fmt(r.created_at)} «${String(r.text).slice(0, 80)}» مر عليه أكثر من يوم وما قدرت أنفذه. أرسله مرة ثانية لو تحتاجه.`).catch(() => {});
        continue;
      }
      try {
        const out = await require('./agents').runManager(r.text, { attachments: r.attachments || [], channel: r.channel, progress: p => sendTo(r.channel, p) });
        await db.q("UPDATE pending_requests SET status='done', done_at=now() WHERE id=$1", [r.id]);
        await sendTo(r.channel, `✅ **طلبك المحفوظ من الساعة ${when}:** «${String(r.text || '[مرفق]').slice(0, 80)}»\n\n${out}`);
      } catch (e) {
        const again = retryable(e) && r.attempts < 6;
        await db.q('UPDATE pending_requests SET status=$2, reason=$3 WHERE id=$1', [r.id, again ? 'pending' : 'failed', String(e.message).slice(0, 200)]);
        if (!again) await sendTo(r.channel, `⚠️ ما قدرت أنفذ طلبك «${String(r.text).slice(0, 80)}»: ${require('./llm').friendlyError(e)}`).catch(() => {});
        if (again) { await noteError(e); break; }
      }
    }
  } finally { qBusy = false; }
}

// ---------- مراقب الصحة (كل 5 دقايق) ----------
async function probeAI() {
  const r = await fetch(API() + '/v1/models?limit=1', { headers: { 'x-api-key': C.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8000) }).catch(e => ({ err: (e.cause && e.cause.code) || e.message }));
  if (r.err) return { ok: false, why: 'السيرفر ما يوصل لخدمة الذكاء الاصطناعي (' + r.err + ')' };
  if (r.status === 401) return { ok: false, why: 'مفتاح Anthropic غلط أو انلغى' };
  if (!r.ok) return { ok: false, why: 'خدمة الذكاء الاصطناعي ردت ' + r.status };
  return { ok: true };
}
// لما الرصيد خالص: نجرب طلب صغير جداً (شبه مجاني) نعرف منه إذا انشحن
async function probeCredit() {
  const r = await fetch(API() + '/v1/messages', { method: 'POST', headers: { 'x-api-key': C.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELS.economy, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }), signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) return;
  if (r.ok) return noteSuccess();
  const d = await r.json().catch(() => ({}));
  if (!/credit balance|billing/i.test(JSON.stringify(d))) return noteSuccess();
}

const CHECKS = {
  ai: { name: 'الذكاء الاصطناعي', after: 2, run: probeAI },
  whatsapp: { name: 'واتساب السكرتير', after: 2, run: async () => {
    if (!ch.evoEnabled()) return { ok: true };
    const w = await ch.evoStatus().catch(e => ({ error: e.message }));
    if (w.error) return { ok: false, why: 'خدمة واتساب (Evolution) ما ترد' };
    return w.connected ? { ok: true } : { ok: false, why: 'رقم السكرتير مفصول — اربطه من لوحة التحكم ← الإعدادات ← واتساب' };
  } },
  browser: { name: 'المتصفح (حجز المواقع)', after: 6, run: async () => {
    const W = require('./web'); if (!W.enabled()) return { ok: true };
    const r = await W.ready(); return r === true ? { ok: true } : { ok: false, why: String(r || 'ما رد') };
  } },
  voice: { name: 'الرسائل الصوتية', after: 8, run: async () => {
    const s = await db.getSettings();
    if (!process.env.WHISPER_URL || process.env.GROQ_API_KEY || s.groq_key) return { ok: true };
    return (await require('./voice').localReady()) ? { ok: true } : { ok: false, why: 'خدمة تحويل الصوت (whisper) ما ترد' };
  } },
  google: { name: 'Gmail وتقويم Google', after: 3, onlyIfWasOk: true, run: async () => {
    const g = await require('./google').status().catch(() => null);
    if (!g) return { ok: true };
    return g.gmail && g.calendar ? { ok: true } : { ok: false, why: 'ربط Google انقطع (غالباً انتهت صلاحية الدخول) — يحتاج إعادة ربط في n8n' };
  } },
  disk: { name: 'مساحة السيرفر', after: 1, run: async () => {
    try { const st = require('fs').statfsSync('/'); const gb = st.bavail * st.bsize / 1e9; return gb < 3 ? { ok: false, why: `باقي ${gb.toFixed(1)} GB بس` } : { ok: true }; } catch (_) { return { ok: true }; }
  } }
};
let lastWatch = 0, lastCreditProbe = 0, watching = false;
async function watch(force = false) {
  if (watching || (!force && Date.now() - lastWatch < 5 * 6e4)) return;
  lastWatch = Date.now(); watching = true;
  try { await watchInner(); } finally { watching = false; }
}
async function watchInner() {
  const s = await db.getSettings();
  if (creditOut === null && s.ai_credit_out) creditOut = s.ai_credit_out; // بعد إعادة التشغيل
  if (creditOut && Date.now() - lastCreditProbe > 10 * 6e4) { lastCreditProbe = Date.now(); await probeCredit().catch(() => {}); }
  const state = { ...(s.health || {}) };
  const msgs = [];
  for (const [k, c] of Object.entries(CHECKS)) {
    const r = await Promise.race([c.run(), new Promise(res => setTimeout(() => res({ ok: false, why: 'الفحص ما رد' }), 15000))]).catch(e => ({ ok: false, why: e.message }));
    const prev = state[k] || { ok: true, fails: 0, seenOk: false };
    if (r.ok) {
      if (prev.alerted) msgs.push(`✅ رجع يشتغل: ${c.name}`);
      state[k] = { ok: true, fails: 0, seenOk: true };
    } else {
      const fails = (prev.fails || 0) + 1;
      const alert = !prev.alerted && fails >= c.after && (!c.onlyIfWasOk || prev.seenOk);
      if (alert) msgs.push(`🔴 ${c.name}: ${r.why}`);
      state[k] = { ok: false, fails, why: r.why, since: prev.since || new Date().toISOString(), alerted: prev.alerted || alert, seenOk: prev.seenOk };
    }
  }
  await db.setSetting('health', state);
  if (msgs.length) await ch.notifyOwner('🩺 **مراقب النظام**\n' + msgs.join('\n')).catch(() => {});
  if (!creditOut && state.ai && state.ai.ok) processQueue().catch(e => console.error('queue', e.message));
}

// ---------- أدوات للمدير ----------
const S = (props, required = []) => ({ type: 'object', properties: props, required });
T.system_status = { name: 'system_status', description: 'فحص حقيقي لحالة النظام الحين (الذكاء الاصطناعي، واتساب، تيليجرام، Gmail، الصوت، المتصفح، آخر الأعطال). استخدمه لأي سؤال عن الأعطال أو «هل كل شي شغال» — لا تفترض.', input_schema: S({}),
  handler: async () => require('./quick').status() };
T.usage_report = { name: 'usage_report', description: 'كم صرف السكرتير على الذكاء الاصطناعي (اليوم، الأسبوع، الشهر، حسب الوكيل) والميزانية وقوة العقل الحالية.', input_schema: S({}),
  handler: async () => usageReport() };

module.exports = { modelFor, recordUsage, costOf, usageReport, totals, checkBudget, noteError, noteSuccess, isCreditOut, retryable, enqueue, runOrQueue, processQueue, watch, MODELS, MODE_NAME };
