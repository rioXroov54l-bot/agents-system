// قدرات إضافية: المهام الذكية المتكررة، متابعة اللي ما ردوا، تنبيه الصلاة، تهاني المناسبات، تنظيف الإيميل
const db = require('./db');
const U = require('./util');
const C = require('./config');
const llm = require('./llm');
const ch = require('./channels');
const { T, executors, createApproval } = require('./tools');
const W = require('./watch');

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const int = d => ({ type: 'integer', description: d });
const bool = d => ({ type: 'boolean', description: d });
const def = (name, description, input_schema, handler) => { T[name] = { name, description, input_schema, handler }; };
let agents; const A = () => (agents = agents || require('./agents'));
const nextAt = (iso, repeat) => require('./scheduler').nextAt(iso, repeat);

// ================= 1) المهام الذكية المتكررة =================
// مثل: «كل يوم 8 الصبح أرسل لي أهم أخبار السعودية» أو «كل أحد شيك لي على سعر آيفون في أمازون»
async function addRoutine({ title, prompt, time, start, repeat = 'daily' }) {
  if (!prompt) throw new Error('لازم وش المطلوب');
  const n = await db.one('SELECT count(*) AS n FROM routines WHERE active');
  if (Number(n.n) >= 20) throw new Error('عندك 20 مهمة متكررة — احذف وحدة قبل');
  if (!['daily', 'weekdays', 'weekly', 'monthly'].includes(repeat)) repeat = 'daily';
  let at;
  if (start) at = U.parseLocal(start);
  else {
    const hm = String(time || '08:00').padStart(5, '0');
    at = U.parseLocal(`${U.riyadhDay()} ${hm}`);
    if (new Date(at) <= new Date()) at = nextAt(at, repeat === 'weekly' || repeat === 'monthly' ? 'daily' : repeat);
  }
  if (!at) throw new Error('الوقت غير صحيح');
  const r = await db.insert('routines', { title: title || prompt.slice(0, 60), prompt, at, repeat }, ['title', 'prompt', 'at', 'repeat']);
  await db.log('routine', `🔁 مهمة متكررة #${r.id}: ${r.title}`);
  return `✅ المهمة المتكررة #${r.id} «${r.title}» بتشتغل ${({ daily: 'كل يوم', weekdays: 'أيام الدوام', weekly: 'كل أسبوع', monthly: 'كل شهر' })[repeat]} — أول مرة ${U.fmt(at)}، وأرسل لك النتيجة.`;
}
async function runRoutine(r) {
  const out = await A().runManager(`${r.prompt}\n\n(هذي مهمة متكررة طلبها المالك مسبقاً بعنوان «${r.title}». نفّذها الحين واكتب النتيجة مباشرة ومختصرة ومفيدة.)`, { channel: 'routine', isolated: true });
  await db.q('UPDATE routines SET last_run=now(), last_result=$2 WHERE id=$1', [r.id, String(out).slice(0, 4000)]);
  await ch.notifyOwner(`🔁 **${r.title}**\n\n${out}`);
  return out;
}
async function tickRoutines() {
  for (const r of await db.many('SELECT * FROM routines WHERE active AND at <= now() ORDER BY at LIMIT 5').catch(() => [])) {
    const claimed = await db.one('UPDATE routines SET at=$2 WHERE id=$1 AND at=$3 RETURNING id', [r.id, nextAt(r.at, r.repeat), r.at]);
    if (!claimed) continue;
    runRoutine(r).catch(e => { console.error('routine', e.message); ch.notifyOwner(`⚠️ المهمة المتكررة «${r.title}» ما زبطت: ${e.message.slice(0, 150)}`).catch(() => {}); });
  }
}
def('add_routine', 'مهمة ذكية متكررة: السكرتير ينفذ طلب في وقت ثابت كل يوم/أسبوع/شهر ويرسل النتيجة للمالك. (لمتابعة سعر أو توفر منتج استخدم watch_price بدلها). أمثلة: أهم الأخبار كل صباح، سعر منتج كل أسبوع، ملخص إيميلات العمل كل مساء، أسعار الذهب يومياً، مباريات فريقه.',
  S({ title: str('عنوان قصير'), prompt: str('وش المطلوب ينفذه بالتفصيل كل مرة'), time: str('الساعة HH:mm (بتوقيت الرياض)'), start: str('أول تشغيل YYYY-MM-DD HH:mm (للأسبوعي/الشهري في يوم معين)'), repeat: str('daily | weekdays | weekly | monthly') }, ['prompt']),
  async (a) => addRoutine(a));
