// ملخصات فورية بدون ذكاء اصطناعي (سريعة ومجانية)
const db = require('./db');
const U = require('./util');

const PRI = { urgent: '🔴', high: '🟠', normal: '🔵', low: '⚪' };
const T = () => require('./tools').T;

async function today() {
  const start = U.parseLocal(U.riyadhDay() + 'T00:00'), end = new Date(new Date(start).getTime() + 86400e3).toISOString();
  const appts = await db.many('SELECT title, at, location FROM appointments WHERE at >= $1 AND at < $2 ORDER BY at', [start, end]);
  const rem = await db.many('SELECT text, at, repeat FROM reminders WHERE NOT done AND at >= $1 AND at < $2 ORDER BY at', [start, end]);
  const tasks = await db.many("SELECT t.id, t.title, t.due_at, t.priority, m.name AS who FROM tasks t LEFT JOIN members m ON m.id=t.assignee_id WHERE t.status<>'done' AND t.due_at < $1 ORDER BY t.due_at", [end]);
  const bills = (await T().list_bills.handler({ due_within_days: 7 })).bills;
  const docs = (await T().list_documents.handler({})).filter(d => d.days_left !== null && d.days_left <= 60);
  const occ = await T().upcoming_occasions.handler({ days: 14 });
  const trips = await db.many("SELECT title, depart_at FROM trips WHERE status IN ('booked','options_ready','planning') AND depart_at BETWEEN now() AND now() + interval '14 days' ORDER BY depart_at");
  const shop = await db.one('SELECT count(*) AS n FROM shopping WHERE NOT done');
  const ap = await db.one("SELECT count(*) AS n FROM approvals WHERE status='pending'");
  const goals = await T().list_goals.handler({}).catch(() => []);

  const L = [`☀️ **صباح الخير — ${U.riyadhNow().replace(' (توقيت الرياض)', '')}**`];
  L.push('\n📅 **مواعيد اليوم**', appts.length ? appts.map(a => `• ${U.fmt(a.at).slice(11)} — ${a.title}${a.location ? ' 📍' + a.location : ''}`).join('\n') : '• يومك فاضي من المواعيد');
  if (rem.length) L.push('\n⏰ **تذكيرات اليوم**', rem.map(r => `• ${U.fmt(r.at).slice(11)} ${r.text}`).join('\n'));
  if (tasks.length) L.push('\n✅ **مهام مستحقة**', tasks.slice(0, 10).map(t => `• ${PRI[t.priority] || ''} ${t.title}${t.who ? ' ← ' + t.who : ''}${new Date(t.due_at) < new Date() ? ' ⚠️ متأخرة' : ''}`).join('\n'));
  if (bills.length) L.push('\n🧾 **فواتير قريبة**', bills.map(b => `• ${b.name}${b.amount ? ' ' + U.money(b.amount) : ''} — ${b.days_left === 0 ? 'اليوم' : b.days_left < 0 ? 'متأخرة ' + (-b.days_left) + ' يوم' : 'بعد ' + b.days_left + ' يوم'}${b.autopay ? ' (تلقائي)' : ''}`).join('\n'));
  if (docs.length) L.push('\n🪪 **وثائق قربت تنتهي**', docs.map(d => `• ${d.name}${d.holder ? ' (' + d.holder + ')' : ''} — ${d.days_left < 0 ? 'منتهية!' : 'باقي ' + d.days_left + ' يوم'}`).join('\n'));
  if (occ.length) L.push('\n🎂 **مناسبات قريبة**', occ.map(o => `• ${o.person}: ${o.type === 'birthday' ? 'عيد ميلاد' : o.type === 'anniversary' ? 'ذكرى' : 'مناسبة'}${o.age ? ' (' + o.age + ')' : ''} — ${o.days_left === 0 ? 'اليوم 🎉' : 'بعد ' + o.days_left + ' يوم'}`).join('\n'));
  if (trips.length) L.push('\n✈️ **سفر قريب**', trips.map(t => `• ${t.title} — ${U.fmt(t.depart_at)}`).join('\n'));
  if (goals.length) L.push('\n🎯 **أهدافك**', goals.slice(0, 5).map(g => `• ${g.title}: ${g.progress}${g.target ? '/' + g.target : ''} ${g.unit || ''}${g.pct !== null ? ' (' + g.pct + '%)' : ''}`).join('\n'));
  const extra = [];
  if (Number(shop.n)) extra.push(`🛒 ${shop.n} غرض بقائمة المقاضي`);
  if (Number(ap.n)) extra.push(`🟡 ${ap.n} موافقة تنتظرك`);
  if (extra.length) L.push('\n' + extra.join(' | '));
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
  const L = ['🌙 **ملخص يومك**'];
  L.push(done.length ? `✅ أنجزت ${done.length} مهمة: ${done.map(d => d.title).slice(0, 6).join('، ')}` : '✅ ما سجلت مهام منجزة اليوم');
  L.push(`💸 صرفت اليوم ${U.money(spent.s)} (${spent.n} عملية)`);
  L.push('\n📅 **بكرة**', appts.length || rem.length ? [...appts.map(a => `• ${U.fmt(a.at).slice(11)} ${a.title}`), ...rem.map(r => `• ⏰ ${U.fmt(r.at).slice(11)} ${r.text}`)].join('\n') : '• ما فيه شي مسجل');
  return L.join('\n');
}

module.exports = { today, tasks, money, shop, bills, approvals, evening };
