// بوت تيليجرام: قناة أوامر المالك + استلام مهام الفريق
const crypto = require('crypto');
const C = require('./config');
const db = require('./db');
const ch = require('./channels');
const U = require('./util');
const { decide } = require('./approvals');
const quick = require('./quick');

let agents; // تحميل متأخر لتفادي الاعتماد الدائري
const A = () => (agents = agents || require('./agents'));

async function ensurePairCode() {
  const s = await db.getSettings();
  if (s.telegram.pair_code) return s.telegram.pair_code;
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  await db.setSetting('telegram', { ...s.telegram, pair_code: code });
  return code;
}

async function downloadFile(fileId) {
  const f = await ch.tg('getFile', { file_id: fileId });
  const res = await fetch(`${ch.TG_BASE}/file/bot${C.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error('تعذر تحميل الملف');
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), path: f.file_path };
}

const HELP = `أنا سكرتيرك الشخصي 👋 كلمني بكلامك العادي عن أي شي، مثلاً:

📅 «عندي موعد أسنان الأحد 5 العصر في عيادة النخبة»
⏰ «ذكرني بدواء الضغط كل يوم 9 الصبح»
✈️ «أبي أسافر دبي الخميس الجاي وأرجع السبت، دور لي طيران وفندق قريب من المترو»
🛒 «ضيف للمقاضي: حليب، خبز، رز بسمتي 5 كيلو» أو «قارن لي أسعار آيفون 17 برو»
🍔 «جهز لي طلب عشا من البيك على جاهز»
💰 «صرفت 180 بنزين» أو أرسل **صورة فاتورة** أو «كم صرفت هالشهر على المطاعم؟»
🧾 «فاتورة الجوال 230 ريال تنزل يوم 5 كل شهر»
🪪 «إقامة العامل تنتهي 2027-03-10» «رخصتي تنتهي بعد 3 شهور»
🎂 «عيد ميلاد أمي 12 مارس»
✍️ «اكتب لي خطاب اعتذار رسمي للمدير عن الغياب»
🎯 «أبي أقرأ 20 صفحة يومياً» — «قريت 25 صفحة»
🔎 «وش أفضل تأمين سيارة شامل في السعودية؟»
📧 «وش آخر إيميلاتي المهمة؟ رد على إيميل البنك»

أوامر سريعة: /today /tasks /money /shop /bills /approvals`;

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const m = u.message;
  if (!m || !m.chat) return;
  const chatId = String(m.chat.id);
  const ownerId = await ch.ownerTelegramId();
  const text = (m.text || m.caption || '').trim();

  // ربط الحساب
  if (/^\/start\b/.test(text)) {
    const code = text.split(/\s+/)[1];
    const s = await db.getSettings();
    if (code && s.telegram.pair_code && code.toUpperCase() === s.telegram.pair_code && !C.TELEGRAM_OWNER_ID) {
      await db.setSetting('telegram', { ...s.telegram, owner_id: chatId, pair_code: '' });
      await db.log('telegram', 'ربط حساب المالك بتيليجرام');
      if (ch.evoEnabled() && C.OWNER_PHONE) ch.sendWhatsApp(C.OWNER_PHONE, '✅ تيليجرام انربط. التنبيهات والموافقات بتوصلك هناك، وتقدر تكلمني من واتساب أو تيليجرام — نفس السكرتير ونفس الذاكرة 🤝').catch(() => {});
      return ch.tgSend(chatId, '✅ تم ربط حسابك. أنا جاهز!\n\n' + HELP);
    }
    if (code) {
      const mem = await db.one('SELECT * FROM members WHERE upper(link_code)=upper($1) AND active', [code]);
      if (mem) {
        await db.q('UPDATE members SET telegram_id=$2, link_code=NULL WHERE id=$1', [mem.id, chatId]);
        await ch.notifyOwner(`🔗 ${mem.name} ربط تيليجرام وبيستلم مهامه هنا`);
        return ch.tgSend(chatId, `أهلاً ${mem.name} 👋 بتوصلك مهامك هنا، واضغط الأزرار لتحديث حالتها.`);
      }
    }
    if (chatId === ownerId) return ch.tgSend(chatId, HELP);
    return ch.tgSend(chatId, 'أرسل كود الربط: /start الكود');
  }

  // عضو فريق
  if (chatId !== ownerId) {
    const mem = await db.one('SELECT * FROM members WHERE telegram_id=$1', [chatId]);
    if (!mem) return ch.tgSend(chatId, 'هذا البوت خاص. لو أنت من الفريق اطلب كود الربط من الإدارة.');
    if (/^\/tasks/.test(text) || /مهامي/.test(text)) {
      const ts = await db.many("SELECT id, title, status, due_at FROM tasks WHERE assignee_id=$1 AND status<>'done' ORDER BY due_at NULLS LAST", [mem.id]);
      if (!ts.length) return ch.tgSend(chatId, 'ما عندك مهام مفتوحة 👍');
      for (const t of ts) await ch.tgSend(chatId, `📌 #${t.id} ${t.title}${t.due_at ? '\n⏰ ' + U.fmt(t.due_at) : ''}\nالحالة: ${t.status}`, { buttons: [[{ text: '▶️ بدأت', callback_data: `tk:${t.id}:doing` }, { text: '✅ خلصت', callback_data: `tk:${t.id}:done` }, { text: '⛔ معلقة', callback_data: `tk:${t.id}:blocked` }]] });
      return;
    }
    await ch.notifyOwner(`💬 رسالة من ${mem.name}:\n${text || '[مرفق]'}`);
    return ch.tgSend(chatId, 'وصلت رسالتك للإدارة ✅ (اكتب «مهامي» لعرض مهامك)');
  }

  // المالك: أوامر سريعة
  if (/^\/help/.test(text)) return ch.tgSend(chatId, HELP);
  const qcmd = text.match(/^\/(today|tasks|money|shop|bills|approvals)\b/);
  if (qcmd) return ch.tgSend(chatId, await quick[qcmd[1]]());
  let m2;
  if ((m2 = text.match(/^(?:موافق|وافق)\s+#?(\d+)$/))) return ch.tgSend(chatId, await decide(m2[1], true));
  if ((m2 = text.match(/^رفض\s+#?(\d+)$/))) return ch.tgSend(chatId, await decide(m2[1], false));
  if ((m2 = text.match(/^عدل\s+#?(\d+)\s+([\s\S]+)/))) return ch.tgSend(chatId, await decide(m2[1], true, m2[2]));

  if (m.voice || m.audio || m.video_note) return ch.tgSend(chatId, '🎙️ الرسائل الصوتية ما أقدر أفهمها للحين. اكتبها لي نص (أو استخدم إملاء الكيبورد في الجوال).');

  // مرفقات: صور ومستندات PDF
  const attachments = [];
  try {
    if (m.photo && m.photo.length) {
      const f = await downloadFile(m.photo[m.photo.length - 1].file_id);
      attachments.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } });
    } else if (m.document) {
      const mime = m.document.mime_type || '';
      if (mime === 'application/pdf' || /^image\/(jpeg|png|webp|gif)$/.test(mime)) {
        if (m.document.file_size > 18e6) return ch.tgSend(chatId, 'الملف كبير جداً (الحد 18MB)');
        const f = await downloadFile(m.document.file_id);
        attachments.push(mime === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
          : { type: 'image', source: { type: 'base64', media_type: mime, data: f.data } });
      } else return ch.tgSend(chatId, 'أقدر أقرأ الصور وملفات PDF فقط حالياً.');
    }
  } catch (e) { return ch.tgSend(chatId, '⚠️ ' + e.message); }

  if (!text && !attachments.length) return;
  // تشغيل المدير مع مؤشر "يكتب"
  const typing = setInterval(() => ch.tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 4500);
  ch.tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const reply = await A().runManager(text, { attachments, channel: 'telegram', progress: (p) => ch.tgSend(chatId, p) });
    await ch.tgSend(chatId, reply);
  } catch (e) {
    console.error('manager', e);
    await ch.tgSend(chatId, '⚠️ صار خطأ: ' + e.message.slice(0, 300));
  } finally { clearInterval(typing); }
}

async function handleCallback(cq) {
  const chatId = String(cq.message && cq.message.chat.id);
  const ownerId = await ch.ownerTelegramId();
  const [kind, id, action] = String(cq.data || '').split(':');
  let result = '';
  try {
    if (kind === 'ap') {
      if (chatId !== ownerId) result = 'غير مسموح';
      else result = await decide(id, action === 'yes');
    } else if (kind === 'bl') {
      if (chatId !== ownerId) result = 'غير مسموح';
      else result = await require('./tools').T.pay_bill.handler({ id: Number(id) });
    } else if (kind === 'tk') {
      const t = await db.one('SELECT t.*, m.telegram_id, m.name AS member FROM tasks t LEFT JOIN members m ON m.id=t.assignee_id WHERE t.id=$1', [Number(id)]);
      if (!t) result = 'المهمة غير موجودة';
      else if (chatId !== ownerId && chatId !== String(t.telegram_id)) result = 'غير مسموح';
      else {
        await db.q('UPDATE tasks SET status=$2, done_at=CASE WHEN $2=\'done\' THEN now() ELSE done_at END WHERE id=$1', [t.id, action]);
        const label = { doing: '▶️ قيد التنفيذ', done: '✅ منجزة', blocked: '⛔ معلقة' }[action] || action;
        result = `#${t.id} ${t.title}: ${label}`;
        await db.log('task', `${t.member || 'المالك'}: ${result}`);
        if (chatId !== ownerId && (action === 'done' || action === 'blocked')) await ch.notifyOwner(`🗂️ ${t.member}: ${result}`);
      }
    }
  } catch (e) { result = '⚠️ ' + e.message; }
  await ch.tg('answerCallbackQuery', { callback_query_id: cq.id, text: String(result).slice(0, 190) }).catch(() => {});
  if (cq.message) {
    await ch.tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await ch.tgSend(chatId, result);
  }
}

module.exports = { handleUpdate, ensurePairCode, HELP };
