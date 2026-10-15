// «الدفع بضغطة»: السكرتير يجهز كل شي ويرسل رابط الدفع، المالك يدفع بنفسه (Apple Pay/مدى)،
// وبعدها السكرتير يلقط إيميل التأكيد ويثبت كل شي تلقائياً (تقويم، تذكيرات، مصروف).
// ملاحظة أمان: النظام لا يحفظ بيانات بطاقات ولا يقرأ رموز OTP ولا يدفع بنفسه أبداً.
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
const def = (name, description, input_schema, handler) => { T[name] = { name, description, input_schema, handler }; };

const KIND = { flight: '✈️', hotel: '🏨', order: '🛍️', food: '🍔', bill: '🧾', event: '🎟️', other: '💳' };
const parseJ = v => (typeof v === 'string' ? JSON.parse(v || '{}') : v || {});

// يرسل للمالك على نفس القناة اللي يكلمنا منها (عشان رابط الدفع يكون قدامه)
async function toOwner(channel, text, buttons) {
  try {
    if (channel === 'telegram' && ch.tgEnabled()) { const id = await ch.ownerTelegramId(); if (id) return await ch.tgSend(id, text, { buttons }); }
    if (channel === 'whatsapp' && C.OWNER_PHONE) return await ch.sendWhatsApp(C.OWNER_PHONE, text);
  } catch (e) { console.error('pay toOwner', e.message); }
  return ch.notifyOwner(text, { buttons });
}

function card(p) {
  const d = parseJ(p.details);
  const L = [`${KIND[p.kind] || '💳'} **جاهز للدفع #${p.id}** — ${p.title}`];
  if (p.vendor) L.push(`🏷️ ${p.vendor}`);
  for (const f of d.flights || []) L.push(`✈️ ${f.label}${f.depart ? ' · ' + f.depart : ''}${f.arrive ? ' ← ' + f.arrive.slice(-5) : ''}`);
  if (d.hotel) L.push(`🏨 ${d.hotel.name || ''}${d.hotel.checkin ? ' · من ' + d.hotel.checkin : ''}${d.hotel.checkout ? ' إلى ' + d.hotel.checkout : ''}`);
  if (d.summary) L.push(`📝 ${d.summary}`);
  if (p.amount) L.push(`💰 **${U.money(p.amount)} ${p.currency === 'SAR' ? 'ريال' : p.currency}**${d.price_note ? ' (' + d.price_note + ')' : ''}`);
  if (p.link) L.push(`\n👉 **ادفع من هنا:**\n${p.link}`);
  L.push(`\nادفع بـ Apple Pay أو مدى، و**بعدها ما تحتاج تسوي شي**: أول ما يوصل إيميل التأكيد أثبت كل شي لحالي ✅\n(أو اكتب «دفعت ${p.id}» — وللإلغاء «ألغ الدفع ${p.id}»)`);
  return L.join('\n');
}

async function prepare(a, ctx = {}) {
  if (!a.title) throw new Error('لازم عنوان');
  if (!a.link) throw new Error('لازم رابط الدفع/الحجز');
  const details = { flights: a.flights || [], hotel: a.hotel || null, summary: a.summary || '', price_note: a.price_note || '', destination: a.destination || '' };
  const p = await db.insert('purchases', { kind: a.kind || 'other', title: a.title, vendor: a.vendor, amount: a.amount, currency: (a.currency || 'SAR').toUpperCase(), link: a.link, details: JSON.stringify(details), trip_id: a.trip_id },
    ['kind', 'title', 'vendor', 'amount', 'currency', 'link', 'details', 'trip_id']);
  await db.log('pay', `جاهز للدفع #${p.id}: ${a.title}`);
  const buttons = [[{ text: '💳 ادفع الحين', url: a.link }], [{ text: '✅ دفعت', callback_data: `pay:${p.id}:paid` }, { text: '❌ ألغ', callback_data: `pay:${p.id}:cancel` }]];
  await toOwner(ctx.channel, card(p), buttons);
  return `✅ بطاقة الدفع #${p.id} انرسلت للمالك برسالة مستقلة (فيها الرابط وزر الدفع). في ردك لا تكرر الرابط — اكتف بملخص قصير وقل له إنه بعد الدفع ما يحتاج يسوي شي.`;
}

