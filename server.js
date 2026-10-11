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
let db = { conversations: {}, pending: [], log: [], nextId: 1, lastReportDay: '' };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch (_) {}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const now = () => new Date().toISOString();
const riyadhDay = (d = new Date()) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
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
const MESSAGING_PROMPT = `أنت "وكيل المراسلات" لنشاط تجاري، ترد على العملاء في واتساب.
معلومات النشاط (المصدر الوحيد للمعلومات):
${BUSINESS_INFO || '(لم تُضف معلومات بعد)'}

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
    result = parseJson(await askClaude(MESSAGING_PROMPT, merged));
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
  const input = `سجل اليوم (${today}):\n${todays.map(l => `[${l.type}] ${l.text}`).join('\n') || 'لا يوجد نشاط'}\n\nطلبات معلقة:\n${db.pending.map(p => `#${p.id} ${p.category} من ${p.name}: ${p.customerText}`).join('\n') || 'لا يوجد'}`;
  return askClaude(
    'أنت "وكيل التقارير". اكتب تقريراً يومياً مختصراً بالعربي لصاحب النشاط: عدد الرسائل، أهم الطلبات، المعلق اللي يحتاج قرار، وتوصية واحدة. بدون مقدمات، نقاط قصيرة.',
    [{ role: 'user', content: input }], 600
  );
}

// ---------- مدير الفريق (رسائل صاحب النشاط) ----------
async function handleOwner(text) {
  const t = text.trim();
  let m;
  try {
    if ((m = t.match(/^موافق\s+(\d+)/))) return notifyOwner(await approve(m[1]));
    if ((m = t.match(/^رفض\s+(\d+)/))) return notifyOwner(reject(m[1]));
    if ((m = t.match(/^عدل\s+(\d+)\s+([\s\S]+)/))) return notifyOwner(await approve(m[1], m[2]));
    if (/^تقرير/.test(t)) return notifyOwner('📊 ' + await makeReport());
    if (/^(المعلق|طلبات)/.test(t)) {
      return notifyOwner(db.pending.length
        ? db.pending.map(p => `#${p.id} ${p.category} — ${p.name}: ${p.customerText}`).join('\n')
        : 'ما فيه طلبات معلقة 👍');
    }
    const context = `طلبات معلقة: ${db.pending.length}\nآخر النشاط:\n${db.log.slice(-15).map(l => l.text).join('\n')}`;
    const reply = await askClaude(
      `أنت "مدير الفريق" لصاحب النشاط. تشرف على وكيل المراسلات ووكيل التقارير.
الأوامر المتاحة له: "موافق رقم"، "رفض رقم"، "عدل رقم النص"، "تقرير"، "المعلق".
جاوبه باختصار بالعربي، ووجهه للأمر المناسب إذا طلب شيء ينفذ بأمر. لا تدّعي أنك نفذت شيئاً لم يُنفذ.
${context}`,
      [{ role: 'user', content: t }], 500
    );
    return notifyOwner(reply);
  } catch (e) {
    console.error(e.message);
    return notifyOwner('صار خطأ: ' + e.message.slice(0, 200));
  }
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
app.use(['/', '/api'], (req, res, next) => (req.path.startsWith('/webhook') ? next() : auth(req, res, next)));
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
app.get('/health', (_req, res) => res.send('ok'));

// تقرير يومي تلقائي (بتوقيت الرياض)
setInterval(async () => {
  const riyadhHour = (new Date().getUTCHours() + 3) % 24;
  const day = riyadhDay();
  if (riyadhHour === Number(REPORT_HOUR) && db.lastReportDay !== day) {
    db.lastReportDay = day; save();
    try { await notifyOwner('📊 تقرير اليوم\n' + await makeReport()); } catch (e) { console.error(e.message); }
  }
}, 5 * 60 * 1000);

const missing = ['ANTHROPIC_API_KEY', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'OWNER_PHONE', 'DASHBOARD_PASSWORD']
  .filter(k => !process.env[k]);
if (missing.length) console.warn('⚠️ إعدادات ناقصة:', missing.join(', '));
app.listen(PORT, () => console.log('النظام شغال على المنفذ', PORT));
