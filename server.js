// نظام فريق الوكلاء - المرحلة الأولى
// وكيل المراسلات + مدير الفريق + وكيل التقارير + لوحة التحكم
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  PORT = 3000,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-5-5',
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  APP_SECRET,
  OWNER_PHONE = '',
  DASHBOARD_PASSWORD,
  BUSINESS_INFO = '',
  GRAPH_VERSION = 'v23.0',
  DATA_DIR = './data',
  REPORT_HOUR = '21'
} = process.env;

const OWNER = OWNER_PHONE.replace(/\D/g, '');

// ---------- التخزين ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');
let db = { conversations: {}, pending: [], log: [], nextId: 1, lastReportDay: '', appointments: [], nextApptId: 1, settings: {}, ownerChat: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch (_) {}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const now = () => new Date().toISOString();
const riyadhDay = (d = new Date()) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
const riyadhNow = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const fmtRiyadh = iso => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const businessInfo = () => (db.settings.businessInfo || BUSINESS_INFO || '(لم تُضف معلومات بعد)');
function addLog(type, text) {
  db.log.push({ type, text, at: now() });
  if (db.log.length > 2000) db.log = db.log.slice(-2000);
}
function addMsg(phone, name, role, text) {
  const c = db.conversations[phone] || (db.conversations[phone] = { name: name || phone, messages: [] });
  if (name) c.name = name;
  c.messages.push({ role, text, at: now() });
  if (c.messages.length > 100) c.messages = c.messages.slice(-100);
}

// ---------- Claude ----------
async function askClaude(system, messages, maxTokens = 800) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Claude: ' + JSON.stringify(data));
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// ---------- واتساب ----------
async function sendWhatsApp(to, body) {
  if (String(to).startsWith('test')) return; // محادثة تجريبية من لوحة التحكم
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  });
  if (!res.ok) throw new Error('WhatsApp: ' + (await res.text()));
}
async function notifyOwner(text) {
  if (!OWNER) return;
  try { await sendWhatsApp(OWNER, text); } catch (e) { console.error('notifyOwner', e.message); }
}

// ---------- وكيل المراسلات ----------
const messagingPrompt = () => `أنت "وكيل المراسلات" لنشاط تجاري، ترد على العملاء في واتساب.
معلومات النشاط (المصدر الوحيد للمعلومات):
${businessInfo()}

القواعد:
- رد بلهجة سعودية مهذبة ومختصرة (سطرين إلى أربعة).
- لا تخترع أسعاراً أو مواعيد أو خصومات أو معلومات غير موجودة أعلاه.
- الاستفسارات العامة والترحيب: رد مباشرة (needs_approval=false).
- طلب سعر، أو حجز/موعد، أو شكوى، أو أي شيء غير مذكور في المعلومات: needs_approval=true، واكتب مسودة رد مقترحة يراجعها صاحب النشاط.
أرجع JSON فقط بهذا الشكل بدون أي نص آخر:
{"reply":"نص الرد","needs_approval":true,"category":"استفسار|سعر|موعد|شكوى|أخرى","reason":"سبب مختصر"}`;

