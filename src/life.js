// مجالات الحياة: الصحة (أدوية وقراءات)، الممتلكات والصيانة والضمانات، التواصل مع الناس، الاستثمار والأسواق
const db = require('./db');
const U = require('./util');
const ch = require('./channels');
const { T } = require('./tools');

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const int = d => ({ type: 'integer', description: d });
const numb = d => ({ type: 'number', description: d });
const bool = d => ({ type: 'boolean', description: d });
const arr = (d, items = { type: 'string' }) => ({ type: 'array', items, description: d });
const def = (name, description, input_schema, handler) => { T[name] = { name, description, input_schema, handler }; };
const today = () => U.riyadhDay();
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
const addMonths = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + Number(n)); return x.toISOString().slice(0, 10); };

// ======================= 🩺 الصحة =======================
// دواء بمواعيد يومية → تذكيرات متكررة + متابعة المخزون وتنبيه قبل ما يخلص
def('add_medication', 'أضف دواء بجرعته ومواعيده: يصير له تذكير يومي في كل موعد، ويتابع الكمية وينبه قبل ما يخلص بـ 5 أيام.',
  S({ name: str('اسم الدواء'), dose: str('الجرعة مثل: حبة، 5 مل'), times: arr('المواعيد HH:mm مثل ["09:00","21:00"]'), for_whom: str('لمين: أنا، أمي، ابني...'),
    stock: numb('الكمية الموجودة (عدد الحبات/الجرعات) — اختياري'), per_dose: numb('كم يستهلك كل مرة (افتراضي 1)'), with_food: str('قبل/بعد الأكل (اختياري)'), until: str('ينتهي العلاج YYYY-MM-DD (اختياري)'), notes: str('ملاحظات') }, ['name', 'times']),
  async (a) => {
    const times = (a.times || []).map(t => String(t).padStart(5, '0')).filter(t => /^\d\d:\d\d$/.test(t));
    if (!times.length) throw new Error('حدد مواعيد الدواء مثل 09:00');
    const m = await db.insert('medications', { name: a.name, dose: a.dose, times: JSON.stringify(times), for_whom: a.for_whom || 'أنا', stock: a.stock, per_dose: a.per_dose || 1, with_food: a.with_food, until: a.until || null, notes: a.notes },
      ['name', 'dose', 'times', 'for_whom', 'stock', 'per_dose', 'with_food', 'until', 'notes']);
    const ids = [];
    for (const t of times) {
      let at = U.parseLocal(`${today()} ${t}`);
      if (new Date(at) <= new Date()) at = new Date(new Date(at).getTime() + 864e5).toISOString();
      const r = await db.insert('reminders', { text: `💊 وقت ${a.name}${a.dose ? ' (' + a.dose + ')' : ''}${a.for_whom && a.for_whom !== 'أنا' ? ' — ' + a.for_whom : ''}${a.with_food ? ' — ' + a.with_food : ''}`, at, repeat: 'daily' }, ['text', 'at', 'repeat']);
      ids.push(r.id);
    }
    await db.q('UPDATE medications SET reminder_ids=$2 WHERE id=$1', [m.id, JSON.stringify(ids)]);
    const perDay = times.length * (a.per_dose || 1);
    return `✅ أضفت ${a.name}: تذكير يومي الساعة ${times.join(' و ')}${a.stock ? `\n📦 الكمية تكفي تقريباً ${Math.floor(a.stock / perDay)} يوم — بنبهك قبل ما تخلص` : ''}`;
  });
def('list_medications', 'الأدوية الحالية ومواعيدها وكم باقي.', S({}),
  async () => (await db.many('SELECT * FROM medications WHERE active ORDER BY id')).map(m => {
    const times = typeof m.times === 'string' ? JSON.parse(m.times) : m.times; const perDay = times.length * Number(m.per_dose || 1);
    return { id: m.id, name: m.name, dose: m.dose, for_whom: m.for_whom, times, with_food: m.with_food, until: m.until, days_left: m.stock !== null ? Math.floor(Number(m.stock) / perDay) : null };
  }));