def('list_routines', 'المهام الذكية المتكررة.', S({}),
  async () => (await db.many('SELECT id, title, prompt, at, repeat, active, last_run FROM routines ORDER BY active DESC, at')).map(r => ({ ...r, next: U.fmt(r.at), last_run: r.last_run ? U.fmt(r.last_run) : null })));
def('remove_routine', 'احذف أو أوقف مهمة متكررة.', S({ id: int('رقمها'), pause_only: bool('إيقاف مؤقت بدل الحذف') }, ['id']),
  async ({ id, pause_only }) => {
    if (pause_only) { await db.q('UPDATE routines SET active=false WHERE id=$1', [id]); return `⏸️ أوقفت المهمة #${id}`; }
    const r = await db.one('DELETE FROM routines WHERE id=$1 RETURNING title', [id]); return r ? `🗑️ حذفت «${r.title}»` : 'ما لقيتها';
  });
def('run_routine_now', 'شغّل مهمة متكررة الحين (تجربة).', S({ id: int('رقمها') }, ['id']),
  async ({ id }) => { const r = await db.one('SELECT * FROM routines WHERE id=$1', [id]); if (!r) throw new Error('ما لقيتها'); return runRoutine(r); });

// ================= 2) متابعة اللي ما ردوا =================
const FU_HOURS = 24;
async function tickFollowups() {
  const h = U.riyadhHour();
  if (h < 9 || h >= 22) return; // ما نزعج بالليل
  const all = await W.all();
  for (const [k, w] of Object.entries(all)) {
    if (!w.last_out || (w.last_in && w.last_in > w.last_out)) continue;
    if (w.fu_for === w.last_out || (w.fu_count || 0) >= 2) continue;
    const hours = (Date.now() - new Date(w.last_out).getTime()) / 3600e3;
    if (hours < FU_HOURS) continue;
    await W.update(w.phone, { fu_for: w.last_out });
    const who = w.name || w.phone;
    const msg = `⏳ **${who} ما رد** على رسالتك من ${Math.round(hours)} ساعة:\n«${String(w.last_out_text || '').slice(0, 200)}»\n\nتبيني أذكره بلطف؟ (قل «ذكّره» أو اضغط الزر)`;
    await db.q("INSERT INTO owner_chat (role, text, channel) VALUES ('agent', $1, 'notify')", [msg.replace(/\*\*/g, '') + ` [الرقم: ${w.phone}]`]).catch(() => {});
    await ch.notifyOwner(msg, { buttons: [[{ text: '🔔 ذكّره', callback_data: `fu:${k}:send` }, { text: '✋ خلاص', callback_data: `fu:${k}:stop` }]] });
  }
}
async function sendFollowup(key) {
  const w = (await W.all())[key];
  if (!w) return 'ما لقيت المحادثة';
  const text = `السلام عليكم، حبيت أذكرك برسالتنا 🙏\n«${String(w.last_out_text || '').slice(0, 300)}»\nبانتظار ردك، وشكراً لك.`;
  await executors.send_whatsapp({ phone: w.phone, text });
  await W.update(w.phone, { fu_count: (w.fu_count || 0) + 1 });
  return `🔔 ذكّرت ${w.name || w.phone} ✅ وأي رد يوصلك فوراً`;
}

// ================= 3) تنبيه الصلاة =================
async function tickPrayer(s) {
  const mins = Number(s.prayer_alerts || 0);
  if (!mins) return;
  const city = (s.profile || {}).city || 'الرياض';
  const p = await require('./world').prayerTimes(city).catch(() => null);
  if (!p) return;
  const now = U.riyadh(), nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const [name, time] of Object.entries(p.times)) {
    if (name === 'الشروق' || !/^\d\d:\d\d$/.test(time)) continue;
    const [hh, mm] = time.split(':').map(Number), alertMin = hh * 60 + mm - mins;
    if (nowMin < alertMin || nowMin > alertMin + 4) continue;
    const r = await db.one("SELECT value FROM settings WHERE key='sched'");
    const sched = (r && r.value && typeof r.value === 'object') ? r.value : {};
    const k = 'pr_' + name;
    if (sched[k] === U.riyadhDay()) continue;
    sched[k] = U.riyadhDay(); await db.setSetting('sched', sched);
    await ch.notifyOwner(`🕌 باقي **${mins} دقايق** على صلاة **${name}** (${time})`);
  }
}

