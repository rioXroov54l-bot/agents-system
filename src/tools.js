// أدوات الوكلاء: كل أداة تنفذ عملاً حقيقياً على قاعدة البيانات أو القنوات
const db = require('./db');
const ch = require('./channels');
const docs = require('./docs');
const U = require('./util');
const C = require('./config');
const llm = require('./llm');

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (d) => ({ type: 'string', description: d });
const int = (d) => ({ type: 'integer', description: d });
const numb = (d) => ({ type: 'number', description: d });
const bool = (d) => ({ type: 'boolean', description: d });
const ITEMS = {
  type: 'array', description: 'البنود. السعر للوحدة قبل الضريبة. لا تخترع أسعاراً: استخدم قائمة المنتجات أو سعراً أعطاه المالك.',
  items: S({ name: str('اسم البند'), description: str('وصف/مواصفات (اختياري)'), qty: numb('الكمية'), unit: str('الوحدة'), price: numb('سعر الوحدة قبل الضريبة'), product_id: int('رقم المنتج إن وجد') }, ['name', 'qty'])
};

// ---------- مساعدات ----------
async function resolveMember(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (Number.isInteger(Number(ref)) && String(ref).trim() !== '') {
    const m = await db.one('SELECT * FROM members WHERE id=$1', [Number(ref)]);
    if (m) return m;
  }
  return db.one('SELECT * FROM members WHERE active AND name ILIKE $1 ORDER BY id LIMIT 1', ['%' + String(ref).trim() + '%']);
}
async function customerOf(id) { return id ? db.one('SELECT * FROM customers WHERE id=$1', [id]) : null; }

async function fillItemPrices(items) {
  const out = [];
  for (const it of items || []) {
    const x = { ...it };
    if (x.product_id && (x.price === undefined || x.price === null)) {
      const p = await db.one('SELECT * FROM products WHERE id=$1', [x.product_id]);
      if (p) { x.price = Number(p.price); x.unit = x.unit || p.unit; x.name = x.name || p.name; }
    }
    if (x.price === undefined || x.price === null) throw new Error(`البند "${x.name}" بدون سعر. اطلب السعر من المالك أو أضفه لقائمة المنتجات.`);
    out.push(x);
  }
  return out;
}

// فحص جودة لأي رسالة تطلع لعميل
async function qaOutbound(text, purpose) {
  const s = await db.getSettings();
  try {
    const r = llm.parseJson(await llm.ask(
      `أنت مراجع جودة لرسائل تُرسل نيابة عن ${(s.profile && s.profile.name) || 'المالك'} لشخص أو جهة خارجية.
ارفض (ok=false) فقط إذا: فيها معلومة مخترعة واضحة، أو وعد مالي/زمني خطير غير مبرر، أو لغة غير لائقة، أو بيانات حساسة (كلمات سر، أرقام بنكية لعميل آخر)، أو فيها أقواس [ ] فاضية لم تُعبأ.

أرجع JSON فقط: {"ok":true,"issue":""}`,
      `الغرض: ${purpose}\n\nالرسالة:\n${text}`, { model: C.FAST_MODEL, maxTokens: 200 }));
    return r || { ok: false, issue: 'تعذر الفحص' };
  } catch (e) { return { ok: false, issue: 'تعذر الفحص: ' + e.message }; }
}

// هل يحتاج هذا الإجراء موافقة المالك؟
async function needsApproval({ external = false, amount = 0 }) {
  const a = (await db.getSettings()).autonomy;
  if (a.level === 'strict' && external) return 'مستوى الاستقلالية: كل شي يطلع لعميل يحتاج موافقة';
  if (amount && Number(amount) > Number(a.approval_threshold || 0) && Number(a.approval_threshold) > 0) return `المبلغ ${U.money(amount)} أعلى من حد الموافقة ${U.money(a.approval_threshold)}`;
  if (a.level === 'balanced' && external) return 'مستوى الاستقلالية متوازن: الرسائل الخارجية تحتاج موافقة';
  return null;
}

async function createApproval(kind, summary, payload) {
  const ap = await db.insert('approvals', { kind, summary, payload }, ['kind', 'summary', 'payload']);
  await ch.notifyOwner(`🟡 **طلب موافقة #${ap.id}**\n${summary}`, {
    buttons: [[{ text: '✅ موافق', callback_data: `ap:${ap.id}:yes` }, { text: '❌ رفض', callback_data: `ap:${ap.id}:no` }]]
  });
  await db.log('approval', `طلب موافقة #${ap.id}: ${summary.slice(0, 120)}`);
  return ap;
}

// ---------- منفذات الإجراءات (تُستدعى مباشرة أو بعد الموافقة) ----------
const executors = {
  async gmail_reply(p) {
    const r = await require('./google').gmailReply(p);
    await db.log('email_out', `رد على إيميل: ${r.subject}`);
    return { ...r, message: `✅ انرسل الرد إلى ${r.to}` };
  },
  async send_email(p) {
    await ch.sendEmail({ to: p.to, subject: p.subject, body: p.body });
    if (p.customer_id) {
      await db.q('INSERT INTO interactions (customer_id, channel, direction, summary) VALUES ($1,$2,$3,$4)', [p.customer_id, 'email', 'out', `${p.subject}`]);
      await db.q('UPDATE customers SET last_contact_at=now() WHERE id=$1', [p.customer_id]);
    }
    await db.log('email_out', `إيميل إلى ${p.to}: ${p.subject}`, p.agent || null);
    return `✅ انرسل الإيميل إلى ${p.to}`;
  },
  async send_whatsapp(p) {
    await ch.sendWhatsApp(p.phone, p.text);
    if (p.customer_id) await db.q('INSERT INTO interactions (customer_id, channel, direction, summary) VALUES ($1,$2,$3,$4)', [p.customer_id, 'whatsapp', 'out', p.text.slice(0, 200)]);
    await db.log('wa_out', `واتساب إلى ${p.phone}`);
    await require('./watch').add(ch.saNumber(p.phone), { note: 'رد على رسالة: ' + p.text.slice(0, 80), days: 14, outbound: p.text }).catch(() => {});
    await appendConversation(ch.saNumber(p.phone), null, 'agent', p.text).catch(() => {});
    return `✅ انرسلت رسالة واتساب إلى ${p.phone} — وأي رد منه بيوصلك تلقائياً لمدة 14 يوم`;
  },
  async send_quote(p) {
    const qt = await db.one('SELECT * FROM quotes WHERE id=$1', [p.quote_id]);
    if (!qt) throw new Error('العرض غير موجود');
    const cu = await customerOf(qt.customer_id);
    const s = await db.getSettings();
    const link = docs.link('q', qt);
    const to = p.to || (cu && cu.email);
    if (!to) throw new Error('العميل ما عنده إيميل. أضف إيميله أو أرسل الرابط بطريقة ثانية.');
    const body = (p.message ? p.message + '\n\n' : `السلام عليكم ${cu ? cu.name : ''}،\n\nيسعدنا تزويدكم بعرض السعر رقم ${qt.number} بإجمالي ${U.money(qt.total)} ريال شامل الضريبة.\n\n`) +
      `رابط العرض (للعرض والطباعة PDF):\n${link}\n\nلأي استفسار: ${(s.company.phones_sales || []).join(' - ')}\n\nمع التحية،\n${s.company.name}`;
    await executors.send_email({ to, subject: `عرض سعر ${qt.number} — ${s.company.name}`, body, customer_id: qt.customer_id });
    await db.q("UPDATE quotes SET status='sent', sent_at=now() WHERE id=$1", [qt.id]);
    if (qt.deal_id) await db.q("UPDATE deals SET stage=CASE WHEN stage IN ('lead','qualified') THEN 'quoted' ELSE stage END, updated_at=now() WHERE id=$1", [qt.deal_id]);
    return `✅ انرسل العرض ${qt.number} إلى ${to}`;
  },
  async send_invoice(p) {
    const inv = await db.one('SELECT * FROM invoices WHERE id=$1', [p.invoice_id]);
    if (!inv) throw new Error('الفاتورة غير موجودة');
    const cu = await customerOf(inv.customer_id);
    const s = await db.getSettings();
    const to = p.to || (cu && cu.email);
    if (!to) throw new Error('العميل ما عنده إيميل');
    const remaining = Number(inv.total) - Number(inv.paid_amount);
    const body = (p.message ? p.message + '\n\n' : `السلام عليكم ${cu ? cu.name : ''}،\n\nمرفق رابط الفاتورة الضريبية رقم ${inv.number}.\nالمبلغ المستحق: ${U.money(remaining)} ريال${inv.due_date ? `\nتاريخ الاستحقاق: ${U.fmtDay(inv.due_date)}` : ''}\n\n`) +
      `${docs.link('i', inv)}\n\n${s.company.bank ? 'بيانات التحويل:\n' + s.company.bank + '\n\n' : ''}مع التحية،\n${s.company.name}`;
    await executors.send_email({ to, subject: `فاتورة ${inv.number} — ${s.company.name}`, body, customer_id: inv.customer_id });
    return `✅ انرسلت الفاتورة ${inv.number} إلى ${to}`;
  },
  async customer_reply(p) {
    const text = (p.text || p.draft || '').trim();
    if (!text) throw new Error('الرد فاضي');
    await ch.sendWhatsApp(p.phone, text);
    await appendConversation(p.phone, p.name, 'agent', text);
    return `✅ انرسل الرد لـ ${p.name || p.phone}`;
  },
  async note(p) { return p.text || 'تم'; }
};