async function handleCustomer(phone, name, text) {
  addMsg(phone, name, 'customer', text);
  addLog('in', `${name || phone}: ${text}`);
  const history = db.conversations[phone].messages.slice(-12).map(m => ({
    role: m.role === 'customer' ? 'user' : 'assistant',
    content: m.text
  }));
  // دمج الرسائل المتتالية من نفس الطرف
  const merged = [];
  for (const m of history) {
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += '\n' + m.content;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();

  let result;
  try {
    result = parseJson(await askClaude(messagingPrompt(), merged));
  } catch (e) {
    console.error(e.message);
  }
  if (!result || !result.reply) {
    result = { reply: '', needs_approval: true, category: 'أخرى', reason: 'تعذر توليد رد تلقائي' };
  }

  if (!result.needs_approval) {
    await sendWhatsApp(phone, result.reply);
    addMsg(phone, name, 'agent', result.reply);
    addLog('auto', `رد تلقائي على ${name || phone}`);
  } else {
    const item = {
      id: db.nextId++, phone, name: name || phone, customerText: text,
      draft: result.reply, category: result.category, reason: result.reason, at: now()
    };
    db.pending.push(item);
    addLog('pending', `طلب موافقة #${item.id} (${item.category}) من ${item.name}`);
    await notifyOwner(
      `🟡 طلب موافقة #${item.id} — ${item.category}\nمن: ${item.name}\nرسالته: ${text}\n\nالمسودة:\n${item.draft || '(بدون مسودة)'}\n\nرد بـ:\nموافق ${item.id}\nرفض ${item.id}\nعدل ${item.id} النص الجديد`
    );
  }
  save();
}

// ---------- الموافقات ----------
async function approve(id, editedText) {
  const i = db.pending.findIndex(p => p.id === Number(id));
  if (i < 0) return 'ما لقيت طلب بهذا الرقم';
  const p = db.pending[i];
  const text = (editedText || p.draft || '').trim();
  if (!text) return 'المسودة فاضية، استخدم: عدل ' + id + ' النص';
  await sendWhatsApp(p.phone, text);
  addMsg(p.phone, p.name, 'agent', text);
  db.pending.splice(i, 1);
  addLog('approved', `تمت الموافقة على #${id}`);
  save();
  return `✅ انرسل الرد لـ ${p.name}`;
}
function reject(id) {
  const i = db.pending.findIndex(p => p.id === Number(id));
  if (i < 0) return 'ما لقيت طلب بهذا الرقم';
  db.pending.splice(i, 1);
  addLog('rejected', `رُفض #${id}`);
  save();
  return `❌ رفضت #${id}، ما انرسل شي`;
}

// ---------- وكيل التقارير ----------
async function makeReport() {
  const today = riyadhDay();
  const todays = db.log.filter(l => riyadhDay(new Date(l.at)) === today);
  const input = `سجل اليوم (${today}):\n${todays.map(l => `[${l.type}] ${l.text}`).join('\n') || 'لا يوجد نشاط'}\n\nمواعيد اليوم:\n${db.appointments.filter(a => riyadhDay(new Date(a.at)) === today).map(a => `${fmtRiyadh(a.at)} ${a.title}`).join('\n') || 'لا يوجد'}\n\nطلبات معلقة:\n${db.pending.map(p => `#${p.id} ${p.category} من ${p.name}: ${p.customerText}`).join('\n') || 'لا يوجد'}`;
  return askClaude(
    'أنت "وكيل التقارير". اكتب تقريراً يومياً مختصراً بالعربي لصاحب النشاط: عدد الرسائل، أهم الطلبات، المعلق اللي يحتاج قرار، وتوصية واحدة. بدون مقدمات، نقاط قصيرة.',
    [{ role: 'user', content: input }], 600
  );
}

// ---------- السكرتير (المواعيد) ----------
function addAppointment({ title, datetime, customer, notes }) {
  const at = new Date(datetime + ':00+03:00');
  if (isNaN(at)) return 'ما فهمت وقت الموعد، اكتبه مثل: موعد مع أحمد بكرة الساعة 4 العصر';
  const a = { id: db.nextApptId++, title, customer: customer || '', notes: notes || '', at: at.toISOString(), reminded: false };
  db.appointments.push(a);
  db.appointments.sort((x, y) => x.at.localeCompare(y.at));
  addLog('appt', `موعد جديد #${a.id}: ${title} (${fmtRiyadh(a.at)})`);
  save();
  return `📅 انحجز موعد #${a.id}: ${title}\nالوقت: ${fmtRiyadh(a.at)}`;
}
function listAppointments() {
  const up = db.appointments.filter(a => new Date(a.at) > Date.now() - 3600e3);
  return up.length ? '📅 المواعيد القادمة:\n' + up.map(a => `#${a.id} ${fmtRiyadh(a.at)} — ${a.title}`).join('\n') : 'ما فيه مواعيد قادمة';
}
function cancelAppointment(id) {
  const i = db.appointments.findIndex(a => a.id === Number(id));
  if (i < 0) return 'ما لقيت موعد بهذا الرقم';
  const [a] = db.appointments.splice(i, 1);
  addLog('appt', `إلغاء موعد #${a.id}`);
  save();
  return `🗑️ انلغى موعد #${a.id}: ${a.title}`;
}

// ---------- وكيل التنفيذ ----------
async function execute(task) {
  addLog('exec', `مهمة تنفيذ: ${task.slice(0, 80)}`);
  return askClaude(
    `أنت "وكيل التنفيذ" لنشاط تجاري. تجهّز المطلوب كاملاً وجاهزاً للاستخدام: عروض أسعار، رسائل للعملاء، منشورات، نصوص مواقع، ردود رسمية، قوائم مهام.
معلومات النشاط:
${businessInfo()}
لا تخترع أسعاراً أو أرقاماً غير معطاة؛ ضع [ ] مكان أي معلومة ناقصة. اكتب بالعربي ما لم يُطلب غير ذلك.`,
    [{ role: 'user', content: task }], 2000
  );
}

// ---------- مدير الفريق ----------
async function runOwner(text) {
  const t = text.trim();
  let m;
  if ((m = t.match(/^موافق\s+(\d+)/))) return approve(m[1]);
  if ((m = t.match(/^رفض\s+(\d+)/))) return reject(m[1]);
  if ((m = t.match(/^عدل\s+(\d+)\s+([\s\S]+)/))) return approve(m[1], m[2]);
  if (/^تقرير/.test(t)) return '📊 ' + await makeReport();
  if (/^(المعلق|طلبات)/.test(t)) {
    return db.pending.length
      ? db.pending.map(p => `#${p.id} ${p.category} — ${p.name}: ${p.customerText}`).join('\n')
      : 'ما فيه طلبات معلقة 👍';
  }
  if (/^(المواعيد|مواعيدي)/.test(t)) return listAppointments();
  if ((m = t.match(/^الغ(?:ي|اء)\s+موعد\s+(\d+)/))) return cancelAppointment(m[1]);

  const decision = parseJson(await askClaude(
    `أنت "مدير الفريق" لصاحب النشاط. تستقبل أوامره وتوزعها على الفريق:
- السكرتير: يحجز المواعيد ويعرضها ويلغيها.
- وكيل التنفيذ: يجهّز عروض أسعار، رسائل، منشورات، نصوص، ملفات نصية.
- وكيل التقارير: تقرير اليوم.
- وكيل المراسلات: يرد على العملاء، والطلبات اللي تحتاج موافقة تظهر برقم (موافق رقم / رفض رقم / عدل رقم النص).
الوقت الحالي بتوقيت الرياض: ${riyadhNow()}
طلبات معلقة: ${db.pending.length} | مواعيد قادمة: ${db.appointments.filter(a => new Date(a.at) > Date.now()).length}
أرجع JSON فقط بأحد الأشكال:
{"action":"add_appointment","title":"عنوان مختصر","datetime":"YYYY-MM-DDTHH:mm","customer":"اسم أو رقم إن وجد","notes":""}
{"action":"list_appointments"}
{"action":"cancel_appointment","id":3}
{"action":"report"}
{"action":"execute","task":"وصف المهمة كاملاً"}
{"action":"reply","text":"ردك المختصر بالعربي"}
لا تدّعي تنفيذ شيء لم يُنفذ. إذا كان وقت الموعد ناقصاً استخدم reply واسأل عنه.`,
    [{ role: 'user', content: t }], 600
  ));
  if (!decision) return 'ما فهمت الطلب، جرّب تكتبه بشكل ثاني';
  switch (decision.action) {
    case 'add_appointment': return addAppointment(decision);
    case 'list_appointments': return listAppointments();
    case 'cancel_appointment': return cancelAppointment(decision.id);
    case 'report': return '📊 ' + await makeReport();
    case 'execute': return '🛠️ ' + await execute(decision.task || t);
    default: return decision.text || 'تمام';
  }
}
async function handleOwner(text) {
  try { await notifyOwner(await runOwner(text)); }
  catch (e) { console.error(e.message); await notifyOwner('صار خطأ: ' + e.message.slice(0, 200)); }
}

// ---------- السيرفر ----------
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// التحقق من Webhook (Meta)
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

const seen = new Set();
app.post('/webhook', (req, res) => {
  if (APP_SECRET) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200);
  for (const entry of req.body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile && c.profile.name]));
      for (const msg of v.messages || []) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        const text = msg.type === 'text' ? msg.text.body : `[رسالة من نوع ${msg.type}]`;
        const from = msg.from;
        const job = from === OWNER ? handleOwner(text) : handleCustomer(from, names[from], text);
        job.catch(e => console.error('handle', e.message));
      }
    }
  }
});