def('update_medication', 'حدّث دواء: كمية جديدة (اشتريت علبة)، أو أوقفه.', S({ id: int('رقم الدواء'), add_stock: numb('كمية أضيفت'), stop: bool('إيقاف الدواء') }, ['id']),
  async ({ id, add_stock, stop }) => {
    const m = await db.one('SELECT * FROM medications WHERE id=$1', [id]); if (!m) throw new Error('ما لقيته');
    if (stop) {
      await db.q('UPDATE medications SET active=false WHERE id=$1', [id]);
      const rid = typeof m.reminder_ids === 'string' ? JSON.parse(m.reminder_ids) : (m.reminder_ids || []);
      if (rid.length) await db.q('UPDATE reminders SET done=true WHERE id = ANY($1)', [rid]);
      return `⏹️ أوقفت ${m.name} وتذكيراته`;
    }
    if (add_stock) { await db.q('UPDATE medications SET stock=coalesce(stock,0)+$2, refill_alerted=false WHERE id=$1', [id, add_stock]); return `📦 أضفت ${add_stock} لـ ${m.name}`; }
    return 'ما فيه تغيير';
  });
def('log_health', 'سجّل قراءة صحية: الوزن، الضغط (120/80)، السكر، النبض، النوم بالساعات، الخطوات، الماء... لمتابعة التطور.',
  S({ metric: str('weight | blood_pressure | sugar | heart_rate | sleep | steps | water | other'), value: str('القيمة مثل 82.5 أو 125/82'), unit: str('الوحدة'), for_whom: str('لمين (افتراضي أنا)'), note: str('ملاحظة: صايم، بعد الأكل...') }, ['metric', 'value']),
  async (a) => { const r = await db.insert('health_logs', { metric: a.metric, value: String(a.value), unit: a.unit, for_whom: a.for_whom || 'أنا', note: a.note }, ['metric', 'value', 'unit', 'for_whom', 'note']); return `✅ سجلت ${a.metric}: ${a.value}${a.unit ? ' ' + a.unit : ''}`; });
def('health_history', 'تاريخ القراءات الصحية مع المتوسط والتغير (للتحليل والتقرير).', S({ metric: str('المقياس'), days: int('كم يوم (افتراضي 90)'), for_whom: str('لمين') }, ['metric']),
  async ({ metric, days = 90, for_whom = 'أنا' }) => {
    const rows = await db.many("SELECT value, unit, note, at FROM health_logs WHERE metric=$1 AND for_whom=$2 AND at > now() - ($3 || ' days')::interval ORDER BY at", [metric, for_whom, String(days)]);
    const nums = rows.map(r => parseFloat(String(r.value))).filter(n => !isNaN(n));
    return { metric, count: rows.length, first: rows[0] || null, last: rows[rows.length - 1] || null, avg: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 10) / 10 : null, change: nums.length > 1 ? Math.round((nums[nums.length - 1] - nums[0]) * 10) / 10 : null, readings: rows.slice(-30).map(r => ({ ...r, at: U.fmt(r.at) })) };
  });

// ======================= 🚗🏠 الممتلكات والصيانة والضمانات =======================
def('add_asset', 'سجّل ممتلك: سيارة، بيت/شقة، جهاز (جوال، مكيف، ثلاجة...) مع تاريخ الشراء والضمان والتفاصيل.',
  S({ type: str('car | home | device | other'), name: str('الاسم مثل: كامري 2022، مكيف الصالة'), details: str('تفاصيل: الموديل، اللوحة، الرقم التسلسلي، المتجر...'), purchase_date: str('YYYY-MM-DD'), price: numb('السعر'), warranty_until: str('نهاية الضمان YYYY-MM-DD'), odometer: int('العداد بالكيلو (للسيارة)') }, ['name']),
  async (a) => { const r = await db.insert('assets', { type: a.type || 'other', name: a.name, details: a.details, purchase_date: a.purchase_date || null, price: a.price, warranty_until: a.warranty_until || null, odometer: a.odometer }, ['type', 'name', 'details', 'purchase_date', 'price', 'warranty_until', 'odometer']); return { ...r, message: `✅ سجلت ${a.name} (#${r.id})${a.warranty_until ? ' — بنبهك قبل نهاية الضمان بشهر' : ''}` }; });
