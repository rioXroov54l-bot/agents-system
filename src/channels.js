// قنوات التواصل: تيليجرام (الأساسية للمالك)، واتساب (العملاء)، n8n (الإيميل والتقويم)
const crypto = require('crypto');
const C = require('./config');
const db = require('./db');

// ================= تيليجرام =================
const TG_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const tgEnabled = () => !!C.TELEGRAM_BOT_TOKEN;
const tgSecret = () => crypto.createHash('sha256').update('tg:' + C.TELEGRAM_BOT_TOKEN).digest('hex').slice(0, 32);

async function tg(method, payload) {
  if (!tgEnabled()) throw new Error('TELEGRAM_BOT_TOKEN غير محدد');
  const res = await fetch(`${TG_BASE}/bot${C.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error('Telegram: ' + (data.description || res.status));
  return data.result;
}

// تيليجرام يقبل HTML محدود؛ نهرب النص ونحول **عريض** فقط
const tgHtml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

async function tgSend(chatId, text, { buttons, keyboard, html = true } = {}) {
  const chunks = [];
  let t = String(text || '').trim() || '—';
  while (t.length > 3900) {
    let cut = t.lastIndexOf('\n', 3900); if (cut < 1000) cut = 3900;
    chunks.push(t.slice(0, cut)); t = t.slice(cut);
  }
  chunks.push(t);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: html ? tgHtml(chunks[i]) : chunks[i], disable_web_page_preview: true };
    if (html) payload.parse_mode = 'HTML';
    if (buttons && i === chunks.length - 1) payload.reply_markup = { inline_keyboard: buttons };
    else if (keyboard && i === chunks.length - 1) payload.reply_markup = { keyboard, resize_keyboard: true, is_persistent: true };
    try { last = await tg('sendMessage', payload); }
    catch (e) { // لو فشل التنسيق نرسل نص خام
      delete payload.parse_mode; payload.text = chunks[i]; last = await tg('sendMessage', payload);
    }
  }
  return last;
}

async function ownerTelegramId() {
  if (C.TELEGRAM_OWNER_ID) return C.TELEGRAM_OWNER_ID;
  const s = await db.getSettings();
  return s.telegram && s.telegram.owner_id || '';
}

async function setupTelegramWebhook() {
  if (!tgEnabled()) return;
  if (!/^https:/.test(C.PUBLIC_URL)) { console.log('⚠️ تيليجرام: PUBLIC_URL ليس https، تخطيت تسجيل الـ webhook'); return; }
  try {
    await tg('setWebhook', {
      url: `${C.PUBLIC_URL}/telegram/${tgSecret()}`,
      secret_token: tgSecret(),
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false
    });
    const { QUICK } = require('./menu');
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'البداية والأزرار' }, ...QUICK.map(q => ({ command: q.cmd, description: `${q.icon} ${q.desc}` })), { command: 'help', description: '📋 كل اللي أقدر أسويه' }] });
    console.log('✅ تيليجرام جاهز');
  } catch (e) { console.error('⚠️ تيليجرام:', e.message); }
}

// ================= واتساب =================
// ---------- Evolution API (واتساب غير رسمي برقم السكرتير) ----------
const evoEnabled = () => !!(C.EVOLUTION_URL && C.EVOLUTION_API_KEY);
const evoSecret = () => crypto.createHash('sha256').update('evo:' + C.EVOLUTION_API_KEY).digest('hex').slice(0, 32);
async function evo(method, path, body) {
  const res = await fetch(`${C.EVOLUTION_URL}${path}`, {
    method, headers: { apikey: C.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  if (!res.ok) { const e = new Error(`Evolution ${res.status}: ${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300)}`); e.status = res.status; throw e; }
  return data;
}
const waNumber = n => String(n).replace(/@.*/, '').replace(/\D/g, '');
// واتساب يتعامل مع **عريض** بنجمة وحدة
const waFormat = s => String(s || '').replace(/\*\*(.+?)\*\*/g, '*$1*');

async function evoSendText(to, text) {
  const chunks = [];
  let t = waFormat(text).trim() || '—';
  while (t.length > 3500) { let cut = t.lastIndexOf('\n', 3500); if (cut < 800) cut = 3500; chunks.push(t.slice(0, cut)); t = t.slice(cut); }
  chunks.push(t);
  for (const c of chunks) await evo('POST', `/message/sendText/${C.EVOLUTION_INSTANCE}`, { number: saNumber(waNumber(to)), text: c });
}

// يتأكد إن نسخة واتساب موجودة ومربوطة بالـ webhook حقنا
async function setupEvolution() {
  if (!evoEnabled()) return;
  const webhook = { enabled: true, url: `${C.INTERNAL_URL || C.PUBLIC_URL}/evolution/${evoSecret()}`, byEvents: false, base64: true, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'] };
  try {
    const list = await evo('GET', '/instance/fetchInstances');
    const exists = (Array.isArray(list) ? list : []).some(i => (i.name || i.instanceName || (i.instance && i.instance.instanceName)) === C.EVOLUTION_INSTANCE);
    if (!exists) {
      await evo('POST', '/instance/create', { instanceName: C.EVOLUTION_INSTANCE, qrcode: true, integration: 'WHATSAPP-BAILEYS', rejectCall: false, groupsIgnore: true, alwaysOnline: false, readMessages: false, syncFullHistory: false, webhook });
      console.log('✅ أنشأت نسخة واتساب:', C.EVOLUTION_INSTANCE);
    } else {
      await evo('POST', `/webhook/set/${C.EVOLUTION_INSTANCE}`, { webhook });
    }
    console.log('✅ واتساب (Evolution) جاهز');
  } catch (e) { console.error('⚠️ Evolution:', e.message); }
}
async function evoStatus() {
  if (!evoEnabled()) return { enabled: false };
  try {
    const st = await evo('GET', `/instance/connectionState/${C.EVOLUTION_INSTANCE}`);
    const state = (st.instance && st.instance.state) || st.state || 'unknown';
    return { enabled: true, state, connected: state === 'open' };
  } catch (e) { return { enabled: true, state: 'error', error: e.message.slice(0, 200) }; }
}
async function evoQR() {
  const r = await evo('GET', `/instance/connect/${C.EVOLUTION_INSTANCE}`);
  return { base64: r.base64 || (r.qrcode && r.qrcode.base64) || null, code: r.code || (r.qrcode && r.qrcode.code) || null, pairingCode: r.pairingCode || null };
}
// ربط برقم الجوال بدل QR: يرجع كود ٨ خانات يُكتب في واتساب ← الأجهزة المرتبطة ← الربط برقم الهاتف
function saNumber(n) {
  let d = String(n || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) d = '966' + d.slice(1);
  if (/^5\d{8}$/.test(d)) d = '966' + d;
  return d;
}
const pickPair = r => r && (r.pairingCode || (r.qrcode && r.qrcode.pairingCode) || (r.instance && r.instance.pairingCode)) || null;
async function evoPair(number) {
  const num = saNumber(number);
  if (!/^\d{10,15}$/.test(num)) throw new Error('رقم غير صحيح. اكتبه مثل 05xxxxxxxx أو 9665xxxxxxxx');
  const inst = C.EVOLUTION_INSTANCE, wait = ms => new Promise(ok => setTimeout(ok, ms));
  const connect = () => evo('GET', `/instance/connect/${inst}?number=${num}`);
  let r = await connect().catch(e => ({ err: e.message })), code = pickPair(r);
  if (!code) {
    // الطريقة المضمونة: نحذف النسخة ونعيد إنشاءها بالرقم، فيرجع كود الربط مباشرة
    await evo('DELETE', `/instance/logout/${inst}`).catch(() => {});
    await evo('DELETE', `/instance/delete/${inst}`).catch(() => {});
    await wait(2000);
    const webhook = { enabled: true, url: `${C.INTERNAL_URL || C.PUBLIC_URL}/evolution/${evoSecret()}`, byEvents: false, base64: true, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'] };
    r = await evo('POST', '/instance/create', { instanceName: inst, number: num, qrcode: true, integration: 'WHATSAPP-BAILEYS', rejectCall: false, groupsIgnore: true, alwaysOnline: false, readMessages: false, syncFullHistory: false, webhook }).catch(e => ({ err: e.message }));
    code = pickPair(r);
    for (let i = 0; !code && i < 4; i++) { await wait(2500); r = await connect().catch(e => ({ err: e.message })); code = pickPair(r); }
  }
  if (!code) {
    console.error('evoPair: no pairingCode', JSON.stringify(r).slice(0, 500));
    throw new Error('ما رجع كود ربط من واتساب. التفاصيل: ' + JSON.stringify(r).replace(/"base64":"[^"]*"/, '"base64":"…"').slice(0, 250));
  }
  code = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return { number: num, code: code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code };
}
async function evoLogout() { return evo('DELETE', `/instance/logout/${C.EVOLUTION_INSTANCE}`); }

// إرسال واتساب: Evolution إذا مفعّل، وإلا واجهة Meta الرسمية
async function sendWhatsApp(to, body) {
  if (String(to).startsWith('test')) return;
  if (evoEnabled()) {
    try { await evoSendText(to, body); await db.setSetting('whatsapp_status', { ok: true, via: 'evolution', at: new Date().toISOString() }); return; }
    catch (e) { await db.setSetting('whatsapp_status', { ok: false, via: 'evolution', at: new Date().toISOString(), err: e.message.slice(0, 300) }); throw e; }
  }
  if (!C.WHATSAPP_TOKEN || !C.PHONE_NUMBER_ID) throw new Error('واتساب غير مفعّل');
  const res = await fetch(`https://graph.facebook.com/${C.GRAPH_VERSION}/${C.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${C.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  });
  if (!res.ok) {
    const err = await res.text();
    await db.setSetting('whatsapp_status', { ok: false, at: new Date().toISOString(), err: err.slice(0, 300) });
    throw new Error('WhatsApp: ' + err.slice(0, 200));
  }
  await db.setSetting('whatsapp_status', { ok: true, at: new Date().toISOString() });
}