// بعد الدفع: يثبت كل شي
async function markPaid(id, { confirmation = '', flights, hotel, source = 'owner' } = {}) {
  const p = await db.one('SELECT * FROM purchases WHERE id=$1', [Number(id)]);
  if (!p) return `ما لقيت طلب دفع #${id}`;
  if (p.status === 'paid') return `#${id} مسجل إنه مدفوع من قبل ✅`;
  if (p.status === 'cancelled') return `#${id} ملغي`;
  const d = parseJ(p.details);
  if (flights && flights.length) d.flights = flights;
  if (hotel) d.hotel = hotel;
  await db.q("UPDATE purchases SET status='paid', paid_at=now(), confirmation=$2, details=$3 WHERE id=$1", [p.id, confirmation || null, JSON.stringify(d)]);
  const done = [];
  if (Number(p.amount) > 0) {
    const cat = { flight: 'سفر', hotel: 'سفر', food: 'مطاعم', order: 'مشتريات', bill: 'فواتير', event: 'ترفيه' }[p.kind] || 'أخرى';
    const amountSar = p.currency === 'SAR' ? Number(p.amount) : await require('./world').currency({ amount: p.amount, from: p.currency, to: 'SAR' }).then(r => r.result).catch(() => Number(p.amount));
    await T.add_expense.handler({ category: cat, vendor: p.vendor || p.title, amount: amountSar, note: `${p.title}${confirmation ? ' — رقم الحجز ' + confirmation : ''}` }).catch(() => {});
    done.push(`💸 سجلته مصروف (${U.money(amountSar)} ريال)`);
  }
  // الطيران: تقويم + تذكير تسجيل الوصول + التوجه للمطار
  const fl = (d.flights || []).filter(f => f.depart && U.parseLocal(f.depart));
  if (fl.length) {
    if (p.trip_id) await T.confirm_trip.handler({ trip_id: p.trip_id, chosen: { purchase: p.id, confirmation, flights: fl }, flights: fl }).catch(e => console.error('confirm_trip', e.message));
    else for (const f of fl) {
      const dep = U.parseLocal(f.depart), arr = U.parseLocal(f.arrive) || new Date(new Date(dep).getTime() + 2 * 3600e3).toISOString();
      await T.add_appointment.handler({ title: '✈️ ' + f.label, datetime: f.depart, duration_min: Math.max(30, Math.round((new Date(arr) - new Date(dep)) / 6e4)), notes: confirmation ? 'رقم الحجز: ' + confirmation : '' }).catch(() => {});
      await db.insert('reminders', { text: `✈️ تسجيل الوصول متاح الحين: ${f.label}${confirmation ? ' (رقم الحجز ' + confirmation + ')' : ''}`, at: new Date(new Date(dep).getTime() - 24 * 3600e3).toISOString() }, ['text', 'at']);
      await db.insert('reminders', { text: `🚗 وقت التوجه للمطار: ${f.label}`, at: new Date(new Date(dep).getTime() - 3 * 3600e3).toISOString() }, ['text', 'at']);
    }
    done.push(`📅 أضفت ${fl.length === 1 ? 'الرحلة' : fl.length + ' رحلات'} لتقويمك`, '⏰ ذكرتك بتسجيل الوصول قبل 24 ساعة والتوجه للمطار قبل 3 ساعات');
  }
  // الفندق: موعد الدخول + تذكير
  if (d.hotel && d.hotel.checkin && U.parseLocal(d.hotel.checkin.length <= 10 ? d.hotel.checkin + ' 15:00' : d.hotel.checkin)) {
    const ci = d.hotel.checkin.length <= 10 ? d.hotel.checkin + ' 15:00' : d.hotel.checkin;
    await T.add_appointment.handler({ title: `🏨 دخول ${d.hotel.name || 'الفندق'}`, datetime: ci, duration_min: 30, notes: confirmation ? 'رقم الحجز: ' + confirmation : '' }).catch(() => {});
    done.push('🏨 أضفت موعد دخول الفندق');
  }
  // طقس الوجهة إذا السفر قريب
  const city = d.destination || (d.hotel && d.hotel.city);
  if (city && fl.length && (new Date(U.parseLocal(fl[0].depart)) - Date.now()) < 14 * 864e5) {
    const w = await require('./world').weather(city, 14).catch(() => null);
    const day = w && w.days.find(x => x.date === U.fmt(U.parseLocal(fl[0].depart)).slice(0, 10));
    if (day) done.push(`🌡️ الطقس في ${w.city} يوم وصولك: ${day.max}°/${day.min}° — ${day.sky}`);
  }
  await db.log('pay', `✅ مدفوع #${p.id}: ${p.title}${source !== 'owner' ? ' (من إيميل التأكيد)' : ''}`);
  return `✅ **تم ${p.kind === 'flight' ? 'الحجز' : 'الدفع'}: ${p.title}**${confirmation ? `\n🔖 رقم الحجز: **${confirmation}**` : ''}\n${done.join('\n') || 'سجلته عندي'}${source !== 'owner' ? '\n\n(لقطت التأكيد من إيميلك تلقائياً 📧)' : ''}`;
}