// حماية لوحة التحكم بكلمة سر
function auth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return res.status(500).send('حدد DASHBOARD_PASSWORD في الإعدادات');
  const [, b64 = ''] = (req.get('authorization') || '').split(' ');
  const [, pass = ''] = Buffer.from(b64, 'base64').toString().split(':');
  if (pass === DASHBOARD_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="dashboard"').status(401).send('مطلوب كلمة السر');
}
app.use((req, res, next) => (req.path.startsWith('/webhook') || ['/health','/privacy','/manifest.json','/apple-touch-icon.png','/icon-512.png'].includes(req.path) ? next() : auth(req, res, next)));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (_req, res) => {
  const today = riyadhDay();
  const todays = db.log.filter(l => riyadhDay(new Date(l.at)) === today);
  res.json({
    pending: db.pending,
    conversations: Object.entries(db.conversations)
      .map(([phone, c]) => ({ phone, name: c.name, last: c.messages[c.messages.length - 1] }))
      .sort((a, b) => (b.last?.at || '').localeCompare(a.last?.at || '')),
    stats: {
      incoming: todays.filter(l => l.type === 'in').length,
      auto: todays.filter(l => l.type === 'auto').length,
      approved: todays.filter(l => l.type === 'approved').length,
      pending: db.pending.length
    }
  });
});
app.get('/api/conversation/:phone', (req, res) => res.json(db.conversations[req.params.phone] || null));
app.post('/api/approve/:id', async (req, res) => {
  try { res.json({ message: await approve(req.params.id, req.body && req.body.text) }); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/api/reject/:id', (req, res) => res.json({ message: reject(req.params.id) }));
app.get('/api/report', async (_req, res) => {
  try { res.json({ report: await makeReport() }); }
  catch (e) { res.status(500).json({ report: 'خطأ: ' + e.message }); }
});
app.post('/api/owner', async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.json({ reply: '' });
  try {
    const reply = await runOwner(text);
    db.ownerChat.push({ role: 'owner', text, at: now() }, { role: 'agent', text: reply, at: now() });
    db.ownerChat = db.ownerChat.slice(-60); save();
    res.json({ reply });
  } catch (e) { res.status(500).json({ reply: 'خطأ: ' + e.message.slice(0, 200) }); }
});
app.get('/api/owner', (_req, res) => res.json(db.ownerChat));
app.post('/api/simulate', async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.json({});
  const phone = 'test-' + (req.body.session || 'demo');
  const before = db.pending.length;
  try {
    await handleCustomer(phone, 'عميل تجريبي', text);
    const c = db.conversations[phone];
    const last = c.messages[c.messages.length - 1];
    if (db.pending.length > before) {
      const p = db.pending[db.pending.length - 1];
      return res.json({ pending: true, id: p.id, category: p.category, draft: p.draft });
    }
    res.json({ reply: last.role === 'agent' ? last.text : '' });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});
app.get('/api/appointments', (_req, res) => res.json(db.appointments));
app.post('/api/appointments', (req, res) => res.json({ message: addAppointment(req.body || {}) }));
app.delete('/api/appointments/:id', (req, res) => res.json({ message: cancelAppointment(req.params.id) }));
app.get('/api/settings', (_req, res) => res.json({ businessInfo: db.settings.businessInfo || BUSINESS_INFO || '' }));
app.post('/api/settings', (req, res) => {
  db.settings.businessInfo = String((req.body && req.body.businessInfo) || '').slice(0, 8000);
  addLog('settings', 'تحديث معلومات النشاط'); save();
  res.json({ message: '✅ انحفظت معلومات النشاط' });
});
app.get('/health', (_req, res) => res.send('ok'));
app.get('/privacy', (_req, res) => res.type('html').send(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>سياسة الخصوصية</title><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 16px;line-height:1.8">
<h1>سياسة الخصوصية</h1>
<p>يستخدم هذا النظام رسائل واتساب التي يرسلها العملاء إلى النشاط التجاري للرد على استفساراتهم فقط.</p>
<p>نحفظ رقم المرسل واسمه ونص الرسائل لغرض خدمة العميل ومتابعة الطلبات، ولا نبيعها أو نشاركها مع أي طرف ثالث، باستثناء مزودي الخدمة اللازمين لتشغيل النظام (Meta لواتساب، وAnthropic لمعالجة النص).</p>
<p>لطلب حذف بياناتك، أرسل رسالة على نفس رقم واتساب تطلب فيها الحذف، وسيتم حذفها.</p>
<h2>Privacy Policy</h2>
<p>This system uses WhatsApp messages that customers send to the business solely to respond to their inquiries. We store the sender's number, name and message text for customer service. We do not sell or share this data with third parties other than service providers required to operate the system (Meta for WhatsApp, Anthropic for text processing). To request deletion, message the same WhatsApp number asking for deletion.</p>
</body></html>`));

// تقرير يومي تلقائي (بتوقيت الرياض)
setInterval(async () => {
  for (const a of db.appointments) {
    const diff = new Date(a.at) - Date.now();
    if (!a.reminded && diff > 0 && diff <= 60 * 60e3) {
      a.reminded = true; save();
      await notifyOwner(`⏰ تذكير: بعد أقل من ساعة\n#${a.id} ${a.title}\nالوقت: ${fmtRiyadh(a.at)}`);
    }
  }
  const riyadhHour = (new Date().getUTCHours() + 3) % 24;
  const day = riyadhDay();
  if (riyadhHour === Number(REPORT_HOUR) && db.lastReportDay !== day) {
    db.lastReportDay = day; save();
    try { await notifyOwner('📊 تقرير اليوم\n' + await makeReport()); } catch (e) { console.error(e.message); }
  }
}, 60 * 1000);

const missing = ['ANTHROPIC_API_KEY', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'OWNER_PHONE', 'DASHBOARD_PASSWORD']
  .filter(k => !process.env[k]);
if (missing.length) console.warn('⚠️ إعدادات ناقصة:', missing.join(', '));
app.listen(PORT, () => console.log('النظام شغال على المنفذ', PORT));