def('add_maintenance', 'جدول صيانة دورية لممتلك: تغيير زيت كل 5000 كم أو 6 شهور، تنظيف المكيفات قبل الصيف، فلتر الماء كل 6 شهور، فحص دوري سنوي... ينبه لما يحين الموعد.',
  S({ asset_id: int('رقم الممتلك'), task: str('المهمة'), every_months: int('كل كم شهر'), every_km: int('كل كم كيلو (للسيارة)'), last_done: str('آخر مرة YYYY-MM-DD'), last_km: int('العداد آخر مرة') }, ['asset_id', 'task']),
  async (a) => {
    const last = a.last_done || today();
    const next = a.every_months ? addMonths(last, a.every_months) : null;
    const r = await db.insert('maintenance', { asset_id: a.asset_id, task: a.task, every_months: a.every_months, every_km: a.every_km, last_done: last, last_km: a.last_km, next_due: next }, ['asset_id', 'task', 'every_months', 'every_km', 'last_done', 'last_km', 'next_due']);
    return `✅ ${a.task}: ${next ? 'الموعد الجاي ' + next : ''}${a.every_km ? ` أو بعد ${a.every_km} كم` : ''} — بنبهك`;
  });
def('log_maintenance', 'سجّل إنك سويت صيانة (مع التكلفة والعداد): يحسب الموعد الجاي ويسجلها مصروف.',
  S({ maintenance_id: int('رقم جدول الصيانة'), date: str('YYYY-MM-DD (افتراضي اليوم)'), cost: numb('التكلفة'), odometer: int('العداد الحين'), shop: str('الورشة/الشركة') }, ['maintenance_id']),
  async (a) => {
    const m = await db.one('SELECT m.*, s.name AS asset FROM maintenance m JOIN assets s ON s.id=m.asset_id WHERE m.id=$1', [a.maintenance_id]); if (!m) throw new Error('ما لقيته');
    const d = a.date || today(), next = m.every_months ? addMonths(d, m.every_months) : null;
    await db.q('UPDATE maintenance SET last_done=$2, last_km=coalesce($3,last_km), next_due=$4, alerted=false WHERE id=$1', [m.id, d, a.odometer || null, next]);
    if (a.odometer) await db.q('UPDATE assets SET odometer=$2 WHERE id=$1', [m.asset_id, a.odometer]);
    if (a.cost) await T.add_expense.handler({ category: 'صيانة', vendor: a.shop || m.asset, amount: a.cost, note: `${m.task} — ${m.asset}` }).catch(() => {});
    return `✅ سجلت ${m.task} لـ ${m.asset}${a.cost ? ` (${U.money(a.cost)} ريال)` : ''}${next ? ` — الجاي ${next}` : ''}${m.every_km && a.odometer ? ` أو عند ${a.odometer + m.every_km} كم` : ''}`;
  });
def('update_odometer', 'حدّث عداد السيارة (عشان تنبيهات الصيانة بالكيلو).', S({ asset_id: int('رقم السيارة'), odometer: int('العداد') }, ['asset_id', 'odometer']),
  async ({ asset_id, odometer }) => { await db.q('UPDATE assets SET odometer=$2 WHERE id=$1', [asset_id, odometer]); return `✅ العداد ${odometer} كم`; });
