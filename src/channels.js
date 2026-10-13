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

async function tgSend(chatId, text, { buttons, html = true } = {}) {
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
    await tg('setMyCommands', { commands: [
      { command: 'start', description: 'البداية' },
      { command: 'today', description: 'موجز اليوم' },
      { command: 'tasks', description: 'المهام المفتوحة' },
      { command: 'money', description: 'فلوسي هالشهر' },
      { command: 'shop', description: 'قائمة المقاضي' },
      { command: 'bills', description: 'الفواتير والاشتراكات' },
      { command: 'approvals', description: 'الموافقات المعلقة' },
      { command: 'help', description: 'وش أقدر أسوي' }
    ] });
    console.log('✅ تيليجرام جاهز');
  } catch (e) { console.error('⚠️ تيليجرام:', e.message); }
}

// ================= واتساب =================
async function sendWhatsApp(to, body) {
  if (String(to).startsWith('test')) return;
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
async function sendEmail({ to, subject, body }) {
  return n8n('gmail.send', { to, subject, body });
}

// ================= إشعار المالك =================
// يرسل على تيليجرام أولاً، ولو ما فيه يجرب واتساب
async function notifyOwner(text, opts = {}) {
  const id = await ownerTelegramId().catch(() => '');
  if (tgEnabled() && id) {
    try { return await tgSend(id, text, opts); } catch (e) { console.error('notify tg', e.message); }
  }
  if (C.OWNER_PHONE && C.WHATSAPP_TOKEN) {
    try { return await sendWhatsApp(C.OWNER_PHONE, String(text).replace(/\*\*/g, '*')); } catch (e) { console.error('notify wa', e.message); }
  }
  await db.log('notify', 'تعذر إرسال إشعار: ' + String(text).slice(0, 120));
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

module.exports = { TG_BASE, tg, tgSend, tgSecret, tgEnabled, ownerTelegramId, setupTelegramWebhook, sendWhatsApp, n8n, n8nReady, sendEmail, notifyOwner, notifyMember };
