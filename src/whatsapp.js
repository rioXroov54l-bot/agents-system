// استقبال واتساب من Evolution API: رسائل المالك ← المدير، والباقي ← المساعد
const C = require('./config');
const db = require('./db');
const ch = require('./channels');
const quick = require('./quick');
const { decide } = require('./approvals');
const W = require('./watch');
const M = require('./menu');
let lastMenu = 0;
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
  const au = m.audioMessage || m.pttMessage;
  const voice = !!au;
  const audio = au && b64 ? { data: b64, mime: au.mimetype || 'audio/ogg' } : null;
  return { text: String(text).trim(), attachment, voice, audio, kind };
}

async function typing(num) {
  ch.evo('POST', `/chat/sendPresence/${C.EVOLUTION_INSTANCE}`, { number: num, presence: 'composing', delay: 3000 }).catch(() => {});
}

async function handleOwner(num, { text, attachment, voice, audio }) {
  const reply = t => ch.sendWhatsApp(num, t);
  if (voice && !text) {
    if (!audio) return reply('🎙️ ما وصلني الصوت كامل، أرسله مرة ثانية أو اكتبه.');
    typing(num);
    const keep = setInterval(() => typing(num), 6000);
    const slow = setTimeout(() => reply('🎙️ وصلتني رسالتك، ثواني وأسمعها…').catch(() => {}), 12000);
    try { text = await require('./voice').transcribe(audio.data, audio.mime); }
    catch (e) { db.log('voice', '🎙️ فشل فهم الصوت: ' + e.message.slice(0, 120)).catch(() => {}); return reply('🎙️ ما قدرت أفهم الرسالة الصوتية (' + e.message.slice(0, 80) + '). اكتبها لي أو جرب مرة ثانية.'); }
    finally { clearInterval(keep); clearTimeout(slow); }
    await reply(`🎙️ سمعتك: «${text}»`);
  }
  const t = text;
  const qcmd = M.matchQuick(t);
  if (qcmd === 'menu') { lastMenu = Date.now(); return reply(M.whatsappMenu()); }
  if (qcmd) { typing(num); try { return reply(await quick[qcmd]()); } catch (e) { return reply('⚠️ ' + e.message.slice(0, 200)); } }
  // رقم قسم بعد عرض القائمة (خلال 15 دقيقة)
  const n = t.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  if (/^\d{1,2}$/.test(n) && Date.now() - lastMenu < 15 * 6e4) { const sec = M.sectionByNumber(n); if (sec) return reply(sec + '\n\n📋 أرسل رقم ثاني، أو *القائمة* للرجوع'); }
  let m;
  if ((m = t.match(/^(?:موافق|وافق)\s+#?(\d+)$/))) return reply(await decide(m[1], true));
  if ((m = t.match(/^رفض\s+#?(\d+)$/))) return reply(await decide(m[1], false));
  if ((m = t.match(/^عدل\s+#?(\d+)\s+([\s\S]+)/))) return reply(await decide(m[1], true, m[2]));
  const payReply = t ? await require('./pay').handleOwnerText(t).catch(e => '⚠️ ' + e.message) : null;
  if (payReply) return reply(payReply);
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

// رد شكر قصير ومهذب على اللي راسلناهم نيابة عن المالك (بدون أي التزام)
async function ackReply(watched, theirText, ownerName) {
  const owner = ownerName ? 'الأستاذ ' + ownerName : 'صاحب الرقم';
  const fallback = `شكراً لك 🙏 وصلت رسالتك، وبوصلها لـ${owner} على طول.`;
  const out = await require('./llm').ask(
    `أنت السكرتير الآلي لـ${owner} على واتساب. أرسلت لهذا الشخص رسالة نيابة عنه، وهذا رده عليك. اكتب رد قصير جداً (سطر أو سطرين) مهذب وبلهجة سعودية لطيفة:
- إذا وافق أو أكد أو قال تم/أبشر/تمام ← اشكره على التأكيد وقل إنك بلغت ${owner}.
- إذا سأل سؤال أو طلب شي أو اقترح وقت ← اشكره وقل إن رسالته وصلت وبتوصلها لـ${owner} ويرد عليه قريب.
- إذا اعتذر أو رفض ← اشكره بلطف وقل إنك بتبلغ ${owner}.
- إذا كانت تحية أو شكر فقط ← رد التحية باختصار.
ممنوع: تلتزم بموعد أو مبلغ أو وعد، أو تجاوب عن ${owner} بمعلومات، أو تكرر نص رسالته. إيموجي واحد كحد أقصى. اكتب نص الرد فقط.`,
    `رسالتنا له: ${watched.last_out_text || watched.note || '—'}\n\nرده: ${theirText}`, { model: C.FAST_MODEL, maxTokens: 150 });
  const t = String(out || '').trim().replace(/^["«]|["»]$/g, '');
  return t && t.length < 400 ? t : fallback;
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
      let heard = '';
      if (!parsed.text && parsed.audio) heard = await require('./voice').transcribe(parsed.audio.data, parsed.audio.mime).catch(() => '');
      const what = parsed.text || (heard ? `🎙️ (رسالة صوتية) «${heard}»` : parsed.attachment ? (parsed.attachment.type === 'image' ? '[صورة]' : '[مستند]') : parsed.voice ? '[رسالة صوتية]' : `[${parsed.kind}]`);
      const who = msg.pushName || (watched && watched.name) || num;
      const note = watched
        ? `📩 **رد من ${who}** (${num})${watched.note ? '\n📝 ' + watched.note : ''}\n\n${what}`
        : `📨 **رسالة لرقم السكرتير من ${who}** (${num})\n\n${what}\n\n(ما رديت عليه. قل لي «رد عليه ...» إذا تبي أرد)`;
      await appendConversation(num, msg.pushName, 'customer', what).catch(() => {});
      if (watched) await W.update(num, { last_in: new Date().toISOString() }).catch(() => {});
      // اللي راسلناهم: نرد عليهم بشكر مهذب (مرة لكل رسالة نرسلها لهم، أو كل 3 ساعات) ونبلغهم إن ردهم بيوصل
      let ack = '';
      if (watched && st.watch_ack !== false) {
        const fresh = !watched.acked_at || (watched.last_out && watched.last_out > watched.acked_at) || Date.now() - new Date(watched.acked_at).getTime() > 3 * 3600e3;
        if (fresh) {
          ack = await ackReply(watched, what, (st.profile || {}).name).catch(() => '');
          if (ack) { await ch.sendWhatsApp(num, ack).catch(e => { console.error('ack', e.message); ack = ''; }); }
          if (ack) { await W.update(num, { acked_at: new Date().toISOString() }); await appendConversation(num, null, 'agent', ack).catch(() => {}); }
        }
      }
      const full = note + (ack ? `\n\n🤖 رديت عليه: «${ack}»` : '');
      await db.q("INSERT INTO owner_chat (role, text, channel) VALUES ('agent', $1, 'notify')", [full.replace(/\*\*/g, '')]).catch(() => {});
      await db.log('whatsapp', `رسالة من ${who} (…${num.slice(-4)}) وصّلتها لك${ack ? ' وشكرته' : ''}`);
      ch.notifyOwner(full).catch(e => console.error('watch notify', e.message));
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
