// أدوات الحياة الشخصية: جهات الاتصال، الفواتير والاشتراكات، الوثائق، المناسبات، الأهداف، المقاضي، الملاحظات، المالية الشخصية، البنك
const db = require('./db');
const U = require('./util');
const C = require('./config');
const llm = require('./llm');
const ch = require('./channels');
const { T } = require('./tools');

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const int = d => ({ type: 'integer', description: d });
const numb = d => ({ type: 'number', description: d });
const bool = d => ({ type: 'boolean', description: d });
const def = (name, description, input_schema, handler) => { T[name] = { name, description, input_schema, handler }; };

const addCycle = (dateStr, cycle) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (cycle === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (cycle === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cycle === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else if (cycle === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
};
const daysUntil = dateStr => Math.round((new Date(dateStr + 'T00:00:00+03:00') - new Date(U.riyadhDay() + 'T00:00:00+03:00')) / 86400e3);
const dayStr = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

// ---------- جهات الاتصال ----------
def('find_contacts', 'ابحث في جهات الاتصال (أهل، أصحاب، عمل، خدمات وفنيين) بالاسم أو الجوال أو الإيميل أو العلاقة.',
  S({ query: str('نص البحث'), relation: str('عائلة | صديق | عمل | خدمات | أخرى') }),
  async ({ query, relation }) => {
    const like = query ? '%' + query.trim() + '%' : null;
    return db.many(`SELECT id, name, relation, company, phone, email, city, notes FROM customers
      WHERE ($1::text IS NULL OR name ILIKE $1 OR company ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR notes ILIKE $1) AND ($2::text IS NULL OR relation=$2)
      ORDER BY name LIMIT 50`, [like, relation || null]);
  });
def('save_contact', 'أضف أو حدّث جهة اتصال (مرّر id للتحديث).',
  S({ id: int('للتحديث'), name: str('الاسم'), relation: str('عائلة | صديق | عمل | خدمات | أخرى'), company: str('الجهة/المهنة'), phone: str('الجوال'), email: str('الإيميل'), city: str('المدينة'), notes: str('ملاحظات: تفضيلاته، كيف تعرفه، مقاساته...') }),
  async (a) => T.save_customer.handler({ ...a, status: 'active', source: a.relation }).then(async r => {
    const c = r.customer || r;
    if (a.relation) await db.q('UPDATE customers SET relation=$2 WHERE id=$1', [c.id, a.relation]);
    return { ...c, relation: a.relation || c.relation };
  }));

// ---------- التذكيرات المتكررة ----------
def('set_reminder', 'ذكّر المالك بشيء على تيليجرام. يدعم التكرار (أدوية، رياضة، تغيير زيت...). at بصيغة YYYY-MM-DD HH:mm بتوقيت الرياض.',
  S({ text: str('نص التذكير'), at: str('أول موعد'), repeat: str('none | daily | weekdays | weekly | monthly | yearly') }, ['text', 'at']),
  async ({ text, at, repeat = 'none' }) => {
    const iso = U.parseLocal(at); if (!iso) throw new Error('صيغة الوقت غير صحيحة');
    const r = await db.insert('reminders', { text, at: iso, repeat }, ['text', 'at', 'repeat']);
    return `⏰ بذكرك ${U.fmt(iso)}${repeat !== 'none' ? ' (يتكرر ' + repeat + ')' : ''}: ${text} (#${r.id})`;
  });
def('list_reminders', 'التذكيرات القادمة والمتكررة.', S({}),
  async () => db.many("SELECT id, text, at, repeat FROM reminders WHERE NOT done ORDER BY at LIMIT 100"));
def('cancel_reminder', 'ألغِ تذكيراً.', S({ id: int('رقم التذكير') }, ['id']),
  async ({ id }) => { await db.q('UPDATE reminders SET done=true, repeat=\'none\' WHERE id=$1', [id]); return 'انلغى'; });

// ---------- الفواتير والاشتراكات ----------
def('save_bill', 'أضف أو حدّث فاتورة/اشتراك/التزام دوري (كهرباء، جوال، نت، إيجار، قسط، نتفلكس، تأمين...). يذكّرك قبل موعده.',
  S({ id: int('للتحديث'), name: str('الاسم'), amount: numb('المبلغ المعتاد'), cycle: str('once | weekly | monthly | quarterly | yearly'), next_due: str('تاريخ الاستحقاق القادم YYYY-MM-DD'), category: str('التصنيف'), autopay: bool('يُخصم تلقائياً'), notes: str('ملاحظات: رقم الحساب لدى الجهة، طريقة السداد...'), active: bool('فعّال') }),
  async (a) => {
    const cols = ['name', 'amount', 'cycle', 'next_due', 'category', 'autopay', 'notes', 'active'];
    return a.id ? db.update('bills', a.id, a, cols) : db.insert('bills', a, cols);
  });
def('list_bills', 'الفواتير والاشتراكات الفعّالة مع المستحق قريباً.', S({ due_within_days: int('المستحق خلال كم يوم') }),
  async ({ due_within_days }) => {
    const rows = await db.many('SELECT id, name, amount, cycle, next_due, category, autopay FROM bills WHERE active ORDER BY next_due NULLS LAST');
    const out = rows.map(b => ({ ...b, days_left: b.next_due ? daysUntil(dayStr(b.next_due)) : null }));
    const monthly = out.reduce((s, b) => s + (Number(b.amount) || 0) * ({ weekly: 4.33, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[b.cycle] || 0), 0);
    return { bills: due_within_days ? out.filter(b => b.days_left !== null && b.days_left <= due_within_days) : out, monthly_commitments: U.num(monthly) };
  });
def('pay_bill', 'سجّل سداد فاتورة/اشتراك: يضيفه للمصروفات وينقل موعده للدورة الجاية.',
  S({ id: int('رقم الفاتورة'), amount: numb('المبلغ المدفوع (افتراضي المعتاد)') }, ['id']),
  async ({ id, amount }) => {
    const b = await db.one('SELECT * FROM bills WHERE id=$1', [id]); if (!b) throw new Error('غير موجودة');
    const amt = amount ?? Number(b.amount || 0);
    await db.insert('expenses', { category: b.category || 'فواتير', vendor: b.name, amount: amt, date: U.riyadhDay(), note: 'سداد ' + b.name }, ['category', 'vendor', 'amount', 'date', 'note']);
    const next = b.next_due ? addCycle(dayStr(b.next_due), b.cycle) : null;
    await db.q('UPDATE bills SET next_due=$2, reminded_for=NULL, active=$3 WHERE id=$1', [id, next, b.cycle !== 'once']);
    return `✅ سجلت سداد ${b.name} (${U.money(amt)})${next ? '، الاستحقاق الجاي ' + next : ''}`;
  });

// ---------- الوثائق المهمة ----------
def('save_document', 'سجّل وثيقة مهمة وتاريخ انتهائها (جواز، هوية، إقامة، رخصة قيادة، استمارة، تأمين سيارة، فحص دوري، تأمين طبي، عقد إيجار...) لأذكّره قبل الانتهاء. الأرقام والبيانات التفصيلية (رقم الجواز...) تنحفظ في الخزنة المشفرة بـ vault_save.',
  S({ id: int('للتحديث'), name: str('اسم الوثيقة'), holder: str('صاحبها: أنا، زوجتي، ابني...'), expires_on: str('تاريخ الانتهاء YYYY-MM-DD (ميلادي)'), notes: str('ملاحظات: طريقة التجديد، المتطلبات') }),
  async (a) => a.id ? db.update('documents', a.id, a, ['name', 'holder', 'expires_on', 'notes']) : db.insert('documents', a, ['name', 'holder', 'expires_on', 'notes']));
def('list_documents', 'الوثائق وكم باقي على انتهائها.', S({}),
  async () => (await db.many('SELECT id, name, holder, expires_on, notes FROM documents ORDER BY expires_on NULLS LAST')).map(d => ({ ...d, days_left: d.expires_on ? daysUntil(dayStr(d.expires_on)) : null })));

// ---------- الخزنة المشفرة (بيانات الوثائق) ----------
const V = require('./vault');
const ownerOnly = ctx => { if (!ctx || !ctx.byOwner) throw new Error('الخزنة ما تنفتح إلا بطلب مباشر من المالك 🔒'); };
def('vault_save', 'احفظ بيانات وثيقة في الخزنة المشفرة بطلب المالك: رقم الجواز، الاسم كما في الجواز، الجنسية، تاريخ الميلاد، الإصدار والانتهاء، رقم الهوية/الإقامة/الرخصة... (مفيدة للحجوزات والمعاملات). ممنوع: بطاقات الدفع وكلمات السر ورموز التحقق. احفظ تاريخ الانتهاء أيضاً بـ save_document للتذكير.',
  S({ label: str('اسم الوثيقة: جواز السفر، الهوية الوطنية، الإقامة، رخصة القيادة...'), holder: str('صاحبها: أنا، زوجتي، ابني فلان...'),
    fields: { type: 'object', description: 'الحقول بالمفتاح والقيمة، مثل: {"passport_number":"...","full_name_en":"...","nationality":"...","date_of_birth":"YYYY-MM-DD","issue_date":"...","expiry_date":"...","place_of_birth":"...","place_of_issue":"..."}', additionalProperties: { type: 'string' } } }, ['label', 'fields']),
  async (a, ctx) => { ownerOnly(ctx); return V.save(a); });
def('vault_get', 'اقرأ بيانات وثيقة من الخزنة — فقط لما يطلب المالك نفسه (مثلاً «وش رقم جوازي؟» أو تحتاجها لتعبئة حجز له). لا تشاركها مع أي أحد ثاني إلا إذا طلب المالك صراحة.',
  S({ label: str('اسم الوثيقة (اختياري)'), holder: str('صاحبها (اختياري)') }), async (a, ctx) => { ownerOnly(ctx); return V.get(a); });
def('vault_list', 'وش الوثائق المحفوظة في الخزنة (الأسماء فقط بدون البيانات).', S({}), async () => V.list());
def('vault_delete', 'احذف وثيقة من الخزنة.', S({ id: int('رقمها') }, ['id']), async ({ id }, ctx) => { ownerOnly(ctx); return V.remove(id); });

// ---------- المناسبات ----------
def('save_occasion', 'سجّل مناسبة سنوية (عيد ميلاد، ذكرى زواج، تخرج...). أذكّرك قبلها بأسبوع ويومها.',
  S({ id: int('للتحديث'), person: str('الشخص'), type: str('birthday | anniversary | other'), month: int('الشهر الميلادي 1-12'), day: int('اليوم'), year: int('السنة (اختياري لحساب العمر)'), notes: str('ملاحظات: اهتماماته، أفكار هدايا') }),
  async (a) => a.id ? db.update('occasions', a.id, a, ['person', 'type', 'month', 'day', 'year', 'notes']) : db.insert('occasions', a, ['person', 'type', 'month', 'day', 'year', 'notes']));
def('upcoming_occasions', 'المناسبات القادمة خلال عدد أيام.', S({ days: int('افتراضي 30') }),
  async ({ days = 30 }) => {
    const rows = await db.many('SELECT * FROM occasions');
    const y = U.riyadh().getUTCFullYear();
    return rows.map(o => {
      let d = `${y}-${String(o.month).padStart(2, '0')}-${String(o.day).padStart(2, '0')}`;
      if (daysUntil(d) < 0) d = `${y + 1}-${d.slice(5)}`;
      return { id: o.id, person: o.person, type: o.type, date: d, days_left: daysUntil(d), age: o.year ? Number(d.slice(0, 4)) - o.year : null, notes: o.notes };
    }).filter(o => o.days_left <= days).sort((a, b) => a.days_left - b.days_left);
  });

// ---------- الأهداف والعادات ----------
def('save_goal', 'أنشئ أو حدّث هدفاً أو عادة (رياضة، قراءة، ادخار، وزن، تعلم...).',
  S({ id: int('للتحديث'), title: str('الهدف'), why: str('السبب/الدافع'), target: numb('الرقم المستهدف'), unit: str('الوحدة: صفحة، كم، ريال، مرة...'), period: str('daily | weekly | monthly | once'), deadline: str('YYYY-MM-DD'), status: str('active | done | paused') }),
  async (a) => a.id ? db.update('goals', a.id, a, ['title', 'why', 'target', 'unit', 'period', 'deadline', 'status']) : db.insert('goals', a, ['title', 'why', 'target', 'unit', 'period', 'deadline', 'status']));
def('log_goal', 'سجّل تقدماً في هدف (مثلاً قرأت 20 صفحة، مشيت 5 كم، ادخرت 500).',
  S({ goal_id: int('رقم الهدف'), amount: numb('المقدار'), note: str('ملاحظة') }, ['goal_id']),
  async ({ goal_id, amount = 1, note }) => { await db.q('INSERT INTO goal_logs (goal_id, amount, note) VALUES ($1,$2,$3)', [goal_id, amount, note || null]); return T.list_goals.handler({ id: goal_id }); });
def('list_goals', 'الأهداف مع نسبة التقدم في الفترة الحالية.', S({ id: int('هدف محدد') }),
  async ({ id }) => {
    const goals = await db.many("SELECT * FROM goals WHERE ($1::int IS NULL OR id=$1) AND status<>'done' ORDER BY id", [id || null]);
    const out = [];
    for (const g of goals) {
      const since = { daily: "date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'", weekly: "now() - interval '7 days'", monthly: "date_trunc('month', now())" }[g.period] || "'1970-01-01'::timestamptz";
      const r = await db.one(`SELECT coalesce(sum(amount),0) AS done, count(*) AS n FROM goal_logs WHERE goal_id=$1 AND at >= ${since}`, [g.id]);
      out.push({ id: g.id, title: g.title, period: g.period, target: g.target, unit: g.unit, progress: Number(r.done), pct: g.target ? Math.round(Number(r.done) / Number(g.target) * 100) : null, deadline: g.deadline });
    }
    return out;
  });

// ---------- المقاضي ----------
def('add_shopping', 'أضف أغراض لقائمة المقاضي/المشتريات.',
  S({ items: { type: 'array', items: S({ item: str('الغرض'), qty: str('الكمية'), store: str('المتجر المفضل'), category: str('تموينات | خضار | منظفات | صيدلية | إلكترونيات | أخرى') }, ['item']) } }, ['items']),
  async ({ items }) => { for (const it of items) await db.insert('shopping', it, ['item', 'qty', 'store', 'category']); return `أضفت ${items.length} غرض`; });
def('list_shopping', 'قائمة المقاضي الحالية.', S({ include_done: bool('يشمل المشترى') }),
  async ({ include_done }) => db.many('SELECT id, item, qty, store, category, done FROM shopping WHERE ($1 OR NOT done) ORDER BY done, category, id', [!!include_done]));
def('check_shopping', 'علّم أغراض كمشتراة، أو امسح المشترى.', S({ ids: { type: 'array', items: { type: 'integer' } }, clear_done: bool('احذف كل المشترى') }),
  async ({ ids = [], clear_done }) => {
    if (ids.length) await db.q('UPDATE shopping SET done=true WHERE id = ANY($1::int[])', [`{${ids.map(Number).join(',')}}`]);
    if (clear_done) await db.q('DELETE FROM shopping WHERE done');
    return 'تم';
  });

// ---------- الملاحظات ----------
def('save_note', 'احفظ ملاحظة/فكرة/مسودة/معلومة (مقاسات، كلمات لا تُحفظ هنا، أفكار، وصفات، أرقام مواقف...). لا تحفظ كلمات سر أو أرقام بطاقات.',
  S({ id: int('للتحديث'), title: str('العنوان'), body: str('النص'), tags: { type: 'array', items: { type: 'string' } } }, ['body']),
  async (a) => {
    if (/(password|كلمة (ال)?سر|\b\d{16}\b|cvv)/i.test(a.body)) throw new Error('ما أحفظ كلمات سر أو أرقام بطاقات لحمايتك.');
    return a.id ? db.update('notes', a.id, { ...a, updated_at: new Date().toISOString() }, ['title', 'body', 'tags', 'updated_at']) : db.insert('notes', a, ['title', 'body', 'tags']);
  });
def('search_notes', 'ابحث في الملاحظات.', S({ query: str('بحث') }),
  async ({ query }) => db.many('SELECT id, title, body, tags, updated_at FROM notes WHERE ($1::text IS NULL OR title ILIKE $1 OR body ILIKE $1 OR tags::text ILIKE $1) ORDER BY updated_at DESC LIMIT 30', [query ? '%' + query + '%' : null]));

// ---------- المالية الشخصية ----------
def('add_income', 'سجّل دخلاً (راتب، إيجار، عمل حر، أرباح...).',
  S({ source: str('المصدر'), amount: numb('المبلغ'), date: str('YYYY-MM-DD'), note: str('ملاحظة') }, ['amount']),
  async (a) => db.insert('income', { ...a, date: a.date || U.riyadhDay() }, ['source', 'amount', 'date', 'note']));
def('set_budget', 'حدد ميزانية شهرية لتصنيف مصروفات (مطاعم، بنزين، تسوق، ترفيه...). مبلغ 0 يحذفها.',
  S({ category: str('التصنيف'), amount: numb('الميزانية الشهرية') }, ['category', 'amount']),
  async ({ category, amount }) => {
    const s = await db.getSettings(); const b = { ...(s.budgets || {}) };
    if (Number(amount) > 0) b[category] = Number(amount); else delete b[category];
    await db.setSetting('budgets', b); return b;
  });
def('money_report', 'تقرير فلوسك لفترة: الدخل، المصروف حسب التصنيف مقابل الميزانية، الالتزامات الشهرية، والصافي. افتراضي الشهر الحالي.',
  S({ from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD') }),
  async ({ from, to }) => {
    const today = U.riyadhDay(); from = from || today.slice(0, 8) + '01'; to = to || today;
    const s = await db.getSettings();
    const exp = await db.many('SELECT coalesce(category, \'أخرى\') AS category, sum(amount) AS amount, count(*) AS n FROM expenses WHERE date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC', [from, to]);
    const inc = await db.one('SELECT coalesce(sum(amount),0) AS amount FROM income WHERE date BETWEEN $1 AND $2', [from, to]);
    const top = await db.many('SELECT date, vendor, amount, category FROM expenses WHERE date BETWEEN $1 AND $2 ORDER BY amount DESC LIMIT 5', [from, to]);
    const total = exp.reduce((a, e) => a + Number(e.amount), 0);
    const bills = await T.list_bills.handler({ due_within_days: 14 });
    return {
      period: { from, to }, income: U.num(inc.amount), spent: U.num(total), net: U.num(Number(inc.amount) - total),
      by_category: exp.map(e => ({ category: e.category, spent: U.num(e.amount), count: Number(e.n), budget: s.budgets[e.category] || null, over: s.budgets[e.category] ? Number(e.amount) > s.budgets[e.category] : false })),
      budgets_unused: Object.entries(s.budgets || {}).filter(([k]) => !exp.find(e => e.category === k)).map(([k, v]) => ({ category: k, budget: v, spent: 0 })),
      biggest: top, bills_next_14_days: bills.bills, monthly_commitments: bills.monthly_commitments,
      accounts: s.accounts || {}
    };
  });

// ---------- رسائل البنك (SMS/إيميل) ----------
async function parseBankMessage(text, sender = '') {
  const r = llm.parseJson(await llm.ask(
    `حلّل رسالة إشعار بنكية سعودية. JSON فقط:
{"is_transaction":true,"type":"debit|credit|transfer_out|transfer_in|refund|balance|otp|other","amount":0,"currency":"SAR","merchant":"اسم التاجر أو الجهة","account":"آخر 4 أرقام أو اسم الحساب","balance":null,"category":"مطاعم|تموينات|بنزين|تسوق|فواتير|ترفيه|صحة|تعليم|سفر|نقل|تحويلات|رسوم بنكية|أخرى","date":"YYYY-MM-DD أو null"}
- رسائل OTP ورموز التحقق: type=otp وis_transaction=false (لا تذكر الرمز).`,
    `المرسل: ${sender}\n${String(text).slice(0, 1500)}`, { model: C.FAST_MODEL, maxTokens: 300 }));
  return r || { is_transaction: false };
}

async function recordBankMessage(text, sender = '') {
  if (/(رمز|OTP|code|كود).{0,20}\d{4,}/i.test(text) && !/(شراء|purchase|مبلغ|SAR|ريال)/i.test(text)) return { ignored: 'otp' };
  const t = await parseBankMessage(text, sender);
  if (t.type === 'otp') return { ignored: 'otp' };
  const s = await db.getSettings();
  if (t.balance !== null && t.balance !== undefined && t.account) {
    await db.setSetting('accounts', { ...(s.accounts || {}), [t.account]: { balance: Number(t.balance), at: new Date().toISOString(), bank: sender } });
  }
  if (!t.is_transaction || !Number(t.amount)) return { recorded: false, parsed: t };
  const date = t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : U.riyadhDay();
  let msg;
  if (['debit', 'transfer_out'].includes(t.type)) {
    await db.insert('expenses', { category: t.category || 'أخرى', vendor: t.merchant || sender, amount: t.amount, date, note: 'من رسالة البنك' + (t.account ? ' (' + t.account + ')' : ''), payment_method: t.account || null }, ['category', 'vendor', 'amount', 'date', 'note', 'payment_method']);
    // تنبيه الميزانية
    const b = s.budgets && s.budgets[t.category];
    if (b) {
      const spent = Number((await db.one("SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE category=$1 AND date >= date_trunc('month', CURRENT_DATE)", [t.category])).s);
      if (spent > b) msg = `⚠️ تعديت ميزانية **${t.category}**: صرفت ${U.money(spent)} من ${U.money(b)}`;
      else if (spent > b * 0.8) msg = `🟠 قربت تخلص ميزانية **${t.category}**: ${U.money(spent)} من ${U.money(b)}`;
    }
    if (Number(t.amount) >= Number(s.autonomy.approval_threshold || 5000)) msg = (msg ? msg + '\n' : '') + `💳 عملية كبيرة: ${U.money(t.amount)} عند ${t.merchant || '—'}. إذا ما تعرفها كلّم البنك فوراً.`;
  } else if (['credit', 'transfer_in', 'refund'].includes(t.type)) {
    await db.insert('income', { source: t.merchant || sender || 'تحويل وارد', amount: t.amount, date, note: 'من رسالة البنك (' + t.type + ')' }, ['source', 'amount', 'date', 'note']);
    if (Number(t.amount) >= 1000) msg = `💵 وصلك ${U.money(t.amount)} من ${t.merchant || '—'}`;
  }
  await db.log('bank', `🏦 ${t.type}: ${U.money(t.amount)} ${t.merchant || ''}`);
  if (msg) await ch.notifyOwner(msg);
  return { recorded: true, parsed: t };
}
def('record_bank_message', 'حلّل نص رسالة بنكية (SMS أو إيميل) وسجّلها تلقائياً كمصروف أو دخل وحدّث الرصيد.',
  S({ text: str('نص الرسالة'), sender: str('اسم البنك') }, ['text']), async ({ text, sender }) => recordBankMessage(text, sender));

module.exports = { recordBankMessage, addCycle, daysUntil, dayStr };