async function appendConversation(phone, name, role, text) {
  const c = await db.one('SELECT * FROM conversations WHERE phone=$1', [phone]);
  const msgs = (c ? (typeof c.messages === 'string' ? JSON.parse(c.messages) : c.messages) : []).concat({ role, text, at: new Date().toISOString() }).slice(-100);
  await db.q(`INSERT INTO conversations (phone, name, messages, updated_at) VALUES ($1,$2,$3,now())
    ON CONFLICT (phone) DO UPDATE SET messages=$3, name=COALESCE($2, conversations.name), updated_at=now()`, [phone, name || null, JSON.stringify(msgs)]);
  return msgs;
}

// تنفيذ إجراء خارجي: يفحص الجودة والصلاحية، وإما ينفذ أو يطلب موافقة
async function guardedExternal(kind, payload, { text, purpose, amount = 0 }) {
  const reason = await needsApproval({ external: true, amount });
  if (!reason && text) {
    const qa = await qaOutbound(text, purpose);
    if (!qa.ok) {
      const ap = await createApproval(kind, `${purpose}\nأوقفه مراجع الجودة: ${qa.issue}\n\n${text.slice(0, 1200)}`, payload);
      return `⏸️ ما انرسل. مراجع الجودة أوقفه (${qa.issue}) وتحول للمالك كطلب موافقة #${ap.id}.`;
    }
  }
  if (reason) {
    const ap = await createApproval(kind, `${purpose}\nالسبب: ${reason}${text ? '\n\n' + text.slice(0, 1200) : ''}`, payload);
    return `⏸️ ينتظر موافقة المالك (#${ap.id}). السبب: ${reason}`;
  }
  return executors[kind](payload);
}

// ================= تعريف الأدوات =================
const T = {};
const def = (name, description, input_schema, handler) => { T[name] = { name, description, input_schema, handler }; };

// ---------- العملاء ----------
def('find_customers', 'ابحث عن عملاء بالاسم أو الجوال أو الإيميل أو الشركة. بدون نص يرجع آخر العملاء.',
  S({ query: str('نص البحث'), status: str('lead | active | vip | inactive'), limit: int('الحد الأقصى (افتراضي 20)') }),
  async ({ query, status, limit = 20 }) => {
    const like = query ? '%' + query.trim() + '%' : null;
    const digits = query ? query.replace(/\D/g, '').slice(-9) : '';
    return db.many(`SELECT id, name, company, phone, email, city, status, last_contact_at FROM customers
      WHERE ($1::text IS NULL OR name ILIKE $1 OR company ILIKE $1 OR email ILIKE $1 OR ($2 <> '' AND regexp_replace(coalesce(phone,''),'\\D','','g') LIKE '%' || $2 || '%'))
      AND ($3::text IS NULL OR status=$3) ORDER BY updated_at DESC LIMIT $4`, [like, digits, status || null, Math.min(limit, 100)]);
  });

def('save_customer', 'أضف عميلاً جديداً أو حدّث عميلاً موجوداً (مرّر id للتحديث). يمنع التكرار بالجوال/الإيميل.',
  S({ id: int('رقم العميل للتحديث'), name: str('الاسم'), company: str('الشركة'), phone: str('الجوال'), email: str('الإيميل'), city: str('المدينة'), source: str('مصدر العميل'), status: str('lead | active | vip | inactive'), notes: str('ملاحظات'), tags: { type: 'array', items: { type: 'string' } } }),
  async (a) => {
    const cols = ['name', 'company', 'phone', 'email', 'city', 'source', 'status', 'notes', 'tags'];
    if (a.id) return db.update('customers', a.id, a, cols);
    if (!a.name) throw new Error('الاسم مطلوب');
    const digits = (a.phone || '').replace(/\D/g, '').slice(-9);
    const dup = (digits && await db.one("SELECT * FROM customers WHERE regexp_replace(coalesce(phone,''),'\\D','','g') LIKE '%' || $1", [digits]))
      || (a.email && await db.one('SELECT * FROM customers WHERE lower(email)=lower($1)', [a.email]));
    if (dup) return { note: 'العميل موجود مسبقاً، حدّثت بياناته', customer: await db.update('customers', dup.id, a, cols) };
    const c = await db.insert('customers', a, cols);
    await db.log('contact', `👤 جهة اتصال جديدة: ${c.name}`);
    return c;
  });

def('customer_profile', 'ملف عميل كامل: بياناته، صفقاته، عروضه، فواتيره، آخر تواصل، ومهامه.',
  S({ customer_id: int('رقم العميل') }, ['customer_id']),
  async ({ customer_id }) => ({
    customer: await customerOf(customer_id),
    deals: await db.many('SELECT id,title,stage,value,next_action,next_action_at FROM deals WHERE customer_id=$1 ORDER BY id DESC', [customer_id]),
    quotes: await db.many('SELECT id,number,total,status,created_at FROM quotes WHERE customer_id=$1 ORDER BY id DESC LIMIT 10', [customer_id]),
    invoices: await db.many('SELECT id,number,total,paid_amount,status,due_date FROM invoices WHERE customer_id=$1 ORDER BY id DESC LIMIT 10', [customer_id]),
    interactions: await db.many('SELECT channel,direction,summary,at FROM interactions WHERE customer_id=$1 ORDER BY at DESC LIMIT 15', [customer_id]),
    tasks: await db.many("SELECT id,title,status,due_at FROM tasks WHERE customer_id=$1 AND status<>'done'", [customer_id])
  }));

def('log_interaction', 'سجّل تواصلاً مع عميل (مكالمة، زيارة، اجتماع، رسالة).',
  S({ customer_id: int('رقم العميل'), channel: str('call | visit | meeting | email | whatsapp | other'), direction: str('in | out'), summary: str('ملخص') }, ['customer_id', 'summary']),
  async (a) => {
    await db.q('INSERT INTO interactions (customer_id, channel, direction, summary) VALUES ($1,$2,$3,$4)', [a.customer_id, a.channel || 'other', a.direction || 'out', a.summary]);
    await db.q('UPDATE customers SET last_contact_at=now() WHERE id=$1', [a.customer_id]);
    return 'تم التسجيل';
  });

// ---------- المنتجات ----------
def('list_products', 'قائمة المنتجات/الخدمات وأسعارها (قبل الضريبة).', S({ query: str('بحث') }),
  async ({ query }) => db.many('SELECT id, sku, name, unit, price, cost, description FROM products WHERE active AND ($1::text IS NULL OR name ILIKE $1 OR sku ILIKE $1 OR description ILIKE $1) ORDER BY name LIMIT 100', [query ? '%' + query + '%' : null]));

def('save_product', 'أضف أو حدّث منتجاً/خدمة في قائمة الأسعار.',
  S({ id: int('للتحديث'), name: str('الاسم'), sku: str('الرمز'), unit: str('الوحدة'), price: numb('السعر قبل الضريبة'), cost: numb('التكلفة'), description: str('الوصف'), active: bool('فعّال') }),
  async (a) => a.id ? db.update('products', a.id, a, ['name', 'sku', 'unit', 'price', 'cost', 'description', 'active']) : db.insert('products', a, ['name', 'sku', 'unit', 'price', 'cost', 'description', 'active']));