// ================= n8n (Gmail + تقويم Google) =================
const n8nReady = () => !!C.N8N_WEBHOOK_URL;
async function n8n(action, data = {}) {
  if (!n8nReady()) throw new Error('n8n غير مربوط (N8N_WEBHOOK_URL)');
  const res = await fetch(C.N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agents-secret': C.N8N_SECRET },
    body: JSON.stringify({ action, ...data }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`n8n ${res.status}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch (_) { return {}; }
}
async function sendEmail({ to, subject, body, cc }) {
  // مباشرة من Gmail (أسرع وأضمن)، وإذا ما تيسر نستخدم n8n
  try { return await require('./google').gmailSend({ to, cc, subject, body }); }
  catch (e) { if (!/غير مربوط|مفتاح n8n/.test(e.message)) console.error('gmail direct', e.message); }
  return n8n('gmail.send', { to, subject, body });
}

// ================= إشعار المالك =================
// يرسل على تيليجرام أولاً، ولو ما فيه يجرب واتساب
async function notifyOwner(text, opts = {}) {
  const s = await db.getSettings();
  const pref = s.notify_channel || 'auto'; // auto | telegram | whatsapp | both
  const waReady = C.OWNER_PHONE && (evoEnabled() || C.WHATSAPP_TOKEN);
  const tgId = tgEnabled() ? await ownerTelegramId().catch(() => '') : '';
  let sent = false;
  const viaTg = async () => { if (!tgId) return false; try { await tgSend(tgId, text, opts); return true; } catch (e) { console.error('notify tg', e.message); return false; } };
  const viaWa = async () => {
    if (!waReady) return false;
    let t = String(text);
    if (opts.buttons) { // واتساب ما يدعم أزرار: نحولها لتعليمات نصية
      const ap = JSON.stringify(opts.buttons).match(/ap:(\d+)/);
      if (ap) t += `\n\nرد بـ: *موافق ${ap[1]}* أو *رفض ${ap[1]}* أو *عدل ${ap[1]} النص*`;
    }
    try { await sendWhatsApp(C.OWNER_PHONE, t); return true; } catch (e) { console.error('notify wa', e.message); return false; }
  };
  if (pref === 'telegram') sent = await viaTg() || await viaWa();
  else if (pref === 'whatsapp') sent = await viaWa() || await viaTg();
  else if (pref === 'both') { const a = await viaTg(); const b = await viaWa(); sent = a || b; }
  else sent = await viaTg() || await viaWa();
  if (!sent) await db.log('notify', 'تعذر إرسال إشعار: ' + String(text).slice(0, 120));
}

async function notifyMember(member, text, opts = {}) {
  if (member && member.telegram_id && tgEnabled()) {
    try { await tgSend(member.telegram_id, text, opts); return true; } catch (e) { console.error('member tg', e.message); }
  }
  if (member && member.email && n8nReady()) {
    try { const p = (await db.getSettings()).profile || {}; await sendEmail({ to: member.email, subject: 'مهمة جديدة' + (p.name ? ' من ' + p.name : ''), body: text.replace(/\*\*/g, '') }); return true; } catch (_) {}
  }
  return false;
}

module.exports = { evo, evoEnabled, evoSecret, evoStatus, evoQR, evoPair, saNumber, evoLogout, setupEvolution, waNumber, TG_BASE, tg, tgSend, tgSecret, tgEnabled, ownerTelegramId, setupTelegramWebhook, sendWhatsApp, n8n, n8nReady, sendEmail, notifyOwner, notifyMember };