def('list_assets', 'الممتلكات وجداول صيانتها والضمانات.', S({}),
  async () => {
    const assets = await db.many('SELECT * FROM assets ORDER BY type, id'), mt = await db.many('SELECT * FROM maintenance ORDER BY next_due NULLS LAST');
    return assets.map(a => ({ ...a, warranty_days_left: a.warranty_until ? daysBetween(today(), U.fmt(a.warranty_until).slice(0, 10)) : null,
      maintenance: mt.filter(m => m.asset_id === a.id).map(m => ({ id: m.id, task: m.task, next_due: m.next_due ? U.fmt(m.next_due).slice(0, 10) : null, km_due: m.every_km && m.last_km ? m.last_km + m.every_km : null })) }));
  });

// ======================= 🤝 التواصل مع الناس =======================
def('keep_in_touch', 'ذكّرني أتواصل مع شخص كل فترة (أهل، أصدقاء، أقارب): ينبهني إذا طولت ما كلمته، ويجهز رسالة سلام أرسلها بضغطة.',
  S({ name: str('الاسم كما في جهات الاتصال'), phone: str('رقمه (لو جديد)'), every_days: int('كل كم يوم (مثلاً 7، 30)'), relation: str('العلاقة: أخ، خال، صديق...') }, ['name', 'every_days']),
  async (a) => {
    let c = await db.one('SELECT * FROM customers WHERE name ILIKE $1 ORDER BY id LIMIT 1', ['%' + a.name + '%']);
    if (!c) c = await db.insert('customers', { name: a.name, phone: a.phone ? ch.saNumber(a.phone) : null, relation: a.relation || 'أخرى', source: 'يدوي' }, ['name', 'phone', 'relation', 'source']);
    else if (a.phone && !c.phone) await db.q('UPDATE customers SET phone=$2 WHERE id=$1', [c.id, ch.saNumber(a.phone)]);
    await db.q('UPDATE customers SET keep_every_days=$2, last_contact_at=coalesce(last_contact_at, now()) WHERE id=$1', [c.id, a.every_days]);
    return `✅ بذكرك تتواصل مع ${c.name} كل ${a.every_days} يوم`;
  });
def('contacted', 'سجّل إنك تواصلت مع شخص (اتصلت/زرته/كلمته) — يصفر عداد التواصل.', S({ name: str('الاسم'), note: str('ملاحظة عن المكالمة') }, ['name']),
  async ({ name, note }) => {
    const c = await db.one('UPDATE customers SET last_contact_at=now() WHERE id=(SELECT id FROM customers WHERE name ILIKE $1 ORDER BY id LIMIT 1) RETURNING id, name', ['%' + name + '%']);
    if (!c) throw new Error('ما لقيته في جهات الاتصال');
    if (note) await db.q("INSERT INTO interactions (customer_id, channel, direction, summary) VALUES ($1,'call','out',$2)", [c.id, note]);
    return `✅ سجلت تواصلك مع ${c.name}`;
  });