// ================= 4) تهاني المناسبات بموافقة بضغطة =================
async function greetingFor(o) {
  const contact = o.phone ? { phone: o.phone } : await db.one("SELECT name, phone, relation FROM customers WHERE phone IS NOT NULL AND (name ILIKE $1 OR $1 ILIKE '%' || name || '%') ORDER BY length(name) LIMIT 1", ['%' + o.person + '%']).catch(() => null);
  const s = await db.getSettings(), owner = (s.profile || {}).name || '';
  const label = o.type === 'birthday' ? 'عيد ميلاد' : o.type === 'anniversary' ? 'ذكرى' : 'مناسبة';
  const text = String(await llm.ask(`اكتب رسالة تهنئة واتساب قصيرة (2-3 أسطر) دافية وبلهجة سعودية مهذبة من ${owner || 'المرسل'} إلى ${o.person} بمناسبة ${label}${o.age ? ' (' + o.age + ')' : ''}. ${o.notes ? 'معلومة: ' + o.notes + '.' : ''} إيموجي أو اثنين. اكتب نص الرسالة فقط بدون توقيع آلي.`, 'اكتب التهنئة', { model: C.FAST_MODEL, maxTokens: 200 }).catch(() => '')).trim()
    || `كل عام وأنت بخير يا ${o.person} 🎉 الله يسعدك ويحقق لك كل اللي تتمناه.`;
  return { contact, text, label };
}
async function occasionGreeting(o) {
  const { contact, text, label } = await greetingFor(o);
  if (contact && contact.phone) {
    await createApproval('send_whatsapp', `🎉 اليوم ${label} ${o.person}! جهزت لك تهنئة ترسلها من رقم السكرتير باسمك إلى ${contact.phone}:\n\n${text}\n\n(وافق وأرسلها، أو «عدل» وغيّر النص، أو أرسلها أنت بنفسك من جوالك)`, { phone: contact.phone, text });
    return true;
  }
  await ch.notifyOwner(`🎉 **اليوم ${label} ${o.person}!**\nجهزت لك تهنئة، انسخها وأرسلها:\n\n${text}\n\n💡 إذا تعطيني رقمه أحفظه وأرسلها عنك المرة الجاية.`);
  return true;
}

// ================= 5) تنظيف الإيميل =================
def('gmail_cleanup', 'تنظيف جماعي للإيميل: يطبق إجراء على كل الإيميلات المطابقة (حتى 500). أمثلة: أرشفة العروض (category:promotions)، تعليم كل غير المقروء كمقروء (is:unread)، حذف إيميلات جهة معينة (from:x). الإجراءات: archive | read | trash | spam | star.',
  S({ query: str('صيغة بحث Gmail'), action: str('archive | read | trash | spam | star'), max: int('الحد (افتراضي 300)') }, ['query', 'action']),
  async (a, ctx = {}) => {
    if (!ctx.byOwner) throw new Error('التنظيف الجماعي بطلب المالك فقط');
    const r = await require('./google').gmailBulk(a);
    await db.log('email', `🧹 تنظيف: ${r.action} على ${r.count} إيميل (${a.query})`);
    return r;
  });

// ================= الإعدادات + أدوات المناسبات =================
def('set_prayer_alerts', 'تنبيه قبل كل صلاة بعدد دقائق (0 = إيقاف).', S({ minutes: int('كم دقيقة قبل الأذان (مثلاً 10)، 0 للإيقاف') }, ['minutes']),
  async ({ minutes }) => { const m = Math.max(0, Math.min(120, Number(minutes) || 0)); await db.setSetting('prayer_alerts', m); return m ? `✅ بنبهك قبل كل صلاة بـ ${m} دقايق 🕌` : '✅ وقفت تنبيه الصلاة'; });
def('greet_now', 'جهز تهنئة لمناسبة (عيد ميلاد/ذكرى/تخرج...) وأرسلها للمالك للموافقة بضغطة.', S({ person: str('الشخص'), type: str('birthday | anniversary | other'), phone: str('رقمه (اختياري)'), notes: str('معلومة تفيد التهنئة') }, ['person']),
  async (a) => { await occasionGreeting({ person: a.person, type: a.type || 'other', phone: a.phone, notes: a.notes }); return '✅ جهزت التهنئة ووصلت المالك للموافقة'; });

async function tick(s) {
  await tickRoutines();
  await tickFollowups().catch(e => console.error('followups', e.message));
  await tickPrayer(s).catch(e => console.error('prayer', e.message));
}

module.exports = { tick, addRoutine, runRoutine, sendFollowup, occasionGreeting, greetingFor };
