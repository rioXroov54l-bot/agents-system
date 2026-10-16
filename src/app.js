// الخادم: المسارات العامة + API لوحة التحكم
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const C = require('./config');
const db = require('./db');
const ch = require('./channels');
const U = require('./util');
const docs = require('./docs');
const quick = require('./quick');
const tg = require('./telegram');
const scheduler = require('./scheduler');
const { T } = require('./tools');
const { decide } = require('./approvals');
const agents = require('./agents');

const app = express();
app.use(express.json({ limit: '25mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ================= مسارات عامة =================
app.get('/health', async (_req, res) => {
  try { await Promise.race([db.q('SELECT 1'), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]); res.send('ok'); }
  catch (e) { res.status(503).send('db down: ' + e.message); }
});

app.get('/privacy', (_req, res) => res.type('html').send(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>سياسة الخصوصية</title><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 16px;line-height:1.8">
<h1>سياسة الخصوصية</h1><p>نستخدم الرسائل التي يرسلها العملاء للرد على استفساراتهم وخدمتهم فقط. نحفظ الاسم ورقم التواصل ونص الرسائل لغرض خدمة العميل ومتابعة الطلبات، ولا نبيعها أو نشاركها مع أي طرف ثالث باستثناء مزودي الخدمة اللازمين لتشغيل النظام (Meta، Google، Anthropic). لطلب حذف بياناتك راسلنا على نفس الرقم.</p>
<h2>Privacy Policy</h2><p>We use messages customers send us solely to respond and serve them. We store name, contact number and message text for customer service. We do not sell or share data with third parties other than service providers required to operate the system (Meta, Google, Anthropic). To request deletion, message us on the same number.</p></body></html>`));

// المستندات العامة (برابط سري)
// ملفات جهزها السكرتير (Excel/PowerPoint/Word/PDF...) برابط سري
app.get('/f/:token', async (req, res) => {
  try {
    const f = await require('./power').getFile(req.params.token);
    if (!f || !f.data) return res.status(404).send('غير موجود');
    res.set('X-Robots-Tag', 'noindex').set('Content-Type', f.mime || 'application/octet-stream')
      .set('Content-Disposition', `${/^image\/|pdf/.test(f.mime || '') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`).send(f.data);
  } catch (e) { res.status(500).send('خطأ'); }
});
// مستندات وتقارير السكرتير (رابط سري)
app.get('/r/:token', async (req, res) => {
  try {
    const html = await require('./reports').render(req.params.token, { print: req.query.print === '1' });
    if (!html) return res.status(404).send('غير موجود');
    res.set('X-Robots-Tag', 'noindex').type('html').send(html);
  } catch (e) { res.status(500).send('خطأ'); }
});
app.get('/d/:type/:id/:token', async (req, res) => {
  const table = { q: 'quotes', i: 'invoices' }[req.params.type];
  if (!table) return res.sendStatus(404);
  const doc = await db.one(`SELECT * FROM ${table} WHERE id=$1`, [Number(req.params.id)]).catch(() => null);
  if (!doc || !doc.token || doc.token.length !== req.params.token.length || !crypto.timingSafeEqual(Buffer.from(doc.token), Buffer.from(req.params.token))) return res.status(404).send('المستند غير موجود');
  const cust = doc.customer_id ? await db.one('SELECT * FROM customers WHERE id=$1', [doc.customer_id]) : null;
  res.type('html').send(docs.render(req.params.type, doc, cust, await db.getSettings()));
});

// ---------- واتساب ----------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === C.VERIFY_TOKEN) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});
const seen = new Set();
app.post('/webhook', (req, res) => {
  if (C.APP_SECRET) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', C.APP_SECRET).update(req.rawBody || '').digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
  }
  res.sendStatus(200);
  for (const entry of req.body.entry || []) for (const change of entry.changes || []) {
    const v = change.value || {};
    const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile && c.profile.name]));
    for (const msg of v.messages || []) {
      if (seen.has(msg.id)) continue; seen.add(msg.id); if (seen.size > 5000) seen.clear();
      const text = msg.type === 'text' ? msg.text.body : `[رسالة من نوع ${msg.type}]`;
      const job = msg.from === C.OWNER_PHONE
        ? agents.runManager(text, { channel: 'whatsapp' }).then(r => ch.sendWhatsApp(C.OWNER_PHONE, r.replace(/\*\*/g, '*')))
        : db.getSettings().then(s => s.reply_others ? agents.handleCustomerMessage(msg.from, names[msg.from], text) : null);
      job.catch(e => console.error('wa handle', e.message));
    }
  }
});

// ---------- تيليجرام ----------
app.post('/telegram/:secret', (req, res) => {
  if (!ch.tgEnabled() || req.params.secret !== ch.tgSecret() || req.get('x-telegram-bot-api-secret-token') !== ch.tgSecret()) return res.sendStatus(401);
  res.sendStatus(200);
  tg.handleUpdate(req.body).catch(e => console.error('telegram', e));
});

// ---------- واتساب عبر Evolution ----------
app.post('/evolution/:secret', (req, res) => {
  if (!ch.evoEnabled() || req.params.secret !== ch.evoSecret()) return res.sendStatus(401);
  res.sendStatus(200);
  require('./whatsapp').handleEvolution(req.body || {}).catch(e => console.error('evolution', e));
});

// ---------- n8n ----------
app.post('/api/n8n/event', async (req, res) => {
  const got = Buffer.from(req.get('x-agents-secret') || ''), want = Buffer.from(C.N8N_SECRET || '');
  if (!C.N8N_SECRET || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.sendStatus(401);
  const { type, data = {} } = req.body || {};
  try {
    if (type === 'email.received') { res.json({ ok: true }); agents.handleIncomingEmail(data).catch(e => console.error('email', e.message)); }
    else if (type === 'calendar.event') {
      if (data.id && data.start && !(await db.one('SELECT id FROM appointments WHERE gcal_id=$1', [data.id]))) {
        await db.insert('appointments', { title: String(data.title || 'موعد').slice(0, 200), at: new Date(data.start).toISOString(), notes: 'من تقويم Google', gcal_id: data.id }, ['title', 'at', 'notes', 'gcal_id']);
        await db.log('appt', `موعد من تقويم Google: ${data.title}`);
      }
      res.json({ ok: true });
    } else res.status(400).json({ error: 'نوع غير معروف' });
    await db.setSetting('n8n_status', { ok: true, lastEvent: new Date().toISOString() });
  } catch (e) { console.error('n8n event', e.message); if (!res.headersSent) res.status(500).json({ error: e.message.slice(0, 200) }); }
});

// ---------- اختصارات الآيفون (سيري + رسائل البنك) ----------
async function shortcutToken() {
  const s = await db.getSettings();
  if (s.shortcut_token) return s.shortcut_token;
  const t = crypto.randomBytes(18).toString('hex');
  await db.setSetting('shortcut_token', t);
  return t;
}
app.post('/hook/:token', async (req, res) => {
  const want = Buffer.from(await shortcutToken()), got = Buffer.from(String(req.params.token));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.sendStatus(401);
  const b = req.body || {};
  try {
    if (b.sms || b.bank) {
      const r = await require('./personal').recordBankMessage(String(b.sms || b.bank), String(b.sender || ''));
      return res.type('text/plain; charset=utf-8').send(r.recorded ? 'سجلت العملية' : 'تم');
    }
    const text = String(b.text || b.q || '').trim();
    if (!text) return res.type('text/plain; charset=utf-8').send('ما وصلني شي');
    const reply = await agents.runManager(text, { channel: 'siri' });
    res.type('text/plain; charset=utf-8').send(reply.replace(/\*\*/g, '').replace(/https?:\/\/\S+/g, 'الرابط بتيليجرام'));
    if (/https?:\/\//.test(reply)) ch.notifyOwner(reply).catch(() => {});
  } catch (e) { res.status(500).type('text/plain; charset=utf-8').send('صار خطأ: ' + e.message.slice(0, 200)); }
});

// ---------- جسر جوال المالك (الماك ← السيرفر) — محمي برمز الجسر ----------
require('./phone').mount(app);

// ================= لوحة التحكم (بكلمة سر) =================
function auth(req, res, next) {
  if (!C.DASHBOARD_PASSWORD) return res.status(500).send('حدد DASHBOARD_PASSWORD في الإعدادات');
  const [, b64 = ''] = (req.get('authorization') || '').split(' ');
  const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(C.DASHBOARD_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="dashboard"').status(401).send('مطلوب كلمة السر');
}
const PUBLIC = ['/manifest.json', '/apple-touch-icon.png', '/icon-512.png'];
app.use((req, res, next) => PUBLIC.includes(req.path) ? next() : auth(req, res, next));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e); res.status(500).json({ error: e.message }); });

// نظرة عامة
app.get('/api/overview', wrap(async (_req, res) => {
  const s = await db.getSettings();
  const P = T;
  const money = await P.money_report.handler({});
  const today = U.parseLocal(U.riyadhDay() + 'T00:00');
  const counts = Object.fromEntries((await db.many('SELECT agent, count(*) AS n FROM runs WHERE started_at >= $1 GROUP BY agent', [today])).map(r => [r.agent, Number(r.n)]));
  const last = Object.fromEntries((await db.many('SELECT agent, max(started_at) AS at FROM runs GROUP BY agent')).map(r => [r.agent, r.at]));
  const team = [{ key: 'manager', name: 'المدير الشخصي', icon: '🧠', role: 'يستقبل أي طلب، يفكر فيه من كل الجهات، ويوزعه على الفريق' },
    ...Object.entries(agents.AGENTS).map(([key, a]) => ({ key, name: a.name, icon: a.icon, role: a.role.split('\n')[0].replace(/^أنت /, '') }))]
    .map(a => ({ ...a, runs_today: counts[a.key] || 0, last: last[a.key] || null }));
  const n = async (sql, p = []) => Number((await db.one(sql, p)).n);
  res.json({
    kpi: {
      spent: money.spent, income: money.income, net: money.net, commitments: money.monthly_commitments,
      open_tasks: await n("SELECT count(*) AS n FROM tasks WHERE status<>'done'"),
      overdue_tasks: await n("SELECT count(*) AS n FROM tasks WHERE status<>'done' AND due_at < now()"),
      bills_soon: (await P.list_bills.handler({ due_within_days: 7 })).bills.length,
      docs_expiring: (await P.list_documents.handler({})).filter(d => d.days_left !== null && d.days_left <= 60).length,
      occasions_soon: (await P.upcoming_occasions.handler({ days: 14 })).length,
      shopping: await n('SELECT count(*) AS n FROM shopping WHERE NOT done'),
      pending_approvals: await n("SELECT count(*) AS n FROM approvals WHERE status='pending'"),
      appointments_today: await n("SELECT count(*) AS n FROM appointments WHERE at >= $1 AND at < $1::timestamptz + interval '1 day'", [today])
    },
    money, team,
    activity: await db.many('SELECT type, agent, text, at FROM activity ORDER BY id DESC LIMIT 30'),
    status: {
      telegram: { enabled: ch.tgEnabled(), bot: (await db.getSettings()).tg_bot || null, linked: !!(await ch.ownerTelegramId()), pair_code: ch.tgEnabled() && !(await ch.ownerTelegramId()) ? await tg.ensurePairCode() : null },
      n8n: { enabled: ch.n8nReady(), ...(s.n8n_status || {}) },
      whatsapp: await ch.evoStatus(),
      shortcut_url: `${C.PUBLIC_URL}/hook/${await shortcutToken()}`,
      profile_set: !!(s.profile && s.profile.name)
    }
  });
}));

// المدير
app.get('/api/owner', wrap(async (_req, res) => res.json((await db.many('SELECT role, text, channel, at FROM owner_chat ORDER BY id DESC LIMIT 60')).reverse())));
app.post('/api/owner', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  const attachments = [];
  if (req.body.file && req.body.file.data) {
    const mt = req.body.file.type || '';
    if (mt === 'application/pdf') attachments.push({ type: 'document', source: { type: 'base64', media_type: mt, data: req.body.file.data } });
    else if (/^image\/(jpeg|png|webp|gif)$/.test(mt)) attachments.push({ type: 'image', source: { type: 'base64', media_type: mt, data: req.body.file.data } });
  }
  if (!text && !attachments.length) return res.json({ reply: '' });
  res.json({ reply: await agents.runManager(text, { attachments, channel: 'dashboard' }) });
}));
app.post('/api/agent/:key', wrap(async (req, res) => res.json({ reply: await agents.runSpecialist(req.params.key, String(req.body.task || ''), { byOwner: true }) })));

// CRUD عام
const ENT = {
  customers: { cols: ['name', 'company', 'phone', 'email', 'city', 'source', 'status', 'notes'], list: `SELECT c.*, (SELECT count(*) FROM deals d WHERE d.customer_id=c.id AND d.stage NOT IN ('won','lost')) AS open_deals FROM customers c WHERE ($1::text IS NULL OR c.name ILIKE $1 OR c.company ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1) ORDER BY c.updated_at DESC LIMIT 300` },
  products: { cols: ['name', 'sku', 'unit', 'price', 'cost', 'description', 'active'], list: 'SELECT * FROM products WHERE ($1::text IS NULL OR name ILIKE $1 OR sku ILIKE $1) ORDER BY active DESC, name LIMIT 500' },
  deals: { cols: ['customer_id', 'title', 'stage', 'value', 'probability', 'next_action', 'next_action_at', 'notes'], dt: ['next_action_at'], list: "SELECT d.*, c.name AS customer FROM deals d LEFT JOIN customers c ON c.id=d.customer_id WHERE ($1::text IS NULL OR d.title ILIKE $1 OR c.name ILIKE $1) ORDER BY (d.stage IN ('won','lost')), d.updated_at DESC LIMIT 300" },
  members: { cols: ['name', 'role', 'phone', 'email', 'active'], list: 'SELECT id, name, role, phone, email, active, link_code, (telegram_id IS NOT NULL) AS on_telegram FROM members WHERE ($1::text IS NULL OR name ILIKE $1) ORDER BY active DESC, name' },
  tasks: { cols: ['title', 'details', 'assignee_id', 'priority', 'status', 'due_at'], dt: ['due_at'], list: "SELECT t.*, m.name AS assignee FROM tasks t LEFT JOIN members m ON m.id=t.assignee_id WHERE ($1::text IS NULL OR t.title ILIKE $1) ORDER BY (t.status='done'), (t.priority='urgent') DESC, (t.priority='high') DESC, t.due_at NULLS LAST LIMIT 300" },
  expenses: { cols: ['category', 'vendor', 'amount', 'vat', 'date', 'note', 'payment_method'], list: 'SELECT * FROM expenses WHERE ($1::text IS NULL OR category ILIKE $1 OR vendor ILIKE $1) ORDER BY date DESC, id DESC LIMIT 300' },
  appointments: { cols: ['title', 'at', 'end_at', 'location', 'notes'], dt: ['at', 'end_at'], list: "SELECT * FROM appointments WHERE ($1::text IS NULL OR title ILIKE $1) AND at > now() - interval '30 days' ORDER BY at LIMIT 200" },
  reminders: { cols: ['text', 'at', 'done'], dt: ['at'], list: 'SELECT * FROM reminders WHERE ($1::text IS NULL OR text ILIKE $1) ORDER BY done, at LIMIT 200' },
  content: { cols: ['type', 'platform', 'title', 'body', 'status', 'scheduled_at'], dt: ['scheduled_at'], list: 'SELECT * FROM content WHERE ($1::text IS NULL OR title ILIKE $1 OR body ILIKE $1) ORDER BY id DESC LIMIT 200' },
  knowledge: { cols: ['kind', 'text'], list: 'SELECT * FROM knowledge WHERE ($1::text IS NULL OR text ILIKE $1) ORDER BY id DESC LIMIT 300' },
  trips: { cols: ['title', 'origin', 'destination', 'status', 'notes'], list: 'SELECT * FROM trips ORDER BY depart_at DESC NULLS LAST LIMIT 100' },
  research: { cols: ['topic', 'summary'], list: 'SELECT * FROM research WHERE ($1::text IS NULL OR topic ILIKE $1) ORDER BY id DESC LIMIT 100' },
  emails: { cols: ['handled'], list: 'SELECT * FROM emails WHERE ($1::text IS NULL OR subject ILIKE $1 OR from_addr ILIKE $1) ORDER BY at DESC LIMIT 100' },
  quotes: { cols: ['status', 'notes'], list: "SELECT q.*, c.name AS customer FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE ($1::text IS NULL OR q.number ILIKE $1 OR c.name ILIKE $1) ORDER BY q.id DESC LIMIT 200" },
  invoices: { cols: ['status', 'notes', 'due_date'], list: "SELECT i.*, c.name AS customer FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE ($1::text IS NULL OR i.number ILIKE $1 OR c.name ILIKE $1) ORDER BY i.id DESC LIMIT 200" },
  contacts: { table: 'customers', cols: ['name', 'relation', 'company', 'phone', 'email', 'city', 'notes'], list: 'SELECT id, name, relation, company, phone, email, city, notes FROM customers WHERE ($1::text IS NULL OR name ILIKE $1 OR relation ILIKE $1 OR phone ILIKE $1 OR notes ILIKE $1) ORDER BY name LIMIT 500' },
  bills: { cols: ['name', 'amount', 'cycle', 'next_due', 'category', 'autopay', 'notes', 'active'], list: 'SELECT * FROM bills WHERE ($1::text IS NULL OR name ILIKE $1) ORDER BY active DESC, next_due NULLS LAST' },
  documents: { cols: ['name', 'holder', 'expires_on', 'notes'], list: 'SELECT * FROM documents WHERE ($1::text IS NULL OR name ILIKE $1 OR holder ILIKE $1) ORDER BY expires_on NULLS LAST' },
  occasions: { cols: ['person', 'type', 'month', 'day', 'year', 'notes'], list: 'SELECT * FROM occasions WHERE ($1::text IS NULL OR person ILIKE $1) ORDER BY month, day' },
  goals: { cols: ['title', 'why', 'target', 'unit', 'period', 'deadline', 'status'], list: "SELECT g.*, (SELECT coalesce(sum(amount),0) FROM goal_logs l WHERE l.goal_id=g.id) AS total_logged FROM goals g WHERE ($1::text IS NULL OR title ILIKE $1) ORDER BY (status='done'), id DESC" },
  shopping: { cols: ['item', 'qty', 'store', 'category', 'done'], list: 'SELECT * FROM shopping WHERE ($1::text IS NULL OR item ILIKE $1) ORDER BY done, category, id' },
  notes: { cols: ['title', 'body'], list: 'SELECT * FROM notes WHERE ($1::text IS NULL OR title ILIKE $1 OR body ILIKE $1) ORDER BY updated_at DESC LIMIT 300' },
  income: { cols: ['source', 'amount', 'date', 'note'], list: 'SELECT * FROM income WHERE ($1::text IS NULL OR source ILIKE $1) ORDER BY date DESC, id DESC LIMIT 300' },
  runs: { cols: [], list: 'SELECT id, agent, left(input, 300) AS input, left(output, 1500) AS output, steps, status, tokens_in, tokens_out, started_at, finished_at FROM runs ORDER BY id DESC LIMIT 60' }
};
const prep = (ent, body) => {
  const x = { ...body };
  for (const k of ENT[ent].dt || []) if (x[k]) x[k] = U.parseLocal(x[k]);
  for (const k of Object.keys(x)) if (x[k] === '') x[k] = null;
  return x;
};
app.get('/api/e/:ent', wrap(async (req, res) => {
  const e = ENT[req.params.ent]; if (!e) return res.sendStatus(404);
  let rows = await db.many(e.list, [req.query.q ? '%' + req.query.q + '%' : null]);
  if (req.params.ent === 'quotes') rows = rows.map(r => ({ ...r, link: docs.link('q', r) }));
  if (req.params.ent === 'invoices') rows = rows.map(r => ({ ...r, link: docs.link('i', r) }));
  res.json(rows);
}));
app.post('/api/e/:ent', wrap(async (req, res) => {
  const ent = req.params.ent, e = ENT[ent]; if (!e || ['runs', 'quotes', 'invoices', 'emails'].includes(ent)) return res.sendStatus(404);
  if (ent === 'appointments') return res.json(await T.add_appointment.handler({ title: req.body.title, datetime: req.body.at, location: req.body.location, notes: req.body.notes }));
  if (ent === 'tasks') return res.json(await T.create_task.handler({ ...req.body, assignee: req.body.assignee_id }, { agent: 'owner' }));
  if (ent === 'members') return res.json(await T.save_member.handler(prep(ent, req.body)));
  if (ent === 'customers') return res.json(await T.save_customer.handler(prep(ent, req.body)));
  if (ent === 'contacts') return res.json(await T.save_contact.handler(prep(ent, req.body)));
  if (ent === 'shopping' && !req.body.item) return res.status(400).json({ error: 'اكتب الغرض' });
  res.json(await db.insert(e.table || ent, prep(ent, req.body), e.cols));
}));
app.patch('/api/e/:ent/:id', wrap(async (req, res) => {
  const ent = req.params.ent, e = ENT[ent]; if (!e) return res.sendStatus(404);
  const x = prep(ent, req.body);
  const cols = [...e.cols];
  if (ent === 'tasks' && x.status === 'done') { x.done_at = new Date().toISOString(); cols.push('done_at'); }
  if (ent === 'deals' && ['won', 'lost'].includes(x.stage)) { x.closed_at = new Date().toISOString(); cols.push('closed_at'); }
  if (ent === 'notes') { x.updated_at = new Date().toISOString(); cols.push('updated_at'); }
  res.json(await db.update(e.table || ent, Number(req.params.id), x, cols));
}));
app.delete('/api/e/:ent/:id', wrap(async (req, res) => {
  const ent = req.params.ent; if (!ENT[ent] || ['runs', 'invoices'].includes(ent)) return res.sendStatus(404);
  if (ent === 'appointments') return res.json({ message: await T.cancel_appointment.handler({ id: Number(req.params.id) }) });
  await db.q(`DELETE FROM ${ENT[ent].table || ent} WHERE id=$1`, [Number(req.params.id)]);
  res.json({ ok: true });
}));

// عروض وفواتير ومالية
app.post('/api/quotes', wrap(async (req, res) => res.json(await T.create_quote.handler(req.body))));
app.post('/api/quotes/:id/send', wrap(async (req, res) => res.json({ message: await T.send_quote.handler({ quote_id: Number(req.params.id), to: req.body.to || undefined }) })));
app.post('/api/invoices', wrap(async (req, res) => res.json(await T.create_invoice.handler(req.body))));
app.post('/api/invoices/:id/send', wrap(async (req, res) => res.json({ message: await T.send_invoice.handler({ invoice_id: Number(req.params.id), to: req.body.to || undefined }) })));
app.post('/api/invoices/:id/payment', wrap(async (req, res) => res.json(await T.record_payment.handler({ invoice_id: Number(req.params.id), ...req.body }))));
app.get('/api/finance', wrap(async (req, res) => res.json(await T.money_report.handler({ from: req.query.from, to: req.query.to }))));
app.get('/api/report', wrap(async (_req, res) => res.json({ report: await scheduler.dailyReport() })));
app.get('/api/quick/:k', wrap(async (req, res) => { const f = quick[req.params.k]; if (typeof f !== 'function') return res.sendStatus(404); res.json({ text: await f() }); }));

// الموافقات
app.get('/api/approvals', wrap(async (_req, res) => res.json(await db.many("SELECT * FROM approvals WHERE status='pending' ORDER BY id DESC"))));
app.post('/api/approvals/:id', wrap(async (req, res) => res.json({ message: await decide(req.params.id, !!req.body.approve, req.body.text) })));

// محادثات واتساب + تجربة عميل
app.get('/api/conversations', wrap(async (_req, res) => res.json(await db.many('SELECT phone, name, updated_at, messages->-1 AS last FROM conversations ORDER BY updated_at DESC LIMIT 100'))));
app.get('/api/conversation/:phone', wrap(async (req, res) => res.json(await db.one('SELECT * FROM conversations WHERE phone=$1', [req.params.phone]))));
app.post('/api/simulate', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim(); if (!text) return res.json({});
  res.json(await agents.handleCustomerMessage('test-' + (req.body.session || 'demo'), 'عميل تجريبي', text));
}));

// الإعدادات
// استهلاك الذكاء الاصطناعي
app.get('/api/usage', wrap(async (_req, res) => {
  const H = require('./health');
  const [t, byAgent, daily, pend] = await Promise.all([H.totals(),
    db.many("SELECT agent, round(sum(cost)::numeric, 3) AS cost, count(*) AS calls FROM ai_usage WHERE at >= now() - interval '30 days' GROUP BY agent ORDER BY 2 DESC"),
    db.many("SELECT to_char(at AT TIME ZONE 'Asia/Riyadh', 'MM-DD') AS day, round(sum(cost)::numeric, 3) AS cost FROM ai_usage WHERE at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1"),
    db.many("SELECT id, channel, left(text, 120) AS text, status, attempts, created_at FROM pending_requests ORDER BY id DESC LIMIT 10")]);
  res.json({ ...t, byAgent, daily, pending: pend, credit_out: H.isCreditOut(), health: (await db.getSettings()).health || {} });
}));
app.get('/api/settings', wrap(async (_req, res) => {
  const s = await db.getSettings();
  res.json({ ai_mode: s.ai_mode || 'balanced', monthly_budget: Number(s.monthly_budget || 0), notify_channel: s.notify_channel || 'auto', voice: { local: await require('./voice').localReady(), configured: !!process.env.WHISPER_URL, groq: !!(process.env.GROQ_API_KEY || s.groq_key) }, prayer_alerts: Number(s.prayer_alerts || 0), reply_others: !!s.reply_others, forward_others: s.forward_others !== false, profile: s.profile, budgets: s.budgets, autonomy: s.autonomy, report_hour: s.report_hour, morning_hour: s.morning_hour, weekly_review: s.weekly_review, company: s.company });
}));
app.get('/api/whatsapp', wrap(async (_req, res) => res.json({ ...(await ch.evoStatus()), owner_phone: C.OWNER_PHONE ? '…' + C.OWNER_PHONE.slice(-4) : null }))); 
app.get('/api/whatsapp/qr', wrap(async (_req, res) => res.json(await ch.evoQR())));
// رقم المالك (رقمك الشخصي) — السكرتير يرد عليه هو بس
app.post('/api/whatsapp/owner', wrap(async (req, res) => {
  const num = ch.saNumber((req.body || {}).number);
  if (!/^\d{10,15}$/.test(num)) return res.status(400).json({ error: 'رقم غير صحيح. اكتبه مثل 05xxxxxxxx' });
  try { // ما نسمح يكون نفس رقم السكرتير
    const list = await ch.evo('GET', '/instance/fetchInstances');
    const me = (Array.isArray(list) ? list : []).map(i => ch.waNumber(i.ownerJid || (i.instance && i.instance.owner) || '')).filter(Boolean);
    if (me.some(n => n.slice(-9) === num.slice(-9))) return res.status(400).json({ error: 'هذا رقم السكرتير نفسه! اكتب رقمك الشخصي اللي بتكلمه منه' });
  } catch (_) {}
  await db.setSetting('owner_phone', num);
  C.OWNER_PHONE = num;
  await db.log('settings', `تغيير رقم المالك إلى …${num.slice(-4)}`);
  res.json({ message: '✅ انحفظ رقمك', owner_phone: '…' + num.slice(-4) });
}));
// بوت تيليجرام من اللوحة (بدل تعديل ملفات السيرفر)
// التحكم بجوال المالك
app.get('/api/phone', wrap(async (_req, res) => res.json(await require('./phone').status())));
app.post('/api/phone/token', wrap(async (_req, res) => { const r = await require('./phone').newToken(); await db.log('settings', '📱 رمز ربط جديد لجسر الجوال'); res.json(r); }));
app.post('/api/phone/revoke', wrap(async (_req, res) => { await require('./phone').revoke(); await db.log('settings', '📱 فصل جسر الجوال'); res.json({ ok: true }); }));

// خدمات خارجية (MCP)
const maskUrl = u => { try { const x = new URL(u); return x.host + (x.pathname.length > 1 ? '/…' + x.pathname.slice(-4) : ''); } catch (_) { return '—'; } };
app.get('/api/mcp', wrap(async (_req, res) => res.json(((await db.getSettings()).mcp_servers || []).map(m => ({ name: m.name, label: m.label, enabled: m.enabled !== false, url: maskUrl(m.url), token: m.token ? '••••' + String(m.token).slice(-4) : '' })))));
app.post('/api/mcp/test', wrap(async (req, res) => {
  const m = ((await db.getSettings()).mcp_servers || []).find(x => x.name === (req.body || {}).name);
  if (!m) return res.status(404).json({ error: 'غير موجودة' });
  res.json(await require('./power').mcpTest(m));
}));
app.post('/api/mcp', wrap(async (req, res) => {
  const cur = (await db.getSettings()).mcp_servers || [];
  const b = req.body || {};
  let list;
  if (b.remove) list = cur.filter(m => m.name !== b.remove);
  else if (b.toggle) list = cur.map(m => m.name === b.toggle ? { ...m, enabled: m.enabled === false } : m);
  else { if (!b.name || !b.url) return res.status(400).json({ error: 'لازم اسم ورابط' }); list = [...cur.filter(m => m.name !== String(b.name).toLowerCase()), { name: b.name, label: b.label || b.name, url: b.url, token: b.token, enabled: true }]; }
  const P = require('./power');
  const saved = await P.mcpSave(list);
  await db.log('settings', '🔌 تحديث الخدمات المتصلة');
  const added = !b.remove && !b.toggle ? saved.find(m => m.name === String(b.name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40)) : null;
  res.json({ ok: true, count: saved.length, test: added ? await P.mcpTest(added) : undefined });
}));
app.post('/api/telegram/token', wrap(async (req, res) => {
  const token = String((req.body || {}).token || '').trim();
  if (!/^\d{6,12}:[\w-]{30,}$/.test(token)) return res.status(400).json({ error: 'التوكن مو بالشكل الصحيح. انسخه كامل من BotFather (أرقام ثم : ثم حروف)' });
  const r = await fetch(`${ch.TG_BASE}/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) }).then(x => x.json()).catch(() => ({}));
  if (!r.ok) return res.status(400).json({ error: 'تيليجرام رفض التوكن. تأكد إنك نسخت آخر توكن من BotFather' });
  await db.setSetting('tg_token', token);
  await db.setSetting('tg_bot', r.result.username);
  C.TELEGRAM_BOT_TOKEN = token;
  await ch.setupTelegramWebhook();
  await db.log('settings', `ربط بوت تيليجرام @${r.result.username}`);
  res.json({ message: `✅ انربط البوت @${r.result.username}`, bot: r.result.username });
}));
app.post('/api/whatsapp/pair', wrap(async (req, res) => res.json(await ch.evoPair((req.body || {}).number))));
app.post('/api/whatsapp/logout', wrap(async (_req, res) => { await ch.evoLogout(); res.json({ message: 'انفصل الرقم' }); }));

