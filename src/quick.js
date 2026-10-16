// ملخصات فورية بدون ذكاء اصطناعي (سريعة ومجانية)
const db = require('./db');
const U = require('./util');
const C = require('./config');

const PRI = { urgent: '🔴', high: '🟠', normal: '🔵', low: '⚪' };
const T = () => require('./tools').T;

const safe = (p, ms = 12000) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]).catch(() => null);
const hm = iso => U.fmt(iso).slice(11, 16);

async function today() {
  const s = await db.getSettings();
  const p = s.profile || {};
  const city = p.city || 'الرياض';
  const day = U.riyadhDay();
  const start = U.parseLocal(day + 'T00:00'), end = new Date(new Date(start).getTime() + 86400e3).toISOString();
  const W = require('./world'), G = require('./google');

  // كل المصادر بالتوازي، وأي مصدر يتأخر أو يفشل نتجاوزه
  const [appts, rem, tasks, bills, docs, occ, trips, shop, ap, goals, sched, money, wx, pr, gcal, mail] = await Promise.all([
    db.many('SELECT title, at, location FROM appointments WHERE at >= $1 AND at < $2 ORDER BY at', [start, end]),
    db.many('SELECT text, at, repeat FROM reminders WHERE NOT done AND at >= $1 AND at < $2 ORDER BY at', [start, end]),
    db.many("SELECT t.id, t.title, t.due_at, t.priority, m.name AS who FROM tasks t LEFT JOIN members m ON m.id=t.assignee_id WHERE t.status<>'done' AND t.due_at < $1 ORDER BY t.due_at", [end]),
    T().list_bills.handler({ due_within_days: 7 }).then(r => r.bills).catch(() => []),
    T().list_documents.handler({}).then(r => r.filter(d => d.days_left !== null && d.days_left <= 60)).catch(() => []),
    T().upcoming_occasions.handler({ days: 14 }).catch(() => []),
    db.many("SELECT title, depart_at FROM trips WHERE status IN ('booked','options_ready','planning') AND depart_at BETWEEN now() AND now() + interval '14 days' ORDER BY depart_at"),
    db.one('SELECT count(*) AS n FROM shopping WHERE NOT done'),
    db.one("SELECT count(*) AS n FROM approvals WHERE status='pending'"),
    T().list_goals.handler({}).catch(() => []),
    db.many("SELECT recipient, name, at FROM scheduled_messages WHERE status='pending' AND at >= $1 AND at < $2 ORDER BY at", [start, end]).catch(() => []),
    T().money_report.handler({}).catch(() => null),
    safe(W.weather(city, 1)), safe(W.prayerTimes(city)),
    safe(G.calendarEvents({ from: start, to: end })), safe(G.gmailSearch({ query: 'is:unread newer_than:1d -category:promotions -category:social', max: 8 }))
  ]);

  const L = [];
  L.push(`☀️ **صباح الخير${p.name ? ' يا ' + p.name : ''}**`);
  L.push(`📆 ${U.riyadhNow().split(' ')[0]} ${day} — ${(pr && pr.hijri) || W.hijri()}`);
  if (wx) { const d0 = wx.days[0] || {}; L.push(`🌡️ ${wx.city}: ${wx.now.temp}° الحين، العظمى ${d0.max}° والصغرى ${d0.min}° — ${d0.sky || wx.now.sky}${d0.rain_chance ? ` | مطر ${d0.rain_chance}%` : ''}${wx.now.wind_kmh >= 30 ? ` | رياح ${wx.now.wind_kmh} كم/س 💨` : ''}`); }
  if (pr) L.push(`🕌 ${Object.entries(pr.times).filter(([n]) => n !== 'الشروق').map(([n, t]) => `${n} ${t}`).join(' · ')}`);

  // أهم شي اليوم
  const top = [];
  const overdue = tasks.filter(t => new Date(t.due_at) < new Date());
  if (overdue.length) top.push(`${overdue.length} مهمة متأخرة`);
  const billsNow = bills.filter(b => b.days_left <= 0 && !b.autopay);
  if (billsNow.length) top.push(`فاتورة مستحقة: ${billsNow.map(b => b.name).join('، ')}`);
  const docsBad = docs.filter(d => d.days_left <= 7);
  if (docsBad.length) top.push(`وثيقة ${docsBad[0].days_left < 0 ? 'منتهية' : 'تنتهي قريب'}: ${docsBad.map(d => d.name).join('، ')}`);
  const occToday = occ.filter(o => o.days_left === 0);
  if (occToday.length) top.push(`مناسبة اليوم 🎉: ${occToday.map(o => o.person).join('، ')}`);
  if (top.length) L.push('\n🎯 **أهم شي اليوم**', top.map(t => '• ' + t).join('\n'));

  // المواعيد: النظام + تقويم Google بدون تكرار
  const seen = new Set();
  const allAppts = [...appts.map(a => ({ t: a.at, title: a.title, loc: a.location })), ...((gcal || []).map(e => ({ t: e.start, title: e.title, loc: e.location, allDay: !e.start.includes('T') })))]
    .filter(a => { const k = (a.title || '').trim() + '|' + (a.allDay ? 'd' : hm(a.t)); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || new Date(a.t) - new Date(b.t));
  L.push('\n📅 **مواعيد اليوم**', allAppts.length ? allAppts.map(a => `• ${a.allDay ? 'طول اليوم' : hm(a.t)} — ${a.title}${a.loc ? ' 📍' + a.loc : ''}`).join('\n') : '• يومك فاضي من المواعيد');
  if (rem.length) L.push('\n⏰ **تذكيرات اليوم**', rem.map(r => `• ${hm(r.at)} ${r.text}`).join('\n'));
  if (sched.length) L.push('\n📤 **رسائل مجدولة اليوم**', sched.map(m => `• ${hm(m.at)} إلى ${m.name || m.recipient}`).join('\n'));
  if (tasks.length) L.push('\n✅ **مهام مستحقة**', tasks.slice(0, 10).map(t => `• ${PRI[t.priority] || ''} ${t.title}${t.who ? ' ← ' + t.who : ''}${new Date(t.due_at) < new Date() ? ' ⚠️ متأخرة' : ' | ' + hm(t.due_at)}`).join('\n'));
  if (mail && mail.count) L.push(`\n📧 **إيميلات ما قريتها (آخر 24 ساعة): ${mail.count}${mail.count >= 8 ? '+' : ''}**`, mail.emails.slice(0, 5).map(e => `• ${String(e.from).replace(/<.*>/, '').replace(/"/g, '').trim() || e.from} — ${e.subject || '(بدون عنوان)'}`).join('\n'));
  if (bills.length) L.push('\n🧾 **فواتير قريبة**', bills.map(b => `• ${b.name}${b.amount ? ' ' + U.money(b.amount) : ''} — ${b.days_left === 0 ? 'اليوم' : b.days_left < 0 ? 'متأخرة ' + (-b.days_left) + ' يوم' : 'بعد ' + b.days_left + ' يوم'}${b.autopay ? ' (تلقائي)' : ''}`).join('\n'));
  if (docs.length) L.push('\n🪪 **وثائق قربت تنتهي**', docs.map(d => `• ${d.name}${d.holder ? ' (' + d.holder + ')' : ''} — ${d.days_left < 0 ? 'منتهية!' : 'باقي ' + d.days_left + ' يوم'}`).join('\n'));
  if (occ.length) L.push('\n🎂 **مناسبات قريبة**', occ.map(o => `• ${o.person}: ${o.type === 'birthday' ? 'عيد ميلاد' : o.type === 'anniversary' ? 'ذكرى' : 'مناسبة'}${o.age ? ' (' + o.age + ')' : ''} — ${o.days_left === 0 ? 'اليوم 🎉' : 'بعد ' + o.days_left + ' يوم'}`).join('\n'));
  if (trips.length) L.push('\n✈️ **سفر قريب**', trips.map(t => `• ${t.title} — ${U.fmt(t.depart_at)}`).join('\n'));
  if (money && (Number(money.spent) || Number(money.income))) {
    const over = (money.by_category || []).filter(c => c.over).map(c => c.category);
    L.push('\n💰 **فلوسك هالشهر**', `• صرفت ${U.money(money.spent)}${Number(money.income) ? ` من دخل ${U.money(money.income)} (الصافي ${U.money(money.net)})` : ''}${over.length ? `\n• 🔴 تجاوزت الميزانية في: ${over.join('، ')}` : ''}`);
  }
  if (goals.length) L.push('\n🎯 **أهدافك**', goals.slice(0, 5).map(g => `• ${g.title}: ${g.progress}${g.target ? '/' + g.target : ''} ${g.unit || ''}${g.pct !== null ? ' (' + g.pct + '%)' : ''}`).join('\n'));
  const extra = [];
  if (Number(shop.n)) extra.push(`🛒 ${shop.n} غرض بقائمة المقاضي`);
  if (Number(ap.n)) extra.push(`🟡 ${ap.n} موافقة تنتظرك`);
  const pw = await db.many('SELECT label, last_price, currency, last_available FROM price_watches WHERE active ORDER BY id LIMIT 6').catch(() => []);
  if (pw.length) L.push('\n🔔 **منتجات أتابعها**', pw.map(w => `• ${w.label}: ${w.last_price ? Number(w.last_price).toLocaleString('en-US') + ' ' + (w.currency === 'SAR' || !w.currency ? 'ريال' : w.currency) : '—'} ${w.last_available === true ? '✅' : w.last_available === false ? '❌ غير متوفر' : ''}`).join('\n'));
  const pp = await db.one("SELECT count(*) AS n FROM purchases WHERE status='awaiting_payment'").catch(() => ({ n: 0 }));
  if (Number(pp.n)) extra.push(`💳 ${pp.n} حجز/طلب ينتظر دفعك`);
  if (extra.length) L.push('\n' + extra.join(' | '));
  L.push('\n💬 قل لي أي شي تبيه اليوم وأنا أرتبه لك.');
  return L.join('\n');
}

async function tasks() {
  const ts = await db.many("SELECT t.id, t.title, t.status, t.priority, t.due_at, m.name AS who FROM tasks t LEFT JOIN members m ON m.id=t.assignee_id WHERE t.status<>'done' ORDER BY (t.priority='urgent') DESC, (t.priority='high') DESC, t.due_at NULLS LAST LIMIT 40");
  if (!ts.length) return 'ما عندك مهام مفتوحة 👍';
  return '✅ **مهامك المفتوحة**\n' + ts.map(t => `${PRI[t.priority] || ''} #${t.id} ${t.title}${t.who ? ' ← ' + t.who : ''}${t.due_at ? ' | ' + U.fmt(t.due_at) : ''}${t.status === 'doing' ? ' ▶️' : t.status === 'blocked' ? ' ⛔' : ''}${t.due_at && new Date(t.due_at) < new Date() ? ' ⚠️' : ''}`).join('\n');
}

async function money() {
  const r = await T().money_report.handler({});
  const L = [`💰 **فلوسك هالشهر** (${r.period.from} ← ${r.period.to})`,
    `• الدخل: ${U.money(r.income)}`, `• المصروف: ${U.money(r.spent)}`, `• الصافي: **${U.money(r.net)}**`, `• التزامات شهرية ثابتة: ${U.money(r.monthly_commitments)}`];
  if (r.by_category.length) L.push('\n**حسب التصنيف**', ...r.by_category.map(c => `• ${c.category}: ${U.money(c.spent)}${c.budget ? ` / ${U.money(c.budget)} ${c.over ? '🔴' : Number(c.spent) > c.budget * 0.8 ? '🟠' : '🟢'}` : ''}`));
  const acc = Object.entries(r.accounts || {});
  if (acc.length) L.push('\n**الأرصدة (من رسائل البنك)**', ...acc.map(([k, v]) => `• ${k}: ${U.money(v.balance)} (${U.fmt(v.at)})`));
  if (r.bills_next_14_days.length) L.push('\n**فواتير خلال أسبوعين**', ...r.bills_next_14_days.map(b => `• ${b.name}: ${b.amount ? U.money(b.amount) : '—'} (${b.days_left} يوم)`));
  return L.join('\n');
}

async function shop() {
  const items = await db.many('SELECT id, item, qty, store, category FROM shopping WHERE NOT done ORDER BY category, id');
  if (!items.length) return '🛒 قائمة المقاضي فاضية';
  const groups = {};
  for (const i of items) (groups[i.category || 'أخرى'] = groups[i.category || 'أخرى'] || []).push(i);
  return '🛒 **قائمة المقاضي**\n' + Object.entries(groups).map(([g, list]) => `\n**${g}**\n` + list.map(i => `• ${i.item}${i.qty ? ' × ' + i.qty : ''}${i.store ? ' (' + i.store + ')' : ''}`).join('\n')).join('\n');
}

async function bills() {
  const r = await T().list_bills.handler({});
  if (!r.bills.length) return '🧾 ما فيه فواتير أو اشتراكات مسجلة. قل لي مثلاً: «فاتورة الجوال 230 ريال كل شهر يوم 5»';
  return `🧾 **فواتيرك واشتراكاتك** (التزام شهري ≈ ${U.money(r.monthly_commitments)})\n` + r.bills.map(b => `• ${b.name}: ${b.amount ? U.money(b.amount) : '—'} / ${({ monthly: 'شهري', yearly: 'سنوي', quarterly: 'ربعي', weekly: 'أسبوعي', once: 'مرة' })[b.cycle] || b.cycle}${b.next_due ? ' — بعد ' + b.days_left + ' يوم' : ''}${b.autopay ? ' (تلقائي)' : ''}`).join('\n');
}

async function approvals() {
  const aps = await db.many("SELECT id, summary FROM approvals WHERE status='pending' ORDER BY id LIMIT 20");
  if (!aps.length) return 'ما فيه موافقات معلقة ✅';
  return '🟡 **تنتظر موافقتك**\n\n' + aps.map(a => `#${a.id}\n${String(a.summary).slice(0, 500)}`).join('\n\n———\n\n') + '\n\nرد بـ: موافق رقم / رفض رقم / عدل رقم النص';
}

async function evening() {
  const start = U.parseLocal(U.riyadhDay() + 'T00:00');
  const tomorrow = new Date(new Date(start).getTime() + 86400e3).toISOString(), after = new Date(new Date(start).getTime() + 2 * 86400e3).toISOString();
  const done = await db.many("SELECT title FROM tasks WHERE done_at >= $1", [start]);
  const spent = await db.one('SELECT coalesce(sum(amount),0) AS s, count(*) AS n FROM expenses WHERE date = $1', [U.riyadhDay()]);
  const appts = await db.many('SELECT title, at FROM appointments WHERE at >= $1 AND at < $2 ORDER BY at', [tomorrow, after]);
  const rem = await db.many('SELECT text, at FROM reminders WHERE NOT done AND at >= $1 AND at < $2 ORDER BY at', [tomorrow, after]);
  const W = require('./world'), G = require('./google'), city = ((await db.getSettings()).profile || {}).city || 'الرياض';
  const [wx, gcal, sched] = await Promise.all([safe(W.weather(city, 2)), safe(G.calendarEvents({ from: tomorrow, to: after })),
    db.many("SELECT recipient, name, at FROM scheduled_messages WHERE status='pending' AND at >= $1 AND at < $2 ORDER BY at", [tomorrow, after]).catch(() => [])]);
  const L = ['🌙 **ملخص يومك**'];
  L.push(done.length ? `✅ أنجزت ${done.length} مهمة: ${done.map(d => d.title).slice(0, 6).join('، ')}` : '✅ ما سجلت مهام منجزة اليوم');
  L.push(`💸 صرفت اليوم ${U.money(spent.s)} (${spent.n} عملية)`);
  const seen = new Set(appts.map(a => a.title.trim()));
  const tmr = [...appts.map(a => `• ${U.fmt(a.at).slice(11)} ${a.title}`), ...(gcal || []).filter(e => !seen.has(e.title.trim())).map(e => `• ${e.start.includes('T') ? hm(e.start) : 'طول اليوم'} ${e.title}`),
    ...rem.map(r => `• ⏰ ${U.fmt(r.at).slice(11)} ${r.text}`), ...sched.map(m => `• 📤 ${hm(m.at)} رسالة إلى ${m.name || m.recipient}`)];
  L.push('\n📅 **بكرة**', tmr.length ? tmr.join('\n') : '• ما فيه شي مسجل');
  if (wx && wx.days[1]) { const d = wx.days[1]; L.push(`🌡️ طقس بكرة في ${wx.city}: ${d.max}°/${d.min}° — ${d.sky}${d.rain_chance ? ` | مطر ${d.rain_chance}%` : ''}`); }
  L.push('\nتصبح على خير 🌙');
  return L.join('\n');
}

const cityOf = async () => ((await db.getSettings()).profile || {}).city || 'الرياض';

async function weather() {
  const w = await require('./world').weather(await cityOf(), 3);
  return `🌤️ **الطقس في ${w.city}**\nالحين: **${w.now.temp}°** (يحس ${w.now.feels_like}°) — ${w.now.sky}\nالرطوبة ${w.now.humidity}% | الرياح ${w.now.wind_kmh} كم/س\n\n` +
    w.days.map((d, i) => `${i === 0 ? '**اليوم**' : i === 1 ? '**بكرة**' : '**' + d.day + '**'}: ${d.max}° / ${d.min}° — ${d.sky}${d.rain_chance ? ` | مطر ${d.rain_chance}%` : ''}${d.uv >= 8 && i === 0 ? ' | ☀️ أشعة قوية' : ''}`).join('\n') +
    '\n\n💬 لمدينة ثانية: «وش الطقس في جدة بكرة؟»';
}

async function prayer() {
  const W = require('./world'), city = await cityOf();
  const [p, nx] = await Promise.all([W.prayerTimes(city), W.nextPrayer(city).catch(() => null)]);
  return `🕌 **مواقيت الصلاة — ${p.city}**\n${p.hijri}\n\n` + Object.entries(p.times).map(([n, t]) => `${nx && nx.name === n ? '👉 ' : '• '}${n}: **${t}**`).join('\n') +
    (nx ? `\n\nالصلاة الجاية: **${nx.name}** الساعة ${nx.time}` : '') + '\n(تقويم أم القرى)';
}

async function hijri() {
  const d = require('./world').convertDate({ gregorian: U.riyadhDay() });
  return `🗓️ **اليوم ${d.day}**\n• هجري: **${d.hijri}**\n• ميلادي: **${d.gregorian}**\n\n💬 للتحويل: «كم يوافق 1 رمضان 1448؟»`;
}

async function emails() {
  let r;
  try { r = await require('./google').gmailSearch({ query: 'is:unread newer_than:3d -category:promotions -category:social', max: 12 }); }
  catch (e) { return '📧 ما قدرت أفتح Gmail: ' + e.message; }
  if (!r.count) return '📧 ما عندك إيميلات غير مقروءة (آخر ٣ أيام) ✅';
  return `📧 **إيميلات ما قريتها (آخر ٣ أيام): ${r.count}${r.count >= 12 ? '+' : ''}**\n\n` +
    r.emails.map((e, i) => `**${i + 1}. ${String(e.from).replace(/<.*>/, '').replace(/"/g, '').trim() || e.from}**\n${e.subject || '(بدون عنوان)'}\n_${String(e.snippet || '').slice(0, 110)}_`).join('\n\n').replace(/_([^_]+)_/g, '$1') +
    '\n\n💬 «لخص لي إيميل 1» أو «رد على إيميل 2 وقل...» أو «أرشف إيميلات العروض»';
}

async function calendar() {
  const start = new Date().toISOString(), end = new Date(Date.now() + 7 * 864e5).toISOString();
  const [local, g] = await Promise.all([
    db.many('SELECT title, at, location FROM appointments WHERE at >= $1 AND at < $2 ORDER BY at', [start, end]),
    safe(require('./google').calendarEvents({ from: start, to: end, max: 50 }))
  ]);
  const seen = new Set(), items = [];
  for (const a of local) { seen.add(a.title.trim() + '|' + U.fmt(a.at)); items.push({ t: a.at, title: a.title, loc: a.location }); }
  for (const e of g || []) { const t = e.start.includes('T') ? e.start : e.start + 'T00:00:00+03:00'; const k = e.title.trim() + '|' + U.fmt(t); if (!seen.has(k)) { seen.add(k); items.push({ t, title: e.title, loc: e.location, allDay: !e.start.includes('T') }); } }
  if (!items.length) return '📅 ما عندك مواعيد خلال الأسبوع الجاي' + (g ? '' : ' (تقويم Google غير مربوط)') + '\n\n💬 «عندي موعد ... يوم ... الساعة ...»';
  items.sort((a, b) => new Date(a.t) - new Date(b.t));
  const days = {};
  for (const i of items) { const d = U.fmt(i.t).slice(0, 10); (days[d] = days[d] || []).push(i); }
  const DN = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  return '📅 **مواعيدك للأسبوع الجاي**\n' + Object.entries(days).map(([d, list]) => `\n**${d === U.riyadhDay() ? 'اليوم' : DN[new Date(d + 'T12:00:00Z').getUTCDay()]} ${d.slice(5)}**\n` +
    list.map(i => `• ${i.allDay ? 'طول اليوم' : hm(i.t)} — ${i.title}${i.loc ? ' 📍' + i.loc : ''}`).join('\n')).join('\n') + '\n\n💬 «متى أنا فاضي بكرة؟»';
}

async function scheduled() {
  const ms = await db.many("SELECT id, channel, recipient, name, text, at, repeat, status, error FROM scheduled_messages WHERE status IN ('pending','failed') ORDER BY at LIMIT 30").catch(() => []);
  if (!ms.length) return '📤 ما فيه رسائل مجدولة.\n\n💬 «أرسل لـ 05xxxxxxxx الساعة 8 الصبح: ...»';
  return '📤 **الرسائل المجدولة**\n\n' + ms.map(m => `**#${m.id}** ${m.status === 'failed' ? '⚠️ فشلت' : '⏳'} ${U.fmt(m.at)}${m.repeat && m.repeat !== 'none' ? ' 🔁 ' + m.repeat : ''}\n${m.channel === 'email' ? '📧' : '💬'} إلى ${m.name || m.recipient}\n«${String(m.text).slice(0, 120)}»${m.error ? '\nالسبب: ' + m.error : ''}`).join('\n\n') + '\n\n💬 «ألغ الرسالة رقم ...»';
}

async function watched() {
  const w = Object.values(await require('./watch').all());
  if (!w.length) return '👀 ما فيه أرقام تحت المراقبة.\n\n💬 «راقب 05xxxxxxxx وبلغني إذا رد»';
  return '👀 **أرقام أوصّلك ردودها**\n\n' + w.map(x => `• ${x.name || x.phone}${x.name ? ' (' + x.phone + ')' : ''} — لين ${String(x.until).slice(0, 10)}${x.note ? '\n  📝 ' + x.note : ''}`).join('\n') + '\n\n💬 «وقف مراقبة 05xxxxxxxx»';
}

async function payments() {
  const list = await db.many("SELECT * FROM purchases WHERE status='awaiting_payment' ORDER BY id DESC LIMIT 15").catch(() => []);
  const paid = await db.many("SELECT id, title, amount, currency, paid_at, confirmation FROM purchases WHERE status='paid' ORDER BY paid_at DESC LIMIT 5").catch(() => []);
  if (!list.length && !paid.length) return '💳 ما فيه طلبات دفع.\n\n💬 «احجز لي رحلة لجدة الخميس» وأجهزها لك بضغطة';
  const L = [];
  if (list.length) L.push('💳 **تنتظر دفعك**\n' + list.map(p => `• **#${p.id}** ${p.title}${p.amount ? ' — ' + U.money(p.amount) + ' ' + (p.currency === 'SAR' ? 'ريال' : p.currency) : ''}\n${p.link || ''}`).join('\n\n') + '\n\nبعد الدفع ما تحتاج تسوي شي، أو اكتب «دفعت رقم»');
  if (paid.length) L.push('✅ **آخر المدفوعات**\n' + paid.map(p => `• #${p.id} ${p.title}${p.confirmation ? ' — 🔖 ' + p.confirmation : ''} (${U.fmt(p.paid_at).slice(0, 10)})`).join('\n'));
  return L.join('\n\n');
}

async function routines() {
  const rs = await db.many('SELECT id, title, at, repeat, active, last_run FROM routines ORDER BY active DESC, at LIMIT 30').catch(() => []);
  if (!rs.length) return '🔁 ما عندك مهام متكررة.\n\n💬 «كل يوم 8 الصبح أرسل لي أهم الأخبار»';
  const R = { daily: 'يومي', weekdays: 'أيام الدوام', weekly: 'أسبوعي', monthly: 'شهري' };
  return '🔁 **مهامك الذكية المتكررة**\n\n' + rs.map(r => `**#${r.id}** ${r.active ? '' : '⏸️ '}${r.title}\n${R[r.repeat] || r.repeat} — الجاية: ${U.fmt(r.at)}${r.last_run ? ' | آخر مرة: ' + U.fmt(r.last_run) : ''}`).join('\n\n') + '\n\n💬 «احذف المهمة رقم ...» أو «شغّل المهمة رقم ... الحين»';
}

async function docs() {
  const [rs, fs] = await Promise.all([
    db.many('SELECT id, kind, title, token, created_at FROM reports ORDER BY id DESC LIMIT 10').catch(() => []),
    db.many("SELECT name, token, created_at FROM files WHERE source='agent' AND data IS NOT NULL ORDER BY id DESC LIMIT 10").catch(() => [])]);
  if (!rs.length && !fs.length) return '📄 ما جهزت لك مستندات للحين.\n\n💬 «سوّ لي تقرير عن ...» أو «سوّ لي ملف Excel لـ ...» أو «سوّ عرض بوربوينت عن ...»';
  const L = [];
  if (fs.length) L.push('📎 **الملفات (Excel / PowerPoint / Word / PDF)**\n\n' + fs.map(f => `• **${f.name}** (${U.fmt(f.created_at).slice(0, 10)})\n${C.PUBLIC_URL}/f/${f.token}`).join('\n\n'));
  if (rs.length) L.push('📄 **التقارير والمستندات**\n\n' + rs.map(r => `• **${r.title}** (${U.fmt(r.created_at).slice(0, 10)})\n${C.PUBLIC_URL}/r/${r.token}`).join('\n\n'));
  return L.join('\n\n');
}
async function meds() {
  const ms = await T().list_medications.handler({}).catch(() => []);
  if (!ms.length) return '💊 ما فيه أدوية مسجلة.\n\n💬 «عندي دواء ... حبة الساعة 9 الصبح، العلبة فيها 30»';
  return '💊 **الأدوية**\n\n' + ms.map(m => `• **${m.name}**${m.dose ? ' (' + m.dose + ')' : ''}${m.for_whom && m.for_whom !== 'أنا' ? ' — ' + m.for_whom : ''}\n  ⏰ ${m.times.join(' · ')}${m.with_food ? ' · ' + m.with_food : ''}${m.days_left !== null ? `\n  📦 يكفي ${m.days_left} يوم${m.days_left <= 5 ? ' ⚠️' : ''}` : ''}`).join('\n\n');
}
async function portfolio() {
  const n = await db.one('SELECT count(*) AS n FROM holdings').catch(() => ({ n: 0 }));
  if (!Number(n.n)) return '📈 محفظتك فاضية.\n\n💬 «عندي 100 سهم أرامكو بمتوسط 27» أو «كم سعر الراجحي؟»';
  const p = await require('./life').portfolio();
  const f = v => v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return '📈 **محفظتك الحين**\n\n' + p.holdings.map(h => h.error ? `• ${h.symbol}: ⚠️ ما قدرت أجيب السعر` :
    `• **${h.name}** (${h.symbol})\n  ${f(h.qty)} × ${f(h.price)} = **${f(h.value)} ${h.currency || ''}**${h.day_pct !== null ? ` | اليوم ${h.day_pct > 0 ? '🟢 +' : h.day_pct < 0 ? '🔴 ' : ''}${h.day_pct}%` : ''}${h.pnl !== null ? `\n  الربح/الخسارة: ${h.pnl >= 0 ? '🟢 +' : '🔴 '}${f(h.pnl)} (${h.pnl_pct}%)` : ''}`).join('\n\n') +
    (p.total_sar ? `\n\n💰 **إجمالي (بالريال): ${f(p.total_sar)}**` : '');
}
async function assets() {
  const as = await T().list_assets.handler({}).catch(() => []);
  if (!as.length) return '🚗 ما سجلت ممتلكات.\n\n💬 «عندي كامري 2022 العداد 45000» أو «اشتريت مكيف ضمانه 5 سنين»';
  const I = { car: '🚗', home: '🏠', device: '📱', other: '📦' };
  return '🚗 **ممتلكاتك والصيانة**\n\n' + as.map(a => `${I[a.type] || '📦'} **${a.name}**${a.odometer ? ' — ' + a.odometer + ' كم' : ''}${a.warranty_days_left !== null ? (a.warranty_days_left >= 0 ? `\n  🛡️ الضمان باقي ${a.warranty_days_left} يوم` : '\n  🛡️ الضمان منتهي') : ''}` +
    a.maintenance.map(m => `\n  🔧 ${m.task}: ${m.next_due || ''}${m.km_due ? (m.next_due ? ' أو ' : '') + m.km_due + ' كم' : ''}`).join('')).join('\n\n');
}

const watches = () => require('./pricewatch').quick();

// فحص شامل لحالة كل أجزاء النظام
async function status() {
  const os = require('os'), fs = require('fs'), ch = require('./channels');
  const t = (p, ms = 4000) => Promise.race([p, new Promise(r => setTimeout(() => r('timeout'), ms))]).catch(e => 'ERR ' + e.message);
  const [dbOk, wa, g, vLocal, n8nOk, tgInfo, brOk, aiOk] = await Promise.all([
    t(db.one('SELECT 1 AS ok').then(() => true)),
    t(ch.evoStatus()),
    t(require('./google').status()),
    t(require('./voice').localReady()),
    t(fetch((process.env.N8N_WEBHOOK_URL || '').replace(/\/webhook\/.*$/, '') + '/healthz', { signal: AbortSignal.timeout(3000) }).then(r => r.ok).catch(() => false)),
    t(ch.tgEnabled() ? ch.tg('getWebhookInfo', {}) : Promise.resolve(null)),
    t(require('./web').ready(), 9000),
    t(fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/models?limit=1', { headers: { 'x-api-key': C.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? true : 'HTTP ' + r.status).catch(e => String((e.cause && e.cause.code) || e.message).slice(0, 60)), 7000)
  ]);
  const s = await db.getSettings();
  const ok = v => v === true ? '✅' : '❌';
  let build = ''; try { build = fs.readFileSync(require('path').join(__dirname, '..', '.build'), 'utf8').trim(); } catch (_) {}
  const mem = os.totalmem(), free = os.freemem(), load = os.loadavg()[0];
  let disk = ''; try { const st = fs.statfsSync('/'); disk = Math.round(st.bavail * st.bsize / 1e9) + ' GB فاضية'; } catch (_) {}
  const counts = await db.one(`SELECT (SELECT count(*) FROM reminders WHERE NOT done) AS rem, (SELECT count(*) FROM scheduled_messages WHERE status='pending') AS sched,
    (SELECT count(*) FROM price_watches WHERE active) AS watch, (SELECT count(*) FROM routines WHERE active) AS rout, (SELECT count(*) FROM medications WHERE active) AS meds`).catch(() => ({}));
  const L = ['🩺 **حالة النظام**', ''];
  const H = require('./health');
  L.push(`${aiOk === true && !H.isCreditOut() ? '✅' : '❌'} الذكاء الاصطناعي (Anthropic)${aiOk !== true ? ' — ' + (aiOk === 'HTTP 401' ? 'المفتاح غلط' : aiOk) : H.isCreditOut() ? ' — الرصيد خالص، اشحن من console.anthropic.com' : ''} | 🧠 ${H.MODE_NAME[s.ai_mode] || H.MODE_NAME.balanced}`);
  L.push(`${ok(dbOk)} قاعدة البيانات`);
  L.push(`${wa && wa.connected ? '✅' : '❌'} واتساب السكرتير${wa && wa.state ? ' (' + wa.state + ')' : ''}`);
  L.push(`${ch.tgEnabled() ? (await ch.ownerTelegramId() ? '✅' : '⚠️') : '❌'} تيليجرام${tgInfo && tgInfo.last_error_message ? ' — آخر خطأ: ' + tgInfo.last_error_message.slice(0, 60) : ''}`);
  L.push(`${g && g.gmail ? '✅' : '❌'} Gmail | ${g && g.calendar ? '✅' : '❌'} تقويم Google`);
  L.push(`${vLocal === true ? '✅' : (process.env.GROQ_API_KEY || s.groq_key) ? '✅' : process.env.WHISPER_URL ? '⏳' : '❌'} الرسائل الصوتية${vLocal === true ? ' (على السيرفر)' : (process.env.GROQ_API_KEY || s.groq_key) ? ' (Groq)' : process.env.WHISPER_URL ? ' (المحرك لسا يتجهز)' : ''}`);
  L.push(`${brOk === true ? '✅' : '❌'} المتصفح (الحجز وتعبئة النماذج في المواقع)${brOk === true ? '' : process.env.BROWSER_WS ? ' — ' + (typeof brOk === 'string' ? brOk : 'ما رد') : ' — غير مفعّل'}`);
  const ph = await require('./phone').status().catch(() => ({}));
  if (ph.configured) L.push(`${ph.connected ? '✅' : '❌'} جوالك (عبر الماك)${ph.connected ? '' : ' — الجسر مو متصل' + (ph.last_seen ? ' (آخر اتصال ' + U.fmt(ph.last_seen).slice(5) + ')' : '') + ': تأكد الماك شغال ونافذة الجسر مفتوحة'}`);
  L.push(`${ok(n8nOk)} n8n`);
  L.push('', `⚙️ آخر تحديث للسكرتير: ${build ? U.fmt(build) : '—'}`, `⏱️ شغال من: ${Math.round(process.uptime() / 3600 * 10) / 10} ساعة`,
    `🧠 الذاكرة: ${Math.round((mem - free) / 1e9 * 10) / 10}/${Math.round(mem / 1e9 * 10) / 10} GB | الضغط: ${load.toFixed(2)}${disk ? ' | 💾 ' + disk : ''}`,
    '', `📌 تذكيرات: ${counts.rem || 0} | رسائل مجدولة: ${counts.sched || 0} | متابعات أسعار: ${counts.watch || 0} | مهام متكررة: ${counts.rout || 0} | أدوية: ${counts.meds || 0}`);
  const [tt, pend] = await Promise.all([H.totals().catch(() => null), db.one("SELECT count(*) AS n FROM pending_requests WHERE status IN ('pending','running')").catch(() => ({ n: 0 }))]);
  if (tt) L.push(`💰 استهلاك الذكاء الاصطناعي: اليوم $${tt.today.toFixed(2)} | الشهر $${tt.month.toFixed(2)}${Number(s.monthly_budget) ? ` من $${s.monthly_budget}` : ''} (اكتب «الاستهلاك» للتفاصيل)`);
  if (Number(pend.n)) L.push(`⏳ طلبات محفوظة تنتظر التنفيذ: ${pend.n}`);
  const fails = await db.many("SELECT text, at FROM activity WHERE type IN ('voice','notify','error') AND at > now() - interval '2 days' ORDER BY id DESC LIMIT 4").catch(() => []);
  if (fails.length) L.push('', '🧾 **آخر مشاكل:**', ...fails.map(f => `• ${U.fmt(f.at).slice(5)} ${f.text.slice(0, 100)}`));
  return L.join('\n');
}

const usage = () => require('./health').usageReport();

module.exports = { usage, status, watches, docs, meds, portfolio, assets, routines, payments, today, tasks, money, shop, bills, approvals, evening, weather, prayer, hijri, emails, calendar, scheduled, watched };
