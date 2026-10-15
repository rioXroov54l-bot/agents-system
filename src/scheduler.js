// المجدول: يشتغل كل دقيقة — تذكيرات، فواتير، وثائق، مناسبات، موجزات ومراجعات
const db = require('./db');
const ch = require('./channels');
const U = require('./util');
const quick = require('./quick');

let agents;
const A = () => (agents = agents || require('./agents'));
let busy = false;

async function onceToday(key) {
  const day = U.riyadhDay();
  const r = await db.one("SELECT value FROM settings WHERE key='sched'");
  const sched = (r && r.value && typeof r.value === 'object') ? r.value : {};
  if (sched[key] === day) return false;
  sched[key] = day;
  await db.setSetting('sched', sched);
  return true;
}

// الموعد التالي لتذكير متكرر
function nextAt(iso, repeat) {
  const d = new Date(iso);
  const step = () => {
    if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else if (repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else if (repeat === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
    else if (repeat === 'weekdays') { do { d.setUTCDate(d.getUTCDate() + 1); } while ([5, 6].includes(U.riyadh(d).getUTCDay())); }
    else return false;
    return true;
  };
  do { if (!step()) return null; } while (d <= new Date());
  return d.toISOString();
}

async function tick() {
  if (busy) return; busy = true;
  try {
    const s = await db.getSettings();
    const hour = U.riyadhHour();
    const dow = U.riyadh().getUTCDay(); // 0 = الأحد
    const { T } = require('./tools');

    // 0-ب) المهام المتكررة، متابعة اللي ما ردوا، تنبيه الصلاة
    await require('./extras').tick(s).catch(e => console.error('extras', e.message));

    // 0-أ) إيميلات تأكيد الدفع (كل 5 دقايق إذا فيه طلبات دفع مفتوحة)
    await require('./pay').scanConfirmations().catch(e => console.error('pay scan', e.message));

    // 0) الرسائل المجدولة (واتساب/إيميل) في وقتها بالضبط
    for (const m of await db.many("SELECT * FROM scheduled_messages WHERE status='pending' AND at <= now() ORDER BY at LIMIT 20")) {
      const claimed = await db.one("UPDATE scheduled_messages SET status='sending' WHERE id=$1 AND status='pending' RETURNING id", [m.id]);
      if (!claimed) continue;
      try {
        const { executors } = require('./tools');
        if (m.channel === 'email') await executors.send_email({ to: m.recipient, subject: m.subject || '—', body: m.text, agent: 'scheduler' });
        else await executors.send_whatsapp({ phone: m.recipient, text: m.text });
        const next = m.repeat && m.repeat !== 'none' ? nextAt(m.at, m.repeat) : null;
        if (next) await db.q("UPDATE scheduled_messages SET status='pending', at=$2, sent_at=now() WHERE id=$1", [m.id, next]);
        else await db.q("UPDATE scheduled_messages SET status='sent', sent_at=now() WHERE id=$1", [m.id]);
        await ch.notifyOwner(`📤 **انرسلت الرسالة المجدولة #${m.id}** ${m.channel === 'email' ? 'بالإيميل' : 'على واتساب'} إلى ${m.name ? m.name + ' ' : ''}(${m.recipient}) الساعة ${U.fmt(new Date()).slice(11)}\n\n«${String(m.text).slice(0, 300)}»${m.channel === 'email' ? '' : '\n\nوأي رد منه بيوصلك هنا 📩'}`);
      } catch (e) {
        await db.q("UPDATE scheduled_messages SET status='failed', error=$2 WHERE id=$1", [m.id, e.message.slice(0, 300)]);
        await ch.notifyOwner(`⚠️ **ما قدرت أرسل الرسالة المجدولة #${m.id}** إلى ${m.recipient}\nالسبب: ${e.message.slice(0, 200)}`);
      }
    }

    // 1) تذكير المواعيد قبل ساعة
    for (const a of await db.many("SELECT * FROM appointments WHERE NOT reminded AND at > now() AND at <= now() + interval '60 minutes'")) {
      await db.q('UPDATE appointments SET reminded=true WHERE id=$1', [a.id]);
      await ch.notifyOwner(`⏰ **بعد أقل من ساعة**\n${a.title}\n🕐 ${U.fmt(a.at)}${a.location ? '\n📍 ' + a.location : ''}${a.notes ? '\n📝 ' + a.notes : ''}`);
    }

    // 2) التذكيرات (مع التكرار)
    for (const x of await db.many('SELECT * FROM reminders WHERE NOT done AND at <= now() ORDER BY at LIMIT 30')) {
      const next = x.repeat && x.repeat !== 'none' ? nextAt(x.at, x.repeat) : null;
      if (next) await db.q('UPDATE reminders SET at=$2 WHERE id=$1', [x.id, next]);
      else await db.q('UPDATE reminders SET done=true WHERE id=$1', [x.id]);
      await ch.notifyOwner(`⏰ **تذكير:** ${x.text}`);
    }

    // 3) مهام قرب موعدها (قبل ساعتين)
    for (const t of await db.many(`SELECT t.*, m.telegram_id, m.email FROM tasks t LEFT JOIN members m ON m.id=t.assignee_id
      WHERE t.status IN ('todo','doing') AND t.due_at IS NOT NULL AND t.due_at <= now() + interval '2 hours' AND t.due_at > now() AND t.reminded_at IS NULL`)) {
      await db.q('UPDATE tasks SET reminded_at=now() WHERE id=$1', [t.id]);
      const msg = `⏳ **تذكير مهمة #${t.id}**\n${t.title}\nالموعد: ${U.fmt(t.due_at)}`;
      if (t.assignee_id) await ch.notifyMember({ telegram_id: t.telegram_id, email: t.email }, msg, { buttons: [[{ text: '✅ خلصت', callback_data: `tk:${t.id}:done` }]] });
      else await ch.notifyOwner(msg, { buttons: [[{ text: '✅ خلصت', callback_data: `tk:${t.id}:done` }]] });
    }

    // 4) مرة يومياً 9 الصبح: الفواتير، الوثائق، المناسبات
    if (hour >= 9 && await onceToday('daily_checks')) {
      await db.dailyBackup().catch(e => console.error('backup', e.message));
      // الفواتير: قبل 3 أيام ويوم الاستحقاق والمتأخرة
      for (const b of (await T.list_bills.handler({ due_within_days: 3 })).bills) {
        const today = U.riyadhDay();
        const r = await db.one('SELECT reminded_for FROM bills WHERE id=$1', [b.id]);
        if (r.reminded_for && String(r.reminded_for).slice(0, 10) === today) continue;
        if (![3, 1, 0].includes(b.days_left) && !(b.days_left < 0 && b.days_left % 3 === 0)) continue;
        await db.q('UPDATE bills SET reminded_for=$2 WHERE id=$1', [b.id, today]);
        const when = b.days_left === 0 ? 'اليوم' : b.days_left < 0 ? `متأخرة ${-b.days_left} يوم ⚠️` : `بعد ${b.days_left} يوم`;
        await ch.notifyOwner(`🧾 **${b.name}** ${b.amount ? U.money(b.amount) + ' ريال ' : ''}— ${when}${b.autopay ? ' (يُخصم تلقائياً، تأكد من الرصيد)' : ''}`,
          b.autopay ? {} : { buttons: [[{ text: '✅ سددتها', callback_data: `bl:${b.id}:paid` }]] });
      }
      // الوثائق: قبل 60/30/14/7/1 يوم ويوم الانتهاء
      for (const d of await T.list_documents.handler({})) {
        if (d.days_left === null) continue;
        const step = [60, 30, 14, 7, 1, 0].find(n => d.days_left <= n && d.days_left > ({ 60: 30, 30: 14, 14: 7, 7: 1, 1: 0, 0: -9999 })[n]);
        if (step === undefined) continue;
        const row = await db.one('SELECT reminded FROM documents WHERE id=$1', [d.id]);
        const sent = Array.isArray(row.reminded) ? row.reminded : [];
        if (sent.includes(step)) continue;
        await db.q('UPDATE documents SET reminded=$2 WHERE id=$1', [d.id, JSON.stringify([...sent, step])]);
        await ch.notifyOwner(`🪪 **${d.name}**${d.holder ? ' (' + d.holder + ')' : ''} ${d.days_left < 0 ? 'انتهت!' : d.days_left === 0 ? 'تنتهي اليوم!' : 'تنتهي بعد ' + d.days_left + ' يوم'} — ${U.fmtDay(d.expires_on)}${d.notes ? '\n📝 ' + d.notes : ''}\nتبيني أجهز لك خطوات التجديد؟`);
      }
      // المناسبات: قبل 7 أيام، قبل يوم، ويومها
      for (const o of await T.upcoming_occasions.handler({ days: 7 })) {
        if (![7, 1, 0].includes(o.days_left)) continue;
        const key = `${o.date}:${o.days_left}`;
        const row = await db.one('SELECT notified FROM occasions WHERE id=$1', [o.id]);
        const sent = Array.isArray(row.notified) ? row.notified : [];
        if (sent.includes(key)) continue;
        await db.q('UPDATE occasions SET notified=$2 WHERE id=$1', [o.id, JSON.stringify([...sent.slice(-10), key])]);
        const label = o.type === 'birthday' ? 'عيد ميلاد' : o.type === 'anniversary' ? 'ذكرى' : 'مناسبة';
        if (o.days_left === 0) { const full = await db.one('SELECT phone FROM occasions WHERE id=$1', [o.id]).catch(() => null); await require('./extras').occasionGreeting({ ...o, phone: full && full.phone }).catch(e => console.error('greeting', e.message)); }
        else await ch.notifyOwner(`🎂 **${label} ${o.person}** بعد ${o.days_left} ${o.days_left === 1 ? 'يوم (بكرة!)' : 'أيام'}${o.notes ? '\n💡 ' + o.notes : ''}\nتبيني أقترح هدايا وأماكن؟`);
      }
    }

    // 5) الموجز الصباحي
    if (hour === Number(s.morning_hour) && await onceToday('morning')) await ch.notifyOwner(await quick.today());

    // 6) ملخص المساء
    if (hour === Number(s.report_hour) && await onceToday('evening')) await ch.notifyOwner(await quick.evening());

    // 7) المراجعة الأسبوعية
    const wr = s.weekly_review || { day: 6, hour: 20 };
    if (dow === Number(wr.day) && hour === Number(wr.hour) && await onceToday('weekly_review')) {
      const report = await A().runSpecialist('planner', 'سوّ المراجعة الأسبوعية للمالك: وش انجز هالأسبوع (list_tasks status=done)، وش تأخر، تقدم أهدافه (list_goals)، فلوسه هالأسبوع مقارنة بميزانيته (استخدم notify_owner فقط إذا فيه خطر)، وجدول الأسبوع الجاي (agenda 7 أيام). اختم بأهم 3 أولويات مقترحة. لا تنشئ مهام جديدة بدون سبب واضح.').catch(e => 'تعذر: ' + e.message);
      await ch.notifyOwner('📈 **مراجعتك الأسبوعية**\n' + report);
    }

    // 8) أول الشهر: تقرير مالي شهري
    if (U.riyadh().getUTCDate() === 1 && hour === 10 && await onceToday('monthly_money')) {
      const prev = new Date(U.riyadh().getTime() - 2 * 86400e3);
      const from = prev.toISOString().slice(0, 8) + '01', to = prev.toISOString().slice(0, 10);
      const report = await A().runSpecialist('money', `اكتب تقرير الشهر الماضي (${from} إلى ${to}) بـ money_report: الدخل، المصروف، أكبر التصنيفات مقابل الميزانية، الاشتراكات اللي ممكن يستغني عنها، و3 نصائح توفير عملية بالأرقام.`).catch(e => 'تعذر: ' + e.message);
      await ch.notifyOwner('📊 **تقرير فلوسك الشهري**\n' + report);
    }
  } catch (e) {
    console.error('scheduler', e.message);
  } finally { busy = false; }
}

async function dailyReport() { return quick.evening(); }

function start() {
  setTimeout(tick, 15000);
  setInterval(tick, 60 * 1000);
}

module.exports = { start, tick, dailyReport, nextAt };