// ======================= 📈 الاستثمار والأسواق =======================
const YF = process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com';
const ALIASES = { 'تاسي': '^TASI.SR', 'السوق': '^TASI.SR', 'الذهب': 'GC=F', 'ذهب': 'GC=F', 'الفضة': 'SI=F', 'النفط': 'BZ=F', 'برنت': 'BZ=F', 'بيتكوين': 'BTC-USD', 'الدولار': 'USDSAR=X', 'أرامكو': '2222.SR', 'ارامكو': '2222.SR', 'الراجحي': '1120.SR', 'سابك': '2010.SR', 'stc': '7010.SR', 'إس تي سي': '7010.SR', 'الأهلي': '1180.SR', 'معادن': '1211.SR', 'الإنماء': '1150.SR', 'أبل': 'AAPL', 'تسلا': 'TSLA', 'انفيديا': 'NVDA' };
const sym = s => { const t = String(s || '').trim(); if (ALIASES[t]) return ALIASES[t]; if (/^\d{4}$/.test(t)) return t + '.SR'; return t.toUpperCase(); };
async function quote(s) {
  const symbol = sym(s);
  const r = await fetch(`${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
  const d = await r.json().catch(() => ({}));
  const m = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  if (!m || m.regularMarketPrice === undefined) throw new Error('ما لقيت سعر ' + symbol);
  const prev = m.chartPreviousClose || m.previousClose, price = m.regularMarketPrice;
  return { symbol, name: m.longName || m.shortName || symbol, price, currency: m.currency, change_pct: prev ? Math.round((price - prev) / prev * 10000) / 100 : null, time: m.regularMarketTime ? U.fmt(new Date(m.regularMarketTime * 1000)) : null };
}
def('market_quote', 'أسعار الأسهم والأسواق الحين: تداول (أرقام مثل 2222 أو أسماء: أرامكو، الراجحي، سابك، تاسي)، الأسهم الأمريكية (AAPL)، الذهب، الفضة، النفط، بيتكوين، العملات (USDSAR=X). إذا فشل استخدم البحث.',
  S({ symbols: arr('الرموز أو الأسماء') }, ['symbols']),
  async ({ symbols }) => Promise.all((symbols || []).slice(0, 15).map(s => quote(s).catch(e => ({ symbol: sym(s), error: e.message })))));
def('add_holding', 'أضف سهم/أصل لمحفظة المالك (الكمية ومتوسط سعر الشراء) لمتابعة الربح والخسارة.',
  S({ symbol: str('الرمز أو الاسم (2222، أرامكو، AAPL، الذهب)'), qty: numb('الكمية'), avg_cost: numb('متوسط سعر الشراء للوحدة'), note: str('ملاحظة') }, ['symbol', 'qty']),
  async (a) => { const s = sym(a.symbol); await db.q('INSERT INTO holdings (symbol, qty, avg_cost, note) VALUES ($1,$2,$3,$4) ON CONFLICT (symbol) DO UPDATE SET qty=$2, avg_cost=coalesce($3, holdings.avg_cost), note=coalesce($4, holdings.note)', [s, a.qty, a.avg_cost, a.note]); return `✅ ${s}: ${a.qty}${a.avg_cost ? ' بمتوسط ' + a.avg_cost : ''}`; });
def('remove_holding', 'احذف أصل من المحفظة.', S({ symbol: str('الرمز') }, ['symbol']), async ({ symbol }) => { await db.q('DELETE FROM holdings WHERE symbol=$1', [sym(symbol)]); return '✅ انحذف'; });
async function portfolio() {
  const hs = await db.many('SELECT * FROM holdings ORDER BY symbol');
  const rows = await Promise.all(hs.map(async h => { const q = await quote(h.symbol).catch(e => ({ error: e.message })); const value = q.price ? q.price * Number(h.qty) : null; const cost = h.avg_cost ? Number(h.avg_cost) * Number(h.qty) : null;
    return { symbol: h.symbol, name: q.name || h.symbol, qty: Number(h.qty), price: q.price, currency: q.currency, day_pct: q.change_pct, value, pnl: value !== null && cost ? Math.round((value - cost) * 100) / 100 : null, pnl_pct: value !== null && cost ? Math.round((value - cost) / cost * 10000) / 100 : null, error: q.error }; }));
  const sar = rows.filter(r => r.value !== null && (r.currency === 'SAR' || !r.currency));
  return { holdings: rows, total_sar: Math.round(sar.reduce((a, r) => a + r.value, 0) * 100) / 100, note: 'الأصول بعملات أخرى محسوبة بعملتها' };
}
def('portfolio_report', 'تقرير المحفظة الحين: قيمة كل سهم، تغير اليوم، الربح/الخسارة.', S({}), async () => portfolio());

// ======================= فحوصات يومية =======================
async function daily() {
  const out = [];
  // الأدوية: نخصم الاستهلاك اليومي وننبه قبل ما تخلص بـ 5 أيام، ونوقف المنتهية
  for (const m of await db.many('SELECT * FROM medications WHERE active')) {
    const times = typeof m.times === 'string' ? JSON.parse(m.times) : m.times, perDay = times.length * Number(m.per_dose || 1);
    if (m.until && U.fmt(m.until).slice(0, 10) < today()) { await T.update_medication.handler({ id: m.id, stop: true }); out.push(`💊 انتهت مدة علاج ${m.name} ووقفت تذكيراته`); continue; }
    if (m.stock === null || m.stock === undefined) continue;
    if (m.last_deduct && U.fmt(m.last_deduct).slice(0, 10) === today()) continue;
    const stock = Math.max(0, Number(m.stock) - perDay);
    await db.q('UPDATE medications SET stock=$2, last_deduct=now() WHERE id=$1', [m.id, stock]);
    const days = Math.floor(stock / perDay);
    if (days <= 5 && !m.refill_alerted) { await db.q('UPDATE medications SET refill_alerted=true WHERE id=$1', [m.id]); out.push(`💊 **${m.name}${m.for_whom && m.for_whom !== 'أنا' ? ' (' + m.for_whom + ')' : ''} قرب يخلص** — يكفي تقريباً ${days} يوم. اشتريت؟ قل «اشتريت علبة ${m.name} فيها ...»`); }
  }
  // الصيانة: بالتاريخ أو بالكيلو
  for (const m of await db.many('SELECT m.*, a.name AS asset, a.odometer FROM maintenance m JOIN assets a ON a.id=m.asset_id WHERE NOT m.alerted')) {
    const byDate = m.next_due && daysBetween(today(), U.fmt(m.next_due).slice(0, 10)) <= 7;
    const byKm = m.every_km && m.last_km && m.odometer && m.odometer >= m.last_km + m.every_km - 500;
    if (!byDate && !byKm) continue;
    await db.q('UPDATE maintenance SET alerted=true WHERE id=$1', [m.id]);
    out.push(`🔧 **${m.task} — ${m.asset}** ${byKm ? `(العداد ${m.odometer} كم)` : `موعده ${U.fmt(m.next_due).slice(0, 10)}`}. لما تسويها قل «سويت ${m.task}» مع التكلفة`);
  }
  // الضمانات: قبل نهايتها بشهر
  for (const a of await db.many("SELECT * FROM assets WHERE warranty_until IS NOT NULL AND NOT warranty_alerted AND warranty_until <= (now() + interval '30 days')::date AND warranty_until >= now()::date")) {
    await db.q('UPDATE assets SET warranty_alerted=true WHERE id=$1', [a.id]);
    out.push(`🛡️ **ضمان ${a.name} ينتهي ${U.fmt(a.warranty_until).slice(0, 10)}** — إذا فيه أي عطل اشتكِ قبل نهايته`);
  }
  // التواصل مع الناس
  for (const c of await db.many("SELECT id, name, phone, relation, keep_every_days, last_contact_at FROM customers WHERE keep_every_days > 0 AND (last_contact_at IS NULL OR last_contact_at < now() - (keep_every_days || ' days')::interval) AND (touch_alerted_at IS NULL OR touch_alerted_at < now() - (keep_every_days || ' days')::interval)")) {
    await db.q('UPDATE customers SET touch_alerted_at=now() WHERE id=$1', [c.id]);
    const days = c.last_contact_at ? Math.round((Date.now() - new Date(c.last_contact_at)) / 864e5) : c.keep_every_days;
    out.push(`🤝 **صار لك ${days} يوم ما تواصلت مع ${c.name}**${c.relation && c.relation !== 'أخرى' ? ' (' + c.relation + ')' : ''}. ${c.phone ? 'تبيني أرسل له سلام باسمك؟ قل «أرسل سلام لـ' + c.name + '»' : 'اتصل عليه 📞'} — وإذا كلمته قل «كلمت ${c.name}»`);
  }
  if (out.length) await ch.notifyOwner('📋 **تنبيهات اليوم**\n\n' + out.join('\n\n'));
  return out;
}

module.exports = { daily, quote, portfolio, sym };