// ---------- الصفقات ----------
def('list_deals', 'الصفقات المفتوحة أو حسب المرحلة/العميل. المراحل: lead, qualified, quoted, negotiation, won, lost.',
  S({ stage: str('المرحلة'), customer_id: int('العميل'), include_closed: bool('يشمل المغلقة') }),
  async ({ stage, customer_id, include_closed }) => db.many(`SELECT d.id, d.title, d.stage, d.value, d.probability, d.next_action, d.next_action_at, c.name AS customer, d.customer_id
    FROM deals d LEFT JOIN customers c ON c.id=d.customer_id
    WHERE ($1::text IS NULL OR d.stage=$1) AND ($2::int IS NULL OR d.customer_id=$2) AND ($3 OR d.stage NOT IN ('won','lost'))
    ORDER BY d.next_action_at NULLS LAST, d.id DESC LIMIT 100`, [stage || null, customer_id || null, !!include_closed || !!stage]));

def('save_deal', 'أنشئ صفقة أو حدّثها (المرحلة، القيمة، الخطوة القادمة وموعدها). next_action_at بصيغة YYYY-MM-DD HH:mm بتوقيت الرياض.',
  S({ id: int('للتحديث'), customer_id: int('العميل'), title: str('العنوان'), stage: str('lead|qualified|quoted|negotiation|won|lost'), value: numb('القيمة المتوقعة'), probability: int('احتمال الفوز %'), next_action: str('الخطوة القادمة'), next_action_at: str('موعدها'), notes: str('ملاحظات') }),
  async (a) => {
    const x = { ...a };
    if (a.next_action_at) x.next_action_at = U.parseLocal(a.next_action_at);
    if (a.stage === 'won' || a.stage === 'lost') x.closed_at = new Date().toISOString();
    const cols = ['customer_id', 'title', 'stage', 'value', 'probability', 'next_action', 'next_action_at', 'notes', 'closed_at'];
    const d = a.id ? await db.update('deals', a.id, x, cols) : await db.insert('deals', x, cols);
    if (a.stage === 'won') await db.log('deal_won', `🎉 صفقة رابحة: ${d.title} (${U.money(d.value)})`);
    return d;
  });

// ---------- عروض الأسعار ----------
def('create_quote', 'أنشئ عرض سعر احترافي (يحسب الضريبة تلقائياً) ويرجع رابطه. الأسعار من قائمة المنتجات أو من المالك فقط.',
  S({ customer_id: int('العميل'), deal_id: int('الصفقة (اختياري)'), items: ITEMS, discount: numb('خصم بالريال قبل الضريبة'), notes: str('ملاحظات تظهر في العرض'), terms: str('شروط مخصصة (اختياري)'), valid_days: int('مدة الصلاحية بالأيام') }, ['customer_id', 'items']),
  async (a) => {
    const s = await db.getSettings();
    const items = await fillItemPrices(a.items);
    const t = U.computeTotals(items, a.discount || 0, s.vat_rate);
    if (t.subtotal > 0 && t.discount / t.subtotal * 100 > Number(s.autonomy.max_discount_pct) + 0.01) {
      throw new Error(`الخصم ${(t.discount / t.subtotal * 100).toFixed(1)}% أعلى من الحد المسموح ${s.autonomy.max_discount_pct}%. اطلب موافقة المالك أولاً (request_approval) ثم أعد المحاولة بعد موافقته.`);
    }
    const number = await db.nextNumber('quote');
    const valid = new Date(Date.now() + (a.valid_days || s.quote_validity_days) * 86400e3).toISOString().slice(0, 10);
    const qt = await db.insert('quotes', { number, customer_id: a.customer_id, deal_id: a.deal_id, items: t.items, subtotal: t.subtotal, discount: t.discount, vat: t.vat, total: t.total, valid_until: valid, notes: a.notes, terms: a.terms || s.quote_terms, token: db.token() },
      ['number', 'customer_id', 'deal_id', 'items', 'subtotal', 'discount', 'vat', 'total', 'valid_until', 'notes', 'terms', 'token']);
    if (a.deal_id) await db.q('UPDATE deals SET value=CASE WHEN value=0 THEN $2 ELSE value END, updated_at=now() WHERE id=$1', [a.deal_id, t.subtotal]);
    await db.log('quote', `عرض سعر ${number} بإجمالي ${U.money(t.total)}`);
    return { id: qt.id, number, subtotal: t.subtotal, vat: t.vat, total: t.total, valid_until: valid, link: docs.link('q', qt) };
  });

def('send_quote', 'أرسل عرض سعر للعميل بالإيميل (برابط قابل للطباعة). يطلب موافقة تلقائياً لو المبلغ فوق الحد.',
  S({ quote_id: int('رقم العرض'), to: str('إيميل بديل (اختياري)'), message: str('رسالة مخصصة (اختياري)') }, ['quote_id']),
  async (a) => {
    const qt = await db.one('SELECT * FROM quotes WHERE id=$1', [a.quote_id]);
    if (!qt) throw new Error('العرض غير موجود');
    return guardedExternal('send_quote', a, { text: a.message || `إرسال عرض ${qt.number}`, purpose: `إرسال عرض السعر ${qt.number} (${U.money(qt.total)} ريال)`, amount: qt.total });
  });

def('list_quotes', 'عروض الأسعار حسب الحالة: draft, sent, accepted, rejected, expired.',
  S({ status: str('الحالة'), customer_id: int('العميل') }),
  async ({ status, customer_id }) => db.many(`SELECT q.id, q.number, q.total, q.status, q.valid_until, q.created_at, c.name AS customer FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
    WHERE ($1::text IS NULL OR q.status=$1) AND ($2::int IS NULL OR q.customer_id=$2) ORDER BY q.id DESC LIMIT 50`, [status || null, customer_id || null]));

def('update_quote_status', 'غيّر حالة عرض سعر (مثلاً accepted عند موافقة العميل).',
  S({ quote_id: int('رقم العرض'), status: str('draft|sent|accepted|rejected|expired') }, ['quote_id', 'status']),
  async ({ quote_id, status }) => {
    const qt = await db.update('quotes', quote_id, { status }, ['status']);
    if (status === 'accepted' && qt.deal_id) await db.q("UPDATE deals SET stage='won', closed_at=now(), updated_at=now() WHERE id=$1", [qt.deal_id]);
    return qt;
  });

// ---------- الفواتير والمالية ----------
def('create_invoice', 'أنشئ فاتورة ضريبية (من عرض سعر مقبول أو ببنود مباشرة). ترجع رابط الفاتورة مع رمز QR.',
  S({ customer_id: int('العميل'), quote_id: int('من عرض سعر'), items: ITEMS, discount: numb('خصم'), due_days: int('مدة السداد بالأيام'), notes: str('ملاحظات') }, ['customer_id']),
  async (a) => {
    const s = await db.getSettings();
    let t;
    if (a.quote_id) {
      const qt = await db.one('SELECT * FROM quotes WHERE id=$1', [a.quote_id]);
      if (!qt) throw new Error('العرض غير موجود');
      const items = typeof qt.items === 'string' ? JSON.parse(qt.items) : qt.items;
      t = U.computeTotals(items, qt.discount, s.vat_rate);
    } else {
      t = U.computeTotals(await fillItemPrices(a.items), a.discount || 0, s.vat_rate);
    }
    if (!t.items.length) throw new Error('لا توجد بنود');
    const number = await db.nextNumber('invoice');
    const due = new Date(Date.now() + (a.due_days ?? s.invoice_due_days) * 86400e3).toISOString().slice(0, 10);
    const inv = await db.insert('invoices', { number, customer_id: a.customer_id, quote_id: a.quote_id, items: t.items, subtotal: t.subtotal, discount: t.discount, vat: t.vat, total: t.total, due_date: due, notes: a.notes, token: db.token(), issue_date: U.riyadhDay() },
      ['number', 'customer_id', 'quote_id', 'items', 'subtotal', 'discount', 'vat', 'total', 'due_date', 'notes', 'token', 'issue_date']);
    if (a.quote_id) await db.q("UPDATE quotes SET status='accepted' WHERE id=$1", [a.quote_id]);
    await db.log('invoice', `فاتورة ${number} بإجمالي ${U.money(t.total)}`);
    return { id: inv.id, number, total: t.total, vat: t.vat, due_date: due, link: docs.link('i', inv) };
  });

def('send_invoice', 'أرسل فاتورة للعميل بالإيميل.', S({ invoice_id: int('رقم الفاتورة'), to: str('إيميل بديل'), message: str('رسالة مخصصة') }, ['invoice_id']),
  async (a) => {
    const inv = await db.one('SELECT * FROM invoices WHERE id=$1', [a.invoice_id]);
    if (!inv) throw new Error('الفاتورة غير موجودة');
    return guardedExternal('send_invoice', a, { text: a.message || `إرسال فاتورة ${inv.number}`, purpose: `إرسال الفاتورة ${inv.number} (${U.money(inv.total)} ريال)`, amount: inv.total });
  });

