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

const M = require('./menu');
const HELP = M.telegramMenu().text;
// يرسل الأزرار الثابتة + القائمة التفصيلية
async function sendMenu(chatId, prefix = '') {
  await ch.tgSend(chatId, (prefix ? prefix + '\n\n' : '') + '⌨️ **الأزرار السريعة جاهزة تحت الكيبورد** 👇', { keyboard: M.TG_KEYBOARD });
  const mn = M.telegramMenu();
  return ch.tgSend(chatId, mn.text, { buttons: mn.buttons });
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const m = u.message;
  if (!m || !m.chat) return;
  const chatId = String(m.chat.id);
  const ownerId = await ch.ownerTelegramId();
  let text = (m.text || m.caption || '').trim();

  // ربط الحساب
  if (/^\/start\b/.test(text)) {
    const code = text.split(/\s+/)[1];
    const s = await db.getSettings();
    if (code && s.telegram.pair_code && code.toUpperCase() === s.telegram.pair_code && !C.TELEGRAM_OWNER_ID) {
      await db.setSetting('telegram', { ...s.telegram, owner_id: chatId, pair_code: '' });
      await db.log('telegram', 'ربط حساب المالك بتيليجرام');
      if (ch.evoEnabled() && C.OWNER_PHONE) ch.sendWhatsApp(C.OWNER_PHONE, '✅ تيليجرام انربط. التنبيهات والموافقات بتوصلك هناك، وتقدر تكلمني من واتساب أو تيليجرام — نفس السكرتير ونفس الذاكرة 🤝').catch(() => {});
      return sendMenu(chatId, '✅ **تم ربط حسابك. أنا جاهز!**');
    }
    if (code) {
      const mem = await db.one('SELECT * FROM members WHERE upper(link_code)=upper($1) AND active', [code]);
      if (mem) {
        await db.q('UPDATE members SET telegram_id=$2, link_code=NULL WHERE id=$1', [mem.id, chatId]);
        await ch.notifyOwner(`🔗 ${mem.name} ربط تيليجرام وبيستلم مهامه هنا`);
        return ch.tgSend(chatId, `أهلاً ${mem.name} 👋 بتوصلك مهامك هنا، واضغط الأزرار لتحديث حالتها.`);
      }
    }
    if (chatId === ownerId) return sendMenu(chatId, '👋 أهلاً فيك');
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

  // المالك: جواب لسؤال مفتوح من وكيل المواقع (رمز تحقق، اختيار موعد...)
  if (text && require('./web').answer(text)) return ch.tgSend(chatId, '👍 وصلني، أكمل…');
  // المالك: أوامر سريعة
  const qcmd = M.matchQuick(text);
  if (qcmd === 'menu') return sendMenu(chatId);
  if (qcmd) {
    ch.tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    try { return await ch.tgSend(chatId, await quick[qcmd]()); } catch (e) { return ch.tgSend(chatId, '⚠️ ' + e.message.slice(0, 200)); }
  }
  let m2;
  if ((m2 = text.match(/^(?:موافق|وافق)\s+#?(\d+)$/))) return ch.tgSend(chatId, await decide(m2[1], true));
  if ((m2 = text.match(/^رفض\s+#?(\d+)$/))) return ch.tgSend(chatId, await decide(m2[1], false));
  if ((m2 = text.match(/^عدل\s+#?(\d+)\s+([\s\S]+)/))) return ch.tgSend(chatId, await decide(m2[1], true, m2[2]));

  const payReply = await require('./pay').handleOwnerText(text).catch(e => '⚠️ ' + e.message);
  if (payReply) return ch.tgSend(chatId, payReply);

  if ((m.voice || m.audio || m.video_note) && !text) {
    const media = m.voice || m.audio || m.video_note;
    ch.tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const keep = setInterval(() => ch.tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 5000);
    try {
      if (media.file_size > 20e6) throw new Error('طويلة جداً');
      const f = await downloadFile(media.file_id);
      text = await require('./voice').transcribe(f.data, media.mime_type || (m.video_note ? 'video/mp4' : 'audio/ogg'));
    } catch (e) { db.log('voice', '🎙️ فشل فهم الصوت: ' + e.message.slice(0, 120)).catch(() => {}); return ch.tgSend(chatId, '🎙️ ما قدرت أفهم الرسالة الصوتية (' + e.message.slice(0, 80) + '). اكتبها لي أو جرب مرة ثانية.'); }
    finally { clearInterval(keep); }
    if (require('./web').answer(text)) return ch.tgSend(chatId, `🎙️ «${text}» — 👍 وصلني، أكمل…`);
    await ch.tgSend(chatId, `🎙️ سمعتك: «${text}»`);
    const q2 = M.matchQuick(text);
    if (q2 === 'menu') return sendMenu(chatId);
    if (q2) return ch.tgSend(chatId, await quick[q2]());
    const pr = await require('./pay').handleOwnerText(text).catch(() => null);
    if (pr) return ch.tgSend(chatId, pr);
  }

  // مرفقات: صور وPDF (يقرأها مباشرة) وأي ملف ثاني (Excel/Word/CSV...) للتحليل
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
      } else {
        // Excel / Word / PowerPoint / CSV / نص... ← نرفعه لحاوية التحليل
        if (m.document.file_size > 19e6) return ch.tgSend(chatId, 'الملف كبير جداً (الحد 19MB)');
        ch.tg('sendChatAction', { chat_id: chatId, action: 'upload_document' }).catch(() => {});
        const f = await downloadFile(m.document.file_id);
        const name = m.document.file_name || 'file';
        const fid = await require('./power').ownerUpload(Buffer.from(f.data, 'base64'), name, mime);
        text = `${text || 'حلل هذا الملف وعطني أهم ما فيه'}\n\n[ملف مرفق من المالك: ${name} — file_id: ${fid}] (فوّض لوكيل الملفات والتحليل builder مع file_ids)`;
      }
    }
  } catch (e) { return ch.tgSend(chatId, '⚠️ ' + e.message); }

  if (!text && !attachments.length) return;
  // الصور: نجمع الألبوم (والطلب اللي بعده) في طلب واحد
  const MD = require('./media');
  const img = attachments.find(a => a.type === 'image');
  if (MD.collect('tg:' + chatId, { image: img || null, text: img ? text : (attachments.length ? '' : text) }, (imgs, txt) =>
    MD.prepareImages(imgs, txt).then(p => runOwnerTg(chatId, p.text, p.attachments)).catch(e => ch.tgSend(chatId, '⚠️ ' + e.message.slice(0, 150))))) {
    ch.tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    return;
  }
  return runOwnerTg(chatId, text, attachments);
}

async function runOwnerTg(chatId, text, attachments) {
  // تشغيل المدير مع مؤشر "يكتب"
  const typing = setInterval(() => ch.tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 4500);
  ch.tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const reply = await require('./health').runOrQueue({ channel: 'telegram', text, attachments }, () => A().runManager(text, { attachments, channel: 'telegram', progress: (p) => ch.tgSend(chatId, p) }));
    await ch.tgSend(chatId, reply);
  } catch (e) {
    console.error('manager', e);
    await ch.tgSend(chatId, require('./llm').friendlyError(e));
  } finally { clearInterval(typing); }
}

async function handleCallback(cq) {
  const chatId = String(cq.message && cq.message.chat.id);
  const ownerId = await ch.ownerTelegramId();
  const [kind, id, action] = String(cq.data || '').split(':');
  if (kind === 'fu') {
    await ch.tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    if (chatId !== ownerId) return;
    await ch.tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return ch.tgSend(chatId, action === 'send' ? await require('./extras').sendFollowup(id).catch(e => '⚠️ ' + e.message) : '👍 تمام، ما راح أذكره.');
  }
  if (kind === 'pay') {
    await ch.tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    if (chatId !== ownerId) return;
    await ch.tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const P = require('./pay');
    return ch.tgSend(chatId, action === 'paid' ? await P.markPaid(id) : await P.cancel(id));
  }
  if (kind === 'mn') { // قائمة الأقسام: نعرض القسم بدون ما نشيل الأزرار
    await ch.tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    if (chatId !== ownerId) return;
    if (id === 'home') { const mn = M.telegramMenu(); return ch.tgSend(chatId, mn.text, { buttons: mn.buttons }); }
    return ch.tgSend(chatId, M.sectionText(id) || 'قسم غير موجود', { buttons: [[{ text: '⬅️ رجوع للقائمة', callback_data: 'mn:home' }]] });
  }
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