// ---------- نقل لسيرفر جديد: كود مؤقت + تصدير كامل ----------
app.post('/api/admin/migrate-code', wrap(async (_req, res) => {
  const code = crypto.randomBytes(9).toString('base64url');
  await db.setSetting('migrate', { code, expires: Date.now() + 2 * 3600e3 });
  res.json({ code, expires_in_minutes: 120 });
}));
app.post('/api/admin/export', wrap(async (req, res) => {
  const m = (await db.getSettings()).migrate || {};
  const got = Buffer.from(String(req.get('x-migrate-code') || '')), want = Buffer.from(String(m.code || ''));
  if (!m.code || Date.now() > m.expires || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(403).json({ error: 'كود النقل غير صحيح أو منتهي' });
  const SKIP = ['backups', 'execution_entity', 'execution_data', 'execution_metadata', 'execution_annotations', 'execution_annotation_tags', 'insights_raw', 'insights_by_period', 'event_destinations', 'test_run', 'test_case_execution', 'chat_hub_messages'];
  const out = { exported_at: new Date().toISOString(), source: C.PUBLIC_URL, env: {}, schemas: {} };
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'CLAUDE_FAST_MODEL', 'CLAUDE_SMART_MODEL', 'DASHBOARD_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'OWNER_PHONE', 'N8N_SECRET', 'N8N_ENCRYPTION_KEY', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'APP_SECRET', 'BUSINESS_INFO', 'REPORT_HOUR']) {
    if (process.env[k]) out.env[k] = process.env[k];
  }
  for (const schema of ['public', 'n8n']) {
    const tables = await db.many("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY 1", [schema]);
    out.schemas[schema] = {};
    for (const { table_name } of tables) {
      if (SKIP.includes(table_name)) continue;
      out.schemas[schema][table_name] = await db.many(`SELECT * FROM "${schema}"."${table_name}"`);
    }
  }
  await db.setSetting('migrate', { code: null, used_at: new Date().toISOString() }); // الكود يستخدم مرة وحدة
  await db.log('migrate', '📦 تم تصدير البيانات لسيرفر جديد');
  res.json(out);
}));