async function cancel(id) {
  const r = await db.one("UPDATE purchases SET status='cancelled' WHERE id=$1 AND status='awaiting_payment' RETURNING title", [Number(id)]);
  return r ? `❌ ألغيت طلب الدفع #${id} (${r.title})` : `ما لقيت طلب دفع مفتوح #${id}`;
}

const pending = () => db.many("SELECT * FROM purchases WHERE status='awaiting_payment' ORDER BY id DESC LIMIT 20");

// رد المالك: «دفعت» / «دفعت 5» / «ألغ الدفع 5»
async function handleOwnerText(text) {
  const t = String(text || '').trim();
  let m;
  if ((m = t.match(/^(?:دفعت|تم الدفع|سددت|حجزت)\s*#?(\d+)?$/))) {
    if (m[1]) return markPaid(m[1]);
    const list = await pending();
    if (!list.length) return null; // ما فيه شي ينتظر — نخلي المدير يتعامل معها
    if (list.length > 1) return `عندك ${list.length} طلبات دفع مفتوحة، أي واحد دفعت؟\n${list.map(p => `• «دفعت ${p.id}» — ${p.title}`).join('\n')}`;
    return markPaid(list[0].id);
  }
  if ((m = t.match(/^(?:ألغ|الغ|إلغاء|الغاء)\s+(?:ال)?دفع\s*#?(\d+)$/))) return cancel(m[1]);
  return null;
}

// روابط بحث وحجز جاهزة (طيران وفنادق)
function bookingLinks({ type = 'flight', from, to, date, return_date, adults = 1, cabin = 'economy', city, checkin, checkout, rooms = 1 }) {
  const out = [];
  if (type === 'flight') {
    const F = String(from || 'RUH').toUpperCase(), Tt = String(to || '').toUpperCase();
    if (!Tt || !date) throw new Error('لازم الوجهة والتاريخ');
    const yymmdd = s => s.slice(2, 4) + s.slice(5, 7) + s.slice(8, 10);
    out.push({ site: 'Google Flights', url: `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights to ${Tt} from ${F} on ${date}${return_date ? ' through ' + return_date : ' one way'} ${adults} adults ${cabin}`)}&hl=ar&curr=SAR` });
    out.push({ site: 'Skyscanner', url: `https://www.skyscanner.com.sa/transport/flights/${F.toLowerCase()}/${Tt.toLowerCase()}/${yymmdd(date)}/${return_date ? yymmdd(return_date) + '/' : ''}?adultsv2=${adults}&cabinclass=${cabin}&rtn=${return_date ? 1 : 0}&currency=SAR` });
    out.push({ site: 'Kayak', url: `https://www.kayak.sa/flights/${F}-${Tt}/${date}${return_date ? '/' + return_date : ''}${adults > 1 ? '/' + adults + 'adults' : ''}?sort=price_a` });
    out.push({ site: 'Almosafer', url: `https://www.almosafer.com/ar/flights/${F}-${Tt}/${date}${return_date ? '_' + return_date : ''}/${cabin === 'business' ? 'Business' : 'Economy'}/${adults}Adult` });
  } else {
    if (!city || !checkin) throw new Error('لازم المدينة وتاريخ الدخول');
    out.push({ site: 'Booking.com', url: `https://www.booking.com/searchresults.ar.html?ss=${encodeURIComponent(city)}&checkin=${checkin}&checkout=${checkout || checkin}&group_adults=${adults}&no_rooms=${rooms}&selected_currency=SAR` });
    out.push({ site: 'Google Hotels', url: `https://www.google.com/travel/search?q=${encodeURIComponent('hotels in ' + city)}&hl=ar&curr=SAR` });
    out.push({ site: 'Almosafer', url: `https://www.almosafer.com/ar/hotels/${encodeURIComponent(city)}/${checkin}/${checkout || checkin}/${rooms}_adult-${adults}` });
  }
  return { links: out, note: 'روابط بحث بالتاريخ جاهزة. الأفضل تعطي المالك رابط الرحلة/الفندق المحدد من موقع الشركة نفسها إذا لقيته بالبحث.' };
}

// مراقبة إيميلات التأكيد (كل 5 دقايق إذا فيه طلبات دفع مفتوحة)
let lastScan = 0;
async function scanConfirmations() {
  if (Date.now() - lastScan < 5 * 6e4) return; lastScan = Date.now();
  const list = await pending().catch(() => []);
  const s = await db.getSettings();
  // تذكير لطيف بعد 3 ساعات، وانتهاء بعد 7 أيام
  for (const p of list) {
    const age = Date.now() - new Date(p.created_at).getTime();
    if (age > 7 * 864e5) { await db.q("UPDATE purchases SET status='expired' WHERE id=$1", [p.id]); continue; }
    if (age > 3 * 3600e3 && !p.reminded_at) {
      await db.q('UPDATE purchases SET reminded_at=now() WHERE id=$1', [p.id]);
      await ch.notifyOwner(`💳 تذكير: **${p.title}** لسا ما تأكد دفعه (#${p.id}). الأسعار ممكن تتغير.\n${p.link || ''}\n\nإذا دفعت اكتب «دفعت ${p.id}»، وإذا ما تبيه «ألغ الدفع ${p.id}»`, { buttons: [[{ text: '✅ دفعت', callback_data: `pay:${p.id}:paid` }, { text: '❌ ألغ', callback_data: `pay:${p.id}:cancel` }]] });
    }
  }
  const open = list.filter(p => Date.now() - new Date(p.created_at).getTime() <= 7 * 864e5);
  if (!open.length) return;
  const G = require('./google');
  let found;
  try {
    found = await G.gmailSearch({ query: 'newer_than:2d -category:social subject:(تأكيد OR confirmation OR confirmed OR booking OR reservation OR itinerary OR ticket OR receipt OR إيصال OR حجز OR تذكرة OR طلبك OR order OR فاتورة OR invoice OR payment OR دفع)', max: 15 });
  } catch (_) { return; }
  const seen = new Set(s.pay_seen || []);
  for (const e of found.emails.filter(x => !seen.has(x.id))) {
    seen.add(e.id);
    const full = await G.gmailRead(e.id).catch(() => null);
    if (!full) continue;
    const r = llm.parseJson(await llm.ask(
      'أنت تطابق إيميلات تأكيد الدفع/الحجز مع طلبات دفع مفتوحة. JSON فقط: {"match_id": رقم الطلب أو null, "confirmation": "رقم الحجز/الطلب أو فارغ", "flights": [{"label":"الرياض ← جدة XY123","depart":"YYYY-MM-DD HH:mm بتوقيت السعودية","arrive":"YYYY-MM-DD HH:mm"}], "hotel": {"name":"","checkin":"YYYY-MM-DD","checkout":"YYYY-MM-DD"} أو null}\n- طابق فقط إذا الإيميل تأكيد دفع/حجز فعلي (مو عرض أو تذكير بالدفع) ويخص نفس الطلب (نفس الشركة/الوجهة/التاريخ/المبلغ تقريباً).',
      `الطلبات المفتوحة:\n${open.map(p => `#${p.id} | ${p.kind} | ${p.title} | ${p.vendor || ''} | ${p.amount || ''} ${p.currency} | ${JSON.stringify(parseJ(p.details)).slice(0, 400)}`).join('\n')}\n\nالإيميل:\nمن: ${full.from}\nالموضوع: ${full.subject}\n${String(full.body).slice(0, 4000)}`,
      { model: C.FAST_MODEL, maxTokens: 600 }).catch(() => '')) || {};
    const id = Number(r.match_id);
    if (id && open.some(p => p.id === id)) {
      const msg = await markPaid(id, { confirmation: r.confirmation, flights: (r.flights || []).filter(f => f && f.depart), hotel: r.hotel && r.hotel.checkin ? r.hotel : null, source: 'email' });
      await ch.notifyOwner(msg);
    }
  }
  await db.setSetting('pay_seen', [...seen].slice(-300));
}

// ---------- الأدوات ----------
def('prepare_payment', 'جهّز «الدفع بضغطة»: بعد ما تختار أفضل خيار (رحلة/فندق/طلب/فاتورة/تذكرة) أرسل للمالك بطاقة دفع فيها الملخص والسعر ورابط الدفع المباشر. المالك يدفع بنفسه بـ Apple Pay/مدى، وبعدها النظام يلقط إيميل التأكيد ويضيف التقويم والتذكيرات والمصروف تلقائياً. مرّر flights/hotel بالتفصيل عشان التثبيت يكون دقيق.',
  S({ kind: str('flight | hotel | order | food | bill | event | other'), title: str('عنوان واضح مثل: رحلة الرياض ← جدة الخميس'), vendor: str('الشركة/المتجر'), amount: numb('السعر'), currency: str('العملة (افتراضي SAR)'),
    link: str('رابط الدفع/الحجز المباشر (أفضل رابط للخيار نفسه)'), summary: str('ملخص الخيار في سطر'), price_note: str('ملاحظة السعر مثل: شامل العفش 23 كجم'), destination: str('مدينة الوجهة (للسفر)'), trip_id: int('رقم الرحلة إن وجدت من plan_trip'),
    flights: { type: 'array', items: S({ label: str('الرياض ← جدة XY123'), depart: str('YYYY-MM-DD HH:mm'), arrive: str('YYYY-MM-DD HH:mm') }, ['label']) },
    hotel: S({ name: str('اسم الفندق'), city: str('المدينة'), checkin: str('YYYY-MM-DD'), checkout: str('YYYY-MM-DD') }) }, ['title', 'link']),
  (a, ctx) => prepare(a, ctx));
def('mark_paid', 'سجّل إن المالك دفع طلب (لما يقول «دفعت») — يثبت التقويم والتذكيرات والمصروف.',
  S({ id: int('رقم طلب الدفع'), confirmation: str('رقم الحجز إن وجد') }, ['id']), async ({ id, confirmation }) => markPaid(id, { confirmation }));
def('list_pending_payments', 'طلبات الدفع اللي تنتظر المالك يدفعها.', S({}),
  async () => (await pending()).map(p => ({ id: p.id, kind: p.kind, title: p.title, amount: p.amount, currency: p.currency, link: p.link, created: U.fmt(p.created_at) })));
def('cancel_payment', 'ألغ طلب دفع مفتوح.', S({ id: int('رقم الطلب') }, ['id']), async ({ id }) => cancel(id));
def('booking_links', 'روابط بحث وحجز جاهزة بالتاريخ: طيران (Google Flights, Skyscanner, Kayak, المسافر) أو فنادق (Booking, Google Hotels, المسافر). استخدم رموز المطارات (RUH, JED, DMM, DXB...).',
  S({ type: str('flight | hotel'), from: str('مطار المغادرة'), to: str('مطار الوصول'), date: str('YYYY-MM-DD'), return_date: str('YYYY-MM-DD'), adults: int('عدد البالغين'), cabin: str('economy | business'), city: str('مدينة الفندق'), checkin: str('YYYY-MM-DD'), checkout: str('YYYY-MM-DD'), rooms: int('الغرف') }, ['type']),
  async (a) => bookingLinks(a));

module.exports = { prepare, markPaid, cancel, pending, handleOwnerText, scanConfirmations, bookingLinks, card };
