// استقبال واتساب من Evolution API: رسائل المالك ← المدير، والباقي ← المساعد
const C = require('./config');
const db = require('./db');
const ch = require('./channels');
const quick = require('./quick');
const { decide } = require('./approvals');
const W = require('./watch');
const { appendConversation } = require('./tools');

let agents;
const A = () => (agents = agents || require('./agents'));
const seen = new Set();

const isOwner = num => C.OWNER_PHONE && num && num.slice(-9) === C.OWNER_PHONE.slice(-9);

function extract(msg) {
  const m = msg.message || {};
  const text = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || (m.imageMessage && m.imageMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) || (m.videoMessage && m.videoMessage.caption) || (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message && m.documentWithCaptionMessage.message.documentMessage && m.documentWithCaptionMessage.message.documentMessage.caption) || '';
  const b64 = m.base64 || msg.base64 || null;
  let attachment = null, kind = msg.messageType || Object.keys(m)[0] || 'unknown';
  if (m.imageMessage && b64) attachment = { type: 'image', source: { type: 'base64', media_type: /png/.test(m.imageMessage.mimetype || '') ? 'image/png' : 'image/jpeg', data: b64 } };
  const doc = m.documentMessage || (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message && m.documentWithCaptionMessage.message.documentMessage);
  if (doc && b64 && /pdf/.test(doc.mimetype || '')) attachment = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  const voice = !!(m.audioMessage || m.pttMessage);
  return { text: String(text).trim(), attachment, voice, kind };
}

async function typing(num) {
  ch.evo('POST', `/chat/sendPresence/${C.EVOLUTION_INSTANCE}`, { number: num, presence: 'composing', delay: 3000 }).catch(() => {});
}

async function handleOwner(num, { text, attachment, voice }) {
  const reply = t => ch.sendWhatsApp(num, t);
  if (voice && !text) return reply('🎙️ الرسائل الصوتية ما أقدر أسمعها للحين. اكتبها لي، أو استخدم إملاء الكيبورد 🎤');
  const t = text;
  const map = { 'اليوم': 'today', '/today': 'today', 'مهامي': 'tasks', '/tasks': 'tasks', 'فلوسي': 'money', '/money': 'money', 'المقاضي': 'shop', '/shop': 'shop', 'الفواتير': 'bills', '/bills': 'bills', 'الموافقات': 'approvals', '/approvals': 'approvals' };
  if (map[t]) return reply(await quick[map[t]]());
  let m;
  if ((m = t.match(/^(?:موافق|وافق)\s+#?(\d+)$/))) return reply(await decide(m[1], true));
  if ((m = t.match(/^رفض\s+#?(\d+)$/))) return reply(await decide(m[1], false));
  if ((m = t.match(/^عدل\s+#?(\d+)\s+([\s\S]+)/))) return reply(await decide(m[1], true, m[2]));
  if (!t && !attachment) return;
  typing(num);
  const timer = setInterval(() => typing(num), 8000);
  try {
    const out = await A().runManager(t, { attachments: attachment ? [attachment] : [], channel: 'whatsapp', progress: p => reply(p) });
    await reply(out);
  } catch (e) {
    console.error('wa manager', e);
    await reply('⚠️ صار خطأ: ' + e.message.slice(0, 300));
  } finally { clearInterval(timer); }
}

async function handleEvolution(body) {
  const event = String(body.event || '').toLowerCase().replace(/_/g, '.');
  if (event === 'connection.update') {
    const state = body.data && (body.data.state || body.data.connection);
    const prev = (await db.getSettings()).evo_state;
    await db.setSetting('evo_state', state || 'unknown');
    await db.log('whatsapp', `حالة رقم السكرتير: ${state}`);
    if (state === 'open' && prev !== 'open') await ch.notifyOwner('✅ رقم السكرتير على واتساب متصل وجاهز');
    if (state === 'close' && prev === 'open') await ch.notifyOwner('⚠️ رقم السكرتير انفصل من واتساب. افتح لوحة التحكم ← الإعدادات ← واتساب وامسح رمز QR من جديد.');
    return;
  }
  if (event !== 'messages.upsert') return;
  const list = Array.isArray(body.data) ? body.data : body.data && body.data.messages ? body.data.messages : [body.data];
  for (const msg of list) {
    if (!msg || !msg.key) continue;
    const jid = msg.key.remoteJid || '';
    if (msg.key.fromMe || /@g\.us$|@broadcast$|@newsletter$/.test(jid)) continue;
    if (seen.has(msg.key.id)) continue;
    seen.add(msg.key.id); if (seen.size > 5000) seen.clear();
    // واتساب الجديد قد يرسل المعرف بصيغة @lid، فنأخذ الرقم الحقيقي من الحقول البديلة
    const pn = [msg.key.senderPn, msg.key.remoteJidAlt, msg.key.participantPn, msg.senderPn].find(x => x && /@s\.whatsapp\.net$|^\d+$/.test(x));
    const num = ch.waNumber(pn || jid);
    const parsed = extract(msg);
    if (isOwner(num)) { handleOwner(num, parsed).catch(e => console.error('wa owner', e.message)); continue; }
    const watched = await W.get(num), st = await db.getSettings();
    // شخص تحت المراقبة، أو وضع «أبلغني برسائل الناس»: نوصّل رسالته للمالك ولا نرد عليه
    if (watched || (!st.reply_others && st.forward_others !== false)) {
      const what = parsed.text || (parsed.attachment ? (parsed.attachment.type === 'image' ? '[صورة]' : '[مستند]') : parsed.voice ? '[رسالة صوتية]' : `[${parsed.kind}]`);
      const who = msg.pushName || (watched && watched.name) || num;
      const note = watched
        ? `📩 **رد من ${who}** (${num})${watched.note ? '\n📝 ' + watched.note : ''}\n\n${what}`
        : `📨 **رسالة لرقم السكرتير من ${who}** (${num})\n\n${what}\n\n(ما رديت عليه. قل لي «رد عليه ...» إذا تبي أرد)`;
      await appendConversation(num, msg.pushName, 'customer', what).catch(() => {});
      await db.q("INSERT INTO owner_chat (role, text, channel) VALUES ('agent', $1, 'notify')", [note.replace(/\*\*/g, '')]).catch(() => {});
      await db.log('whatsapp', `رسالة من ${who} (…${num.slice(-4)}) وصّلتها لك`);
      ch.notifyOwner(note).catch(e => console.error('watch notify', e.message));
      continue;
    }
    if (!st.reply_others) { // السكرتير يرد عليك أنت بس
      db.log('whatsapp', `تجاهلت رسالة من ${msg.pushName || ''} (…${num.slice(-4)})`).catch(() => {});
      continue;
    }
    if (!parsed.text) {
      if (parsed.voice) ch.sendWhatsApp(num, 'هلا 👋 وصلت رسالتك الصوتية، ممكن تكتبها نص؟').catch(() => {});
      continue;
    }
    A().handleCustomerMessage(num, msg.pushName, parsed.text).catch(e => console.error('wa other', e.message));
  }
}

module.exports = { handleEvolution, isOwner };