def('record_payment', 'سجّل دفعة مستلمة على فاتورة (تحدّث حالتها تلقائياً).',
  S({ invoice_id: int('رقم الفاتورة'), amount: numb('المبلغ'), method: str('تحويل | نقد | شيك | مدى | أخرى'), note: str('ملاحظة') }, ['invoice_id', 'amount']),
  async (a) => {
    const inv = await db.one('SELECT * FROM invoices WHERE id=$1', [a.invoice_id]);
    if (!inv) throw new Error('الفاتورة غير موجودة');
    await db.q('INSERT INTO payments (invoice_id, amount, method, note) VALUES ($1,$2,$3,$4)', [a.invoice_id, a.amount, a.method || 'تحويل', a.note || null]);
    const paid = U.num(Number(inv.paid_amount) + Number(a.amount));
    const status = paid >= Number(inv.total) - 0.01 ? 'paid' : 'partial';
    await db.q('UPDATE invoices SET paid_amount=$2, status=$3 WHERE id=$1', [a.invoice_id, paid, status]);
    await db.log('payment', `💰 دفعة ${U.money(a.amount)} على ${inv.number}`);
    return { invoice: inv.number, paid, remaining: U.num(Number(inv.total) - paid), status };
  });

def('list_invoices', 'الفواتير حسب الحالة: issued, partial, paid, overdue, cancelled. unpaid=true للمستحقات.',
  S({ status: str('الحالة'), customer_id: int('العميل'), unpaid: bool('غير المسددة فقط') }),
  async ({ status, customer_id, unpaid }) => db.many(`SELECT i.id, i.number, i.total, i.paid_amount, i.status, i.issue_date, i.due_date, c.name AS customer FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id
    WHERE ($1::text IS NULL OR i.status=$1) AND ($2::int IS NULL OR i.customer_id=$2) AND (NOT $3 OR i.status IN ('issued','partial','overdue'))
    ORDER BY i.id DESC LIMIT 100`, [status || null, customer_id || null, !!unpaid]));

def('add_expense', 'سجّل مصروفاً (رواتب، إيجار، مواد خام، نقل، تسويق، صيانة...). vat = ضريبة المدخلات إن وجدت.',
  S({ category: str('التصنيف'), vendor: str('المورد/الجهة'), amount: numb('المبلغ الإجمالي'), vat: numb('الضريبة ضمن المبلغ'), date: str('YYYY-MM-DD'), note: str('ملاحظة') }, ['amount', 'category']),
  async (a) => {
    const e = await db.insert('expenses', { ...a, date: a.date || U.riyadhDay() }, ['category', 'vendor', 'amount', 'vat', 'date', 'note']);
    await db.log('expense', `مصروف ${a.category}: ${U.money(a.amount)}`);
    return e;
  });