app.post('/api/bills/:id/pay', wrap(async (req, res) => res.json({ message: await T.pay_bill.handler({ id: Number(req.params.id), amount: req.body.amount }) })));
app.post('/api/shortcut/rotate', wrap(async (_req, res) => { await db.setSetting('shortcut_token', crypto.randomBytes(18).toString('hex')); res.json({ url: `${C.PUBLIC_URL}/hook/${await shortcutToken()}` }); }));
app.post('/api/settings', wrap(async (req, res) => {
  const allowed = ['profile', 'budgets', 'autonomy', 'report_hour', 'morning_hour', 'weekly_review', 'company', 'notify_channel', 'reply_others', 'forward_others', 'watch_ack', 'groq_key', 'prayer_alerts', 'ai_mode', 'monthly_budget'];
  if (req.body.ai_mode !== undefined && !['economy', 'balanced', 'max'].includes(req.body.ai_mode)) return res.status(400).json({ error: 'وضع غير معروف' });
  if (req.body.monthly_budget !== undefined) req.body.monthly_budget = Math.max(0, Number(req.body.monthly_budget) || 0);
  for (const k of allowed) if (req.body[k] !== undefined) await db.setSetting(k, req.body[k]);
  await db.log('settings', 'تحديث الإعدادات');
  res.json({ message: '✅ انحفظت الإعدادات' });
}));

async function start() {
  await db.connect();
  { const s = await db.getSettings(); if (s.owner_phone) C.OWNER_PHONE = String(s.owner_phone).replace(/\D/g, ''); if (s.tg_token) C.TELEGRAM_BOT_TOKEN = s.tg_token; }
  app.listen(C.PORT, () => console.log('🚀 النظام شغال على المنفذ', C.PORT, '(قاعدة بيانات)'));
  await ch.setupTelegramWebhook();
  (async () => { for (let i = 0; i < 20; i++) { try { await ch.evo('GET', '/'); break; } catch (_) { if (!ch.evoEnabled()) return; await new Promise(r => setTimeout(r, 15000)); } } await ch.setupEvolution(); })();
  scheduler.start();
  const missing = ['ANTHROPIC_API_KEY', 'DASHBOARD_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'N8N_WEBHOOK_URL', 'N8N_SECRET'].filter(k => !process.env[k]);
  if (missing.length) console.warn('⚠️ إعدادات ناقصة:', missing.join(', '));
}

module.exports = { app, start };