def('list_expenses', 'المصروفات خلال فترة.', S({ from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD'), category: str('تصنيف') }),
  async ({ from, to, category }) => db.many(`SELECT id, date, category, vendor, amount, vat, note FROM expenses WHERE ($1::date IS NULL OR date >= $1) AND ($2::date IS NULL OR date <= $2) AND ($3::text IS NULL OR category ILIKE $3) ORDER BY date DESC LIMIT 200`, [from || null, to || null, category ? '%' + category + '%' : null]));

def('finance_summary', 'ملخص مالي لفترة: المبيعات (المفوتر)، المحصّل، المستحقات والمتأخرات، المصروفات حسب التصنيف، ضريبة المخرجات والمدخلات، وصافي الربح التقريبي.',
  S({ from: str('YYYY-MM-DD (افتراضي بداية الشهر)'), to: str('YYYY-MM-DD (افتراضي اليوم)') }),
  async ({ from, to }) => {
    const today = U.riyadhDay();
    from = from || today.slice(0, 8) + '01'; to = to || today;
    const inv = await db.one(`SELECT coalesce(sum(subtotal - discount),0) AS sales_net, coalesce(sum(vat),0) AS vat_out, coalesce(sum(total),0) AS total, count(*) AS count FROM invoices WHERE status<>'cancelled' AND issue_date BETWEEN $1 AND $2`, [from, to]);
    const col = await db.one('SELECT coalesce(sum(amount),0) AS collected FROM payments WHERE at::date BETWEEN $1 AND $2', [from, to]);
    const exp = await db.many('SELECT category, sum(amount) AS amount, sum(vat) AS vat FROM expenses WHERE date BETWEEN $1 AND $2 GROUP BY category ORDER BY 2 DESC', [from, to]);
    const recv = await db.one(`SELECT coalesce(sum(total - paid_amount),0) AS receivables, coalesce(sum(CASE WHEN due_date < CURRENT_DATE THEN total - paid_amount ELSE 0 END),0) AS overdue FROM invoices WHERE status IN ('issued','partial','overdue')`);
    const expTotal = exp.reduce((s, e) => s + Number(e.amount), 0), vatIn = exp.reduce((s, e) => s + Number(e.vat || 0), 0);
    return { period: { from, to }, invoices_count: Number(inv.count), sales_before_vat: U.num(inv.sales_net), sales_total: U.num(inv.total), vat_output: U.num(inv.vat_out), collected: U.num(col.collected),
      expenses_total: U.num(expTotal), expenses_by_category: exp.map(e => ({ category: e.category, amount: U.num(e.amount) })), vat_input: U.num(vatIn), vat_payable: U.num(Number(inv.vat_out) - vatIn),
      net_profit_estimate: U.num(Number(inv.sales_net) - (expTotal - vatIn)), receivables: U.num(recv.receivables), overdue: U.num(recv.overdue) };
  });

// ---------- الفريق والمهام ----------
def('list_members', 'أعضاء الفريق (موظفين، مناديب).', S({}), async () => db.many('SELECT id, name, role, phone, email, (telegram_id IS NOT NULL) AS on_telegram, active FROM members ORDER BY active DESC, name'));

def('save_member', 'أضف أو حدّث عضو فريق. بعد الإضافة يحصل على كود ربط تيليجرام ليستلم مهامه.',
  S({ id: int('للتحديث'), name: str('الاسم'), role: str('الوظيفة'), phone: str('الجوال'), email: str('الإيميل'), active: bool('فعّال') }),
  async (a) => {
    const cols = ['name', 'role', 'phone', 'email', 'active', 'link_code'];
    if (a.id) return db.update('members', a.id, a, cols);
    const m = await db.insert('members', { ...a, link_code: Math.random().toString(36).slice(2, 8).toUpperCase() }, cols);
    return { ...m, how_to_link: `يفتح بوت تيليجرام ويرسل: /start ${m.link_code}` };
  });

def('create_task', 'أنشئ مهمة وأسندها لعضو فريق (بالاسم أو الرقم) ويوصله إشعار. due_at بصيغة YYYY-MM-DD HH:mm. priority: low|normal|high|urgent.',
  S({ title: str('العنوان'), details: str('التفاصيل والخطوات'), assignee: str('اسم أو رقم العضو (فارغ = المالك/الوكلاء)'), priority: str('الأولوية'), due_at: str('الموعد النهائي'), customer_id: int('عميل مرتبط'), deal_id: int('صفقة مرتبطة') }, ['title']),
  async (a, ctx) => {
    const m = await resolveMember(a.assignee);
    if (a.assignee && !m) throw new Error(`ما لقيت عضو باسم "${a.assignee}". أضفه بـ save_member أولاً.`);
    const t = await db.insert('tasks', { title: a.title, details: a.details, assignee_id: m ? m.id : null, priority: a.priority || 'normal', due_at: U.parseLocal(a.due_at), customer_id: a.customer_id, deal_id: a.deal_id, created_by: ctx.agent || 'owner' },
      ['title', 'details', 'assignee_id', 'priority', 'due_at', 'customer_id', 'deal_id', 'created_by']);
    let delivered = false;
    if (m) {
      delivered = await ch.notifyMember(m, `📌 **مهمة جديدة #${t.id}**\n${t.title}${t.details ? '\n\n' + t.details : ''}${t.due_at ? '\n\n⏰ الموعد: ' + U.fmt(t.due_at) : ''}\nالأولوية: ${t.priority}`,
        { buttons: [[{ text: '▶️ بدأت', callback_data: `tk:${t.id}:doing` }, { text: '✅ خلصت', callback_data: `tk:${t.id}:done` }]] });
    }
    await db.log('task', `مهمة #${t.id}: ${t.title}${m ? ' ← ' + m.name : ''}`, ctx.agent);
    return { ...t, assignee: m ? m.name : null, notified: delivered };
  });

def('update_task', 'حدّث مهمة: الحالة (todo|doing|blocked|done)، الموعد، الإسناد، التفاصيل.',
  S({ id: int('رقم المهمة'), status: str('الحالة'), due_at: str('موعد جديد'), assignee: str('إسناد لعضو'), details: str('تفاصيل'), priority: str('أولوية') }, ['id']),
  async (a) => {
    const x = { status: a.status, details: a.details, priority: a.priority };
    if (a.due_at) x.due_at = U.parseLocal(a.due_at);
    if (a.assignee) { const m = await resolveMember(a.assignee); if (!m) throw new Error('العضو غير موجود'); x.assignee_id = m.id; }
    if (a.status === 'done') x.done_at = new Date().toISOString();
    return db.update('tasks', a.id, x, ['status', 'details', 'priority', 'due_at', 'assignee_id', 'done_at']);
  });

def('list_tasks', 'المهام: المفتوحة افتراضياً، أو حسب الحالة/العضو، أو المتأخرة.',
  S({ status: str('todo|doing|blocked|done'), assignee: str('اسم العضو'), overdue: bool('المتأخرة فقط') }),
  async ({ status, assignee, overdue }) => {
    const m = assignee ? await resolveMember(assignee) : null;
    return db.many(`SELECT t.id, t.title, t.status, t.priority, t.due_at, m.name AS assignee FROM tasks t LEFT JOIN members m ON m.id=t.assignee_id
      WHERE (($1::text IS NULL AND t.status<>'done') OR t.status=$1) AND ($2::int IS NULL OR t.assignee_id=$2) AND (NOT $3 OR (t.due_at < now() AND t.status<>'done'))
      ORDER BY (t.priority='urgent') DESC, (t.priority='high') DESC, t.due_at NULLS LAST LIMIT 100`, [status || null, m ? m.id : null, !!overdue]);
  });

// ---------- السكرتير: المواعيد والتذكيرات والإيميل والسفر ----------
def('agenda', 'جدول الأيام القادمة: المواعيد، المهام المستحقة، التذكيرات، الرحلات، ومتابعات الصفقات.',
  S({ days: int('عدد الأيام (افتراضي 1 = اليوم)'), from_day: str('YYYY-MM-DD') }),
  async ({ days = 1, from_day }) => {
    const start = U.parseLocal((from_day || U.riyadhDay()) + 'T00:00');
    const end = new Date(new Date(start).getTime() + days * 86400e3).toISOString();
    return {
      appointments: await db.many('SELECT id, title, at, end_at, location, notes FROM appointments WHERE at >= $1 AND at < $2 ORDER BY at', [start, end]),
      tasks_due: await db.many("SELECT t.id, t.title, t.due_at, t.priority, m.name AS assignee FROM tasks t LEFT JOIN members m ON m.id=t.assignee_id WHERE t.status<>'done' AND t.due_at < $1 ORDER BY t.due_at", [end]),
      reminders: await db.many('SELECT id, text, at FROM reminders WHERE NOT done AND at < $1 ORDER BY at', [end]),
      followups: await db.many("SELECT d.id, d.title, d.next_action, d.next_action_at, c.name AS customer FROM deals d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.stage NOT IN ('won','lost') AND d.next_action_at < $1 ORDER BY d.next_action_at", [end]),
      trips: await db.many("SELECT id, title, destination, depart_at, return_at, status FROM trips WHERE status<>'cancelled' AND depart_at < $1 AND coalesce(return_at, depart_at) >= $2", [end, start])
    };
  });

def('add_appointment', 'احجز موعداً (يُضاف لتقويم Google تلقائياً ويُذكّر المالك قبله بساعة). datetime بصيغة YYYY-MM-DD HH:mm بتوقيت الرياض.',
  S({ title: str('العنوان'), datetime: str('البداية'), duration_min: int('المدة بالدقائق (افتراضي 60)'), customer_id: int('عميل'), location: str('المكان/الرابط'), notes: str('ملاحظات') }, ['title', 'datetime']),
  async (a) => {
    const at = U.parseLocal(a.datetime);
    if (!at) throw new Error('صيغة الوقت غير صحيحة');
    const end = new Date(new Date(at).getTime() + (a.duration_min || 60) * 60e3).toISOString();
    const clash = await db.many('SELECT id, title, at FROM appointments WHERE at < $2 AND coalesce(end_at, at + interval \'1 hour\') > $1', [at, end]);
    const ap = await db.insert('appointments', { title: a.title, at, end_at: end, customer_id: a.customer_id, location: a.location, notes: a.notes }, ['title', 'at', 'end_at', 'customer_id', 'location', 'notes']);
    let gcal = 'تقويم Google غير مربوط';
    try { // مباشرة من Google، وإذا ما تيسر عبر n8n
      const r = await require('./google').calendarCreate({ title: a.title, start: at, end, location: a.location, description: a.notes, reminder_minutes: 60 });
      await db.q('UPDATE appointments SET gcal_id=$2 WHERE id=$1', [ap.id, r.id]); gcal = 'أضيف لتقويم Google';
    } catch (e1) {
      if (ch.n8nReady()) {
        try { const r = await ch.n8n('calendar.create', { title: a.title, start: at, end, description: [a.location, a.notes].filter(Boolean).join('\n') }); if (r && r.id) { await db.q('UPDATE appointments SET gcal_id=$2 WHERE id=$1', [ap.id, r.id]); gcal = 'أضيف لتقويم Google'; } }
        catch (e) { gcal = 'تعذر الإضافة لتقويم Google: ' + e.message; }
      }
    }
    await db.log('appt', `موعد #${ap.id}: ${a.title} (${U.fmt(at)})`);
    return { id: ap.id, title: a.title, at: U.fmt(at), gcal, clashes: clash.map(c => `#${c.id} ${c.title} ${U.fmt(c.at)}`) };
  });

def('cancel_appointment', 'ألغِ موعداً (ويُحذف من تقويم Google).', S({ id: int('رقم الموعد') }, ['id']),
  async ({ id }) => {
    const a = await db.one('DELETE FROM appointments WHERE id=$1 RETURNING *', [id]);
    if (!a) throw new Error('الموعد غير موجود');
    if (a.gcal_id) require('./google').calendarDelete(a.gcal_id).catch(() => ch.n8nReady() && ch.n8n('calendar.delete', { id: a.gcal_id }).catch(() => {}));
    return `انلغى الموعد: ${a.title}`;
  });

def('move_appointment', 'عدّل موعد مسجل (تأجيل/تقديم/تغيير العنوان أو المكان) — ويتحدث في تقويم Google.',
  S({ id: int('رقم الموعد'), datetime: str('الوقت الجديد YYYY-MM-DD HH:mm'), duration_min: int('المدة بالدقائق'), title: str('عنوان جديد'), location: str('مكان جديد'), notes: str('ملاحظات') }, ['id']),
  async (a) => {
    const old = await db.one('SELECT * FROM appointments WHERE id=$1', [a.id]);
    if (!old) throw new Error('الموعد غير موجود');
    const at = a.datetime ? U.parseLocal(a.datetime) : old.at;
    const dur = a.duration_min || Math.round((new Date(old.end_at || new Date(new Date(old.at).getTime() + 3600e3)) - new Date(old.at)) / 6e4);
    const end = new Date(new Date(at).getTime() + dur * 6e4).toISOString();
    const up = await db.one('UPDATE appointments SET title=$2, at=$3, end_at=$4, location=$5, notes=$6, reminded=false WHERE id=$1 RETURNING *',
      [a.id, a.title || old.title, at, end, a.location !== undefined ? a.location : old.location, a.notes !== undefined ? a.notes : old.notes]);
    let gcal = '';
    if (old.gcal_id) { try { await require('./google').calendarUpdate({ id: old.gcal_id, title: up.title, start: at, end, location: up.location || undefined }); gcal = ' وتحدث في تقويم Google'; } catch (e) { gcal = ' (ما قدرت أحدثه في Google: ' + e.message + ')'; } }
    await db.log('appt', `تعديل موعد #${a.id}: ${up.title} (${U.fmt(at)})`);
    return `✅ الموعد #${a.id} «${up.title}» صار ${U.fmt(at)}${gcal}`;
  });

def('update_my_settings', 'غيّر إعدادات المالك: ساعة الموجز الصباحي، ساعة ملخص المساء، وين توصله التنبيهات، أو بياناته (الاسم، المدينة، المطار، العائلة، التفضيلات، التوقيع).',
  S({ morning_hour: int('ساعة الموجز الصباحي 0-23'), evening_hour: int('ساعة ملخص المساء 0-23'), notify_channel: str('auto | telegram | whatsapp | both'),
    thank_replies: bool('يشكر اللي يردون على رسائلنا ويبلغهم إن ردهم بيوصل (افتراضي نعم)'), name: str('الاسم'), city: str('المدينة'), home_airport: str('رمز المطار'), family: str('العائلة'), preferences: str('التفضيلات'), signature: str('توقيع الإيميل') }),
  async (a) => {
    const s = await db.getSettings(), done = [];
    if (a.morning_hour !== undefined) { await db.setSetting('morning_hour', Math.min(23, Math.max(0, a.morning_hour))); done.push(`الموجز الصباحي الساعة ${a.morning_hour}`); }
    if (a.evening_hour !== undefined) { await db.setSetting('report_hour', Math.min(23, Math.max(0, a.evening_hour))); done.push(`ملخص المساء الساعة ${a.evening_hour}`); }
    if (a.notify_channel && ['auto', 'telegram', 'whatsapp', 'both'].includes(a.notify_channel)) { await db.setSetting('notify_channel', a.notify_channel); done.push(`التنبيهات: ${a.notify_channel}`); }
    if (a.thank_replies !== undefined) { await db.setSetting('watch_ack', !!a.thank_replies); done.push(`شكر المردودين: ${a.thank_replies ? 'مفعل' : 'موقف'}`); }
    const pf = {}; for (const k of ['name', 'city', 'home_airport', 'family', 'preferences', 'signature']) if (a[k] !== undefined) pf[k] = a[k];
    if (Object.keys(pf).length) { await db.setSetting('profile', { ...(s.profile || {}), ...pf }); done.push('بياناتك: ' + Object.keys(pf).join('، ')); }
    return done.length ? '✅ انحفظ: ' + done.join(' | ') : 'ما فيه شي يتغير';
  });

def('set_reminder', 'ذكّر المالك بشيء في وقت محدد (يوصله على تيليجرام). at بصيغة YYYY-MM-DD HH:mm.',
  S({ text: str('نص التذكير'), at: str('الوقت') }, ['text', 'at']),
  async ({ text, at }) => {
    const iso = U.parseLocal(at); if (!iso) throw new Error('صيغة الوقت غير صحيحة');
    const r = await db.insert('reminders', { text, at: iso }, ['text', 'at']);
    return `⏰ بذكرك ${U.fmt(iso)}: ${text} (#${r.id})`;
  });

def('list_emails', 'الإيميلات اللي وصلت للنظام وانحفظت (ملخصة ومصنفة). لقراءة Gmail لحظياً استخدم gmail_search.', S({ important_only: bool('المهمة فقط'), unhandled_only: bool('غير المعالجة'), limit: int('العدد') }),
  async ({ important_only, unhandled_only, limit = 15 }) => db.many('SELECT id, from_addr, subject, summary, category, important, handled, at FROM emails WHERE (NOT $1 OR important) AND (NOT $2 OR NOT handled) ORDER BY at DESC LIMIT $3', [!!important_only, !!unhandled_only, Math.min(limit, 50)]));

// ---------- مراقبة ردود واتساب ----------
def('watch_whatsapp', 'راقب رسائل شخص على رقم السكرتير: أي رسالة منه توصل للمالك فوراً (تيليجرام/واتساب) بدون ما يرد عليه السكرتير. استخدمها لما يقول المالك "إذا رد عليك فلان بلغني/انسخ لي رده".',
  S({ phone: str('رقم الجوال 05xxxxxxxx'), name: str('اسمه (اختياري)'), note: str('ليش نراقبه (اختياري)'), days: int('كم يوم (افتراضي 30)') }, ['phone']),
  async ({ phone, name, note, days }) => { const w = await require('./watch').add(ch.saNumber(phone), { name, note, days }); return `✅ أراقب ${name || phone} لين ${w.until.slice(0, 10)}: أي رسالة منه بتوصلك فوراً.`; });
def('unwatch_whatsapp', 'أوقف مراقبة رسائل شخص.', S({ phone: str('رقم الجوال') }, ['phone']),
  async ({ phone }) => { await require('./watch').remove(phone); return `✅ وقفت مراقبة ${phone}`; });
def('list_watched', 'الأشخاص اللي تحت المراقبة (ردودهم توصل للمالك).', S({}), async () => Object.values(await require('./watch').all()));

const G = require('./google');
// ---------- رسائل مجدولة ----------
def('schedule_message', 'جدول رسالة واتساب (أو إيميل) تنرسل تلقائياً في وقت محدد بالضبط — حتى لو المالك نايم. مثال: «أرسل له الساعة 4:30 الفجر». تقدر تخليها تتكرر (يومي/أسبوعي...). بعد الإرسال يتبلغ المالك ويوصله أي رد.',
  S({ to: str('رقم الجوال (05xxxxxxxx) أو الإيميل'), text: str('نص الرسالة كامل'), at: str('وقت الإرسال YYYY-MM-DD HH:mm بتوقيت الرياض'), channel: str('whatsapp (افتراضي) أو email'), subject: str('عنوان الإيميل (للإيميل فقط)'), name: str('اسم المستلم (اختياري)'), repeat: str('none | daily | weekdays | weekly | monthly | yearly') }, ['to', 'text', 'at']),
  async (a) => {
    const at = U.parseLocal(a.at);
    if (!at || isNaN(new Date(at))) throw new Error('الوقت غير صحيح، اكتبه YYYY-MM-DD HH:mm');
    if (new Date(at) < new Date(Date.now() - 6e4)) throw new Error(`الوقت ${a.at} فات. الوقت الحين ${U.riyadhNow()}`);
    const channel = a.channel === 'email' || /@/.test(a.to) ? 'email' : 'whatsapp';
    const r = await db.insert('scheduled_messages', { channel, recipient: channel === 'email' ? a.to.trim() : ch.saNumber(a.to), name: a.name, subject: a.subject, text: a.text, at, repeat: a.repeat || 'none' },
      ['channel', 'recipient', 'name', 'subject', 'text', 'at', 'repeat']);
    await db.log('scheduled', `جدولت رسالة #${r.id} إلى ${a.to} ${U.fmt(at)}`);
    return `✅ انجدولت الرسالة #${r.id}: بتنرسل ${channel === 'email' ? 'بالإيميل' : 'على واتساب'} إلى ${a.to} يوم ${U.fmt(at)} تلقائياً${a.repeat && a.repeat !== 'none' ? ' (وتتكرر ' + a.repeat + ')' : ''}، وبتبلغ المالك أول ما تنرسل.`;
  });
def('list_scheduled', 'الرسائل المجدولة اللي ما انرسلت للحين.', S({}),
  async () => (await db.many("SELECT id, channel, recipient, name, text, at, repeat, status, error FROM scheduled_messages WHERE status IN ('pending','failed') ORDER BY at LIMIT 50")).map(m => ({ ...m, at: U.fmt(m.at) })));
def('cancel_scheduled', 'ألغ رسالة مجدولة برقمها.', S({ id: int('رقم الرسالة') }, ['id']),
  async ({ id }) => { const r = await db.one("UPDATE scheduled_messages SET status='cancelled' WHERE id=$1 AND status IN ('pending','failed') RETURNING id", [id]); return r ? `✅ ألغيت الرسالة المجدولة #${id}` : `ما لقيت رسالة مجدولة #${id} قابلة للإلغاء`; });

// ---------- Gmail وتقويم Google: إدارة كاملة ----------
def('gmail_send', 'أرسل إيميل من Gmail المالك مباشرة (لأي شخص يطلبه المالك). للأشخاص الخارجيين اكتب بأسلوب مهذب واحترافي باسم المالك.',
  S({ to: str('الإيميل (أو أكثر مفصولة بفاصلة)'), cc: str('نسخة إلى (اختياري)'), subject: str('العنوان'), body: str('النص كاملاً') }, ['to', 'subject', 'body']),
  async (a, ctx = {}) => {
    if (!ctx.byOwner) return guardedExternal('send_email', { ...a, agent: ctx.agent }, { text: a.body, purpose: `إيميل إلى ${a.to}: ${a.subject}` });
    const r = await G.gmailSend(a); await db.log('email_out', `إيميل إلى ${a.to}: ${a.subject}`); return { ...r, message: `✅ انرسل الإيميل إلى ${a.to}` };
  });
def('gmail_reply', 'رد على إيميل في نفس المحادثة (بالمعرّف من gmail_search).',
  S({ id: str('معرّف الإيميل'), body: str('نص الرد'), reply_all: bool('رد على الكل') }, ['id', 'body']),
  async (a, ctx = {}) => {
    if (!ctx.byOwner) return guardedExternal('gmail_reply', a, { text: a.body, purpose: `رد على إيميل #${a.id}` });
    return executors.gmail_reply(a);
  });
def('gmail_draft', 'جهّز مسودة إيميل في Gmail بدون إرسال (للمراجعة). استخدمها لما المالك يبي يشوف قبل الإرسال.',
  S({ to: str('الإيميل'), cc: str('نسخة'), subject: str('العنوان'), body: str('النص') }, ['subject', 'body']), async (a) => G.gmailDraft(a));
def('gmail_manage', 'نظّم إيميلات: read (مقروء) | unread | archive (أرشفة) | inbox | star | unstar | important | not_important | spam | trash (سلة المحذوفات).',
  S({ ids: { type: 'array', items: { type: 'string' }, description: 'معرفات الإيميلات' }, action: str('الإجراء') }, ['ids', 'action']), async (a) => G.gmailModify(a));
def('calendar_add', 'أضف موعد/حدث لتقويم Google مباشرة (مع تنبيه، مكان، مدعوين).',
  S({ title: str('العنوان'), start: str('YYYY-MM-DD HH:mm'), end: str('YYYY-MM-DD HH:mm (افتراضي ساعة)'), location: str('المكان'), description: str('تفاصيل'), attendees: { type: 'array', items: { type: 'string' }, description: 'إيميلات المدعوين' }, reminder_minutes: int('تنبيه قبل كم دقيقة'), all_day: bool('طول اليوم') }, ['title', 'start']),
  async (a) => G.calendarCreate({ ...a, start: U.parseLocal(a.start), end: a.end && U.parseLocal(a.end) }));
def('calendar_edit', 'عدّل موعد في تقويم Google (الوقت، العنوان، المكان...). المعرّف من google_calendar.',
  S({ id: str('معرّف الموعد'), title: str('العنوان'), start: str('YYYY-MM-DD HH:mm'), end: str('YYYY-MM-DD HH:mm'), location: str('المكان'), description: str('تفاصيل'), reminder_minutes: int('تنبيه قبل كم دقيقة') }, ['id']),
  async (a) => G.calendarUpdate({ ...a, start: a.start && U.parseLocal(a.start), end: a.end && U.parseLocal(a.end) }));
def('calendar_remove', 'احذف موعد من تقويم Google بالمعرّف.', S({ id: str('معرّف الموعد') }, ['id']), async ({ id }) => G.calendarDelete(id));
def('calendar_free_time', 'وش الأوقات الفاضية عند المالك في فترة (من تقويم Google). مفيدة لما أحد يبي موعد أو تبي ترتب شي.',
  S({ from: str('من YYYY-MM-DD'), to: str('إلى YYYY-MM-DD (شامل)'), day_start: int('بداية اليوم (افتراضي 8)'), day_end: int('نهاية اليوم (افتراضي 22)'), min_minutes: int('أقل مدة بالدقايق (افتراضي 30)') }, ['from']),
  async (a) => G.calendarFree({ from: U.parseLocal(a.from + ' 00:00'), to: new Date(new Date(U.parseLocal((a.to || a.from) + ' 00:00')).getTime() + 864e5).toISOString(), day_start: a.day_start || 8, day_end: a.day_end || 22, min_minutes: a.min_minutes || 30 }));

// ---------- الطقس، الصلاة، الهجري، العملات ----------
const Wd = require('./world');
def('weather', 'الطقس الحين وتوقعات الأيام الجاية لأي مدينة (افتراضي مدينة المالك).',
  S({ city: str('المدينة'), days: int('كم يوم (افتراضي 3، أقصى 14)') }), async ({ city, days }) => Wd.weather(city || (await db.getSettings()).profile.city, days));
def('prayer_times', 'مواقيت الصلاة (تقويم أم القرى) لمدينة وتاريخ، مع التاريخ الهجري.',
  S({ city: str('المدينة'), date: str('YYYY-MM-DD (افتراضي اليوم)') }), async ({ city, date }) => Wd.prayerTimes(city || (await db.getSettings()).profile.city, date));
def('convert_date', 'حوّل التاريخ: ميلادي ← هجري (أم القرى) أو هجري ← ميلادي.',
  S({ gregorian: str('YYYY-MM-DD'), hijri: str('يوم/شهر/سنة مثل 1/9/1448') }), async (a) => Wd.convertDate(a));
def('currency_convert', 'حوّل مبلغ بين العملات بأسعار اليوم (USD, EUR, SAR, AED, GBP, TRY, EGP...).',
  S({ amount: numb('المبلغ'), from: str('من عملة'), to: str('إلى عملة (افتراضي SAR)') }, ['from']), async (a) => Wd.currency({ amount: a.amount || 1, from: a.from, to: a.to || 'SAR' }));

// ---------- Gmail وتقويم Google (قراءة مباشرة) ----------
def('gmail_search', 'اقرأ إيميلات Gmail حق المالك مباشرة الحين (مو من الأرشيف). استخدم صيغة بحث Gmail: اليوم = newer_than:1d، غير المقروءة = is:unread، من شخص = from:اسم أو إيميل، موضوع = subject:كلمة، مع مرفقات = has:attachment. يرجع المرسل والموضوع والتاريخ ومقتطف.',
  S({ query: str('صيغة البحث (افتراضي newer_than:1d)'), max: int('العدد (افتراضي 15، أقصى 30)') }),
  async ({ query, max }) => G.gmailSearch({ query: query || 'newer_than:1d', max }));
def('gmail_read', 'افتح إيميل كامل من Gmail بالمعرّف (id) من gmail_search عشان تقرأ نصه كامل.',
  S({ id: str('معرّف الإيميل') }, ['id']), async ({ id }) => G.gmailRead(id));
def('google_calendar', 'اعرض مواعيد تقويم Google حق المالك مباشرة في فترة (افتراضي: الأسبوع الجاي).',
  S({ from: str('من YYYY-MM-DD HH:mm'), to: str('إلى YYYY-MM-DD HH:mm') }),
  async ({ from, to }) => G.calendarEvents({ from: from && U.parseLocal(from), to: to && U.parseLocal(to) }));

def('send_email', 'أرسل إيميل من Gmail الشركة. للعملاء يمر على مراجع الجودة وحدود الصلاحية.',
  S({ to: str('الإيميل'), subject: str('الموضوع'), body: str('النص كاملاً موقّعاً باسم الشركة'), customer_id: int('عميل مرتبط'), internal: bool('true لو المرسل إليه المالك أو موظف') }, ['to', 'subject', 'body']),
  async (a, ctx) => {
    if (a.internal || ctx.byOwner) return executors.send_email({ ...a, agent: ctx.agent });
    return guardedExternal('send_email', { ...a, agent: ctx.agent }, { text: a.body, purpose: `إيميل إلى ${a.to}: ${a.subject}` });
  });

def('send_whatsapp', 'أرسل رسالة واتساب من رقم السكرتير لأي شخص يطلبه المالك. الرقم يقبل 05xxxxxxxx أو 9665xxxxxxxx. النتيجة تقول إذا انرسلت فعلاً أو تنتظر موافقة — بلّغ المالك بالنتيجة كما هي.',
  S({ phone: str('رقم الجوال'), text: str('النص'), customer_id: int('جهة اتصال (اختياري)') }, ['phone', 'text']),
  async (a, ctx = {}) => ctx.byOwner ? executors.send_whatsapp(a) // المالك طلبها بنفسه: ترسل فوراً بدون موافقة
    : guardedExternal('send_whatsapp', a, { text: a.text, purpose: `واتساب إلى ${a.phone}` }));

def('plan_trip', 'ابدأ تخطيط رحلة/سفر (طيران، فندق). بعدها ابحث عن خيارات حقيقية واحفظها بـ save_trip_options.',
  S({ title: str('العنوان'), origin: str('من'), destination: str('إلى'), depart_date: str('YYYY-MM-DD'), return_date: str('YYYY-MM-DD'), travelers: int('عدد المسافرين'), budget: numb('الميزانية بالريال'), notes: str('تفضيلات: درجة، شركة، وقت، فندق قريب من...') }, ['title', 'destination']),
  async (a) => db.insert('trips', { title: a.title, origin: a.origin, destination: a.destination, depart_at: U.parseLocal(a.depart_date), return_at: U.parseLocal(a.return_date), travelers: a.travelers || 1, budget: a.budget, notes: a.notes },
    ['title', 'origin', 'destination', 'depart_at', 'return_at', 'travelers', 'budget', 'notes']));

def('save_trip_options', 'احفظ خيارات الرحلة اللي لقيتها (طيران/فندق) مع السعر والرابط للحجز.',
  S({ trip_id: int('الرحلة'), options: { type: 'array', items: S({ type: str('flight | hotel | car | other'), provider: str('الشركة/الفندق'), details: str('التفاصيل: الرحلة، الأوقات، التوقف، الدرجة...'), price: numb('السعر'), currency: str('العملة'), link: str('رابط الحجز'), notes: str('ملاحظات') }, ['type', 'details']) } }, ['trip_id', 'options']),
  async ({ trip_id, options }) => { await db.q("UPDATE trips SET options=$2, status='options_ready' WHERE id=$1", [trip_id, JSON.stringify(options)]); return `حفظت ${options.length} خيار للرحلة #${trip_id}`; });

def('confirm_trip', 'بعد ما يختار المالك ويحجز: ثبّت تفاصيل الرحلة، أضف مواعيد السفر للتقويم، وتذكيرات (تسجيل الوصول قبل 24 ساعة، التوجه للمطار قبل 3 ساعات)، وقائمة تجهيز.',
  S({ trip_id: int('الرحلة'), chosen: { type: 'object', description: 'تفاصيل الحجز النهائية: رقم الرحلة، الأوقات، الفندق، رقم الحجز' }, flights: { type: 'array', description: 'رحلات الطيران', items: S({ label: str('مثلاً: ذهاب الرياض ← دبي SV554'), depart: str('YYYY-MM-DD HH:mm بتوقيت الرياض'), arrive: str('YYYY-MM-DD HH:mm') }, ['label', 'depart']) }, checklist: { type: 'array', items: { type: 'string' }, description: 'قائمة تجهيز' } }, ['trip_id']),
  async ({ trip_id, chosen, flights = [], checklist = [] }) => {
    const out = [];
    for (const f of flights) {
      const dep = U.parseLocal(f.depart); if (!dep) continue;
      const arr = U.parseLocal(f.arrive) || new Date(new Date(dep).getTime() + 2 * 3600e3).toISOString();
      const ap = await T.add_appointment.handler({ title: '✈️ ' + f.label, datetime: f.depart, duration_min: Math.max(30, Math.round((new Date(arr) - new Date(dep)) / 60e3)), notes: 'رحلة #' + trip_id });
      await db.insert('reminders', { text: `✈️ تسجيل الوصول متاح الحين: ${f.label}`, at: new Date(new Date(dep).getTime() - 24 * 3600e3).toISOString() }, ['text', 'at']);
      await db.insert('reminders', { text: `🚗 وقت التوجه للمطار: ${f.label}`, at: new Date(new Date(dep).getTime() - 3 * 3600e3).toISOString() }, ['text', 'at']);
      out.push(ap.title);
    }
    await db.q("UPDATE trips SET chosen=$2, checklist=$3, status='booked' WHERE id=$1", [trip_id, JSON.stringify(chosen || {}), JSON.stringify(checklist)]);
    return { trip_id, calendar: out, reminders: flights.length * 2, checklist };
  });

def('list_trips', 'الرحلات المخططة والمحجوزة.', S({}), async () => db.many("SELECT id, title, origin, destination, depart_at, return_at, status, options, chosen FROM trips WHERE status<>'cancelled' ORDER BY depart_at NULLS LAST LIMIT 20"));

// ---------- التسويق ----------
def('save_content', 'احفظ محتوى تسويقي: منشور، حملة، إعلان، رسالة جماعية. status: idea|draft|approved|scheduled|published.',
  S({ id: int('للتحديث'), type: str('post|campaign|ad|email|video_script'), platform: str('X|Instagram|LinkedIn|TikTok|Snapchat|Email|WhatsApp'), title: str('العنوان'), body: str('النص الكامل'), status: str('الحالة'), scheduled_at: str('موعد النشر YYYY-MM-DD HH:mm') }),
  async (a) => {
    const x = { ...a }; if (a.scheduled_at) x.scheduled_at = U.parseLocal(a.scheduled_at);
    const cols = ['type', 'platform', 'title', 'body', 'status', 'scheduled_at'];
    return a.id ? db.update('content', a.id, x, cols) : db.insert('content', x, cols);
  });
def('list_content', 'المحتوى التسويقي المحفوظ.', S({ status: str('الحالة') }),
  async ({ status }) => db.many('SELECT id, type, platform, title, status, scheduled_at, left(body, 200) AS preview FROM content WHERE ($1::text IS NULL OR status=$1) ORDER BY id DESC LIMIT 50', [status || null]));

// ---------- البحث ----------
def('save_research', 'احفظ نتيجة بحث (منافسين، أسعار سوق، موردين، عملاء محتملين) للرجوع لها.',
  S({ topic: str('الموضوع'), summary: str('الخلاصة التفصيلية'), sources: { type: 'array', items: { type: 'string' }, description: 'الروابط' } }, ['topic', 'summary']),
  async (a) => db.insert('research', a, ['topic', 'summary', 'sources']));
def('list_research', 'أبحاث محفوظة سابقاً.', S({ query: str('بحث') }),
  async ({ query }) => db.many('SELECT id, topic, left(summary, 400) AS summary, created_at FROM research WHERE ($1::text IS NULL OR topic ILIKE $1 OR summary ILIKE $1) ORDER BY id DESC LIMIT 20', [query ? '%' + query + '%' : null]));

// ---------- مشتركة ----------
def('remember', 'احفظ معلومة دائمة عن الشركة أو تفضيلات المالك ليستخدمها كل الوكلاء لاحقاً.',
  S({ text: str('المعلومة'), kind: str('fact | preference | policy | price | reply_example') }, ['text']),
  async ({ text, kind }) => { await db.insert('knowledge', { text, kind: kind || 'fact' }, ['text', 'kind']); return 'حفظتها'; });
def('recall', 'ابحث في ذاكرة الشركة المحفوظة.', S({ query: str('بحث') }),
  async ({ query }) => db.many('SELECT id, kind, text FROM knowledge WHERE ($1::text IS NULL OR text ILIKE $1) ORDER BY id DESC LIMIT 30', [query ? '%' + query + '%' : null]));

def('notify_owner', 'أرسل رسالة للمالك على تيليجرام فوراً (لتنبيه مهم أو سؤال ضروري).', S({ text: str('الرسالة') }, ['text']),
  async ({ text }, ctx) => { await ch.notifyOwner(`${ctx.agentIcon || '🤖'} ${text}`); return 'وصلته'; });

def('request_approval', 'اطلب موافقة المالك على قرار (خصم أعلى من المسموح، التزام، صرف...). يوصله بأزرار موافق/رفض.',
  S({ summary: str('ماذا تطلب ولماذا بالتفصيل') }, ['summary']),
  async ({ summary }) => { const ap = await createApproval('note', summary, { text: 'تمت الموافقة: ' + summary }); return `أرسلت طلب الموافقة #${ap.id}. لا تنفذ حتى يوافق.`; });

def('business_overview', 'لقطة سريعة عن وضع الشركة الحالي بالأرقام.', S({}),
  async () => ({
    customers: Number((await db.one('SELECT count(*) AS n FROM customers')).n),
    open_deals: await db.one("SELECT count(*) AS n, coalesce(sum(value),0) AS value FROM deals WHERE stage NOT IN ('won','lost')"),
    quotes_waiting: Number((await db.one("SELECT count(*) AS n FROM quotes WHERE status='sent'")).n),
    receivables: await db.one("SELECT count(*) AS n, coalesce(sum(total-paid_amount),0) AS amount FROM invoices WHERE status IN ('issued','partial','overdue')"),
    open_tasks: Number((await db.one("SELECT count(*) AS n FROM tasks WHERE status<>'done'")).n),
    overdue_tasks: Number((await db.one("SELECT count(*) AS n FROM tasks WHERE status<>'done' AND due_at < now()")).n),
    pending_approvals: Number((await db.one("SELECT count(*) AS n FROM approvals WHERE status='pending'")).n),
    upcoming_appointments: await db.many('SELECT title, at FROM appointments WHERE at > now() ORDER BY at LIMIT 5')
  }));

module.exports = { T, executors, createApproval, guardedExternal, appendConversation, qaOutbound, resolveMember };
