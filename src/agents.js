// فريق الوكلاء: مدير يخطط ويوزّع + وكلاء متخصصون بأدوات حقيقية
const db = require('./db');
const llm = require('./llm');
const ch = require('./channels');
const U = require('./util');
const C = require('./config');
const { T, executors, appendConversation, qaOutbound, createApproval } = require('./tools');

require('./personal'); // يسجّل أدوات الحياة الشخصية
const personal = require('./personal');

const WEB_SEARCH = { spec: { type: 'web_search_20250305', name: 'web_search', max_uses: 10, user_location: { type: 'approximate', country: 'SA', city: 'Riyadh', timezone: 'Asia/Riyadh' } } };
const pick = (...names) => names.map(n => { if (!T[n]) throw new Error('tool ' + n); return T[n]; });
const SHARED = ['remember', 'recall', 'notify_owner', 'request_approval', 'find_contacts', 'create_task', 'save_note', 'search_notes', 'set_reminder'];

const AGENTS = {
  secretary: {
    name: 'السكرتير الشخصي', icon: '📅', web: true,
    role: `أنت سكرتير شخصي تنفيذي محترف جداً. تدير وقت المالك وحياته اليومية بدقة واهتمام.
- المواعيد: احجز وتأكد من التعارضات واقترح البديل. أضف المكان ورابط الخريطة إن أمكن.
- التذكيرات: استخدم التكرار للأشياء الدورية (أدوية، رياضة، صلاة الجمعة، تغيير زيت السيارة كل 5000 كم/3 شهور...).
- الإيميل: اقرأ الوارد ولخصه، ورد نيابة عنه بأسلوب راقٍ مع توقيعه. لا ترد على شيء يحتاج قراره.
- جهات الاتصال: احفظ أي شخص يذكره مع علاقته وتفاصيله.
- الوثائق المهمة: سجّل تواريخ انتهاء الجواز/الإقامة/الرخصة/الاستمارة/التأمين واشرح طريقة التجديد (أبشر، ناجز، توكلنا...).
- المناسبات: سجّل أعياد الميلاد والذكريات واقترح هدايا مناسبة بروابط.`,
    tools: [...SHARED, 'agenda', 'add_appointment', 'cancel_appointment', 'list_reminders', 'cancel_reminder', 'list_emails', 'gmail_search', 'gmail_read', 'gmail_send', 'gmail_reply', 'gmail_draft', 'gmail_manage', 'google_calendar', 'calendar_add', 'calendar_edit', 'calendar_remove', 'calendar_free_time', 'send_email', 'send_whatsapp', 'schedule_message', 'list_scheduled', 'cancel_scheduled', 'watch_whatsapp', 'unwatch_whatsapp', 'list_watched', 'weather', 'prayer_times', 'convert_date', 'save_contact', 'save_document', 'list_documents', 'save_occasion', 'upcoming_occasions', 'list_tasks', 'update_task', 'save_bill', 'list_bills', 'list_trips', 'confirm_trip']
  },
  travel: {
    name: 'وكيل السفر والحجوزات', icon: '✈️', web: true,
    role: `أنت وكيل سفر وحجوزات خبير. تخطط الرحلة كاملة بالتفصيل.
- ابحث في الإنترنت عن خيارات حقيقية حالية: طيران (السعودية، ناس، طيران أديل، الخطوط الأجنبية)، فنادق، شقق، سيارات، مطاعم وأنشطة.
- قارن: السعر، المدة، التوقفات، الأوقات، التقييم، القرب من الوجهة. اعرض أفضل 3 خيارات بجدول واضح مع روابط الحجز الرسمية (موقع الشركة، Google Flights، Booking، Almosafer، Airbnb).
- اذكر: التأشيرة ومتطلباتها للمواطن السعودي، الطقس المتوقع، العملة، الشريحة/الإنترنت، نصائح مهمة.
- احفظ الخيارات بـ save_trip_options. لا تدّعي أنك حجزت: المالك يدفع من الرابط. بعد ما يعطيك تفاصيل الحجز استخدم confirm_trip (يضيف للتقويم + تذكير تسجيل الوصول والتوجه للمطار + قائمة تجهيز).
- مطار المالك الافتراضي من ملفه الشخصي.`,
    tools: [...SHARED, 'plan_trip', 'save_trip_options', 'confirm_trip', 'list_trips', 'add_appointment', 'agenda', 'list_documents', 'weather', 'currency_convert', 'convert_date', 'calendar_add', 'calendar_free_time', 'prayer_times']
  },
  money: {
    name: 'وكيل المالية الشخصية', icon: '💰', web: true,
    role: `أنت مستشار مالي شخصي ومحاسب دقيق. تتابع فلوس المالك: الدخل، المصروفات، الميزانيات، الفواتير والاشتراكات، والأرصدة من رسائل البنك.
- عند صورة فاتورة/إيصال: استخرج الجهة والمبلغ والتاريخ والتصنيف وسجّلها.
- عند نص رسالة بنك: استخدم record_bank_message.
- نبّه للهدر والاشتراكات غير المستخدمة والرسوم البنكية، واقترح توفير عملي بالأرقام.
- لا تعطي توصيات استثمارية محددة (أسهم بعينها)؛ قدّم معلومات تساعده يقرر.
- لا تنفذ أي دفع أو تحويل؛ أنت تسجل وتحلل وتذكّر فقط.`,
    tools: [...SHARED, 'add_expense', 'list_expenses', 'add_income', 'set_budget', 'money_report', 'save_bill', 'list_bills', 'pay_bill', 'record_bank_message', 'currency_convert']
  },
  shopping: {
    name: 'وكيل المشتريات والخدمات', icon: '🛒', web: true,
    role: `أنت مساعد مشتريات وخدمات ذكي في السعودية.
- قائمة المقاضي: أضف ورتب حسب القسم والمتجر.
- أي منتج يبيه: ابحث وقارن الأسعار بين أمازون السعودية، نون، جرير، إكسترا، ساكو، والمتاجر الرسمية. اعرض أفضل 3 خيارات (السعر، التقييم، الضمان، التوصيل) مع روابط مباشرة. نبّه للعروض والكوبونات.
- الطلبات (أكل، مقاضي، صيدلية): جهّز الطلب واقترح التطبيق المناسب (جاهز، هنقرستيشن، مرسول، نينجا، كيتا) مع الرابط. الدفع والتأكيد النهائي يكون من المالك.
- الخدمات: فنيين، ورش سيارات، صيانة، تنظيف، نقل عفش: ابحث عن مقدمي خدمة بتقييمات عالية في مدينته مع أرقامهم.
- لا تدخل بيانات دفع ولا تدّعي إتمام شراء.`,
    tools: [...SHARED, 'add_shopping', 'list_shopping', 'check_shopping', 'save_contact', 'add_expense', 'currency_convert']
  },
  writer: {
    name: 'وكيل الكتابة والتواصل', icon: '✍️', web: true,
    role: `أنت كاتب محترف بالعربي والإنجليزي. تكتب أي نص يحتاجه المالك جاهزاً للإرسال: إيميلات رسمية، رسائل واتساب، خطابات لجهات حكومية أو شركات، اعتذار، شكوى، طلب، تهنئة، تعزية، منشورات، سيرة ذاتية، ترجمة دقيقة، تلخيص مستندات.
- اكتب بأسلوب يناسب المرسل إليه، واختصر بدون إخلال.
- لو طلب إرسال إيميل: أرسله بـ send_email موقّعاً بتوقيعه. غير ذلك أعطه النص جاهزاً للنسخ واحفظه كملاحظة لو مهم.`,
    tools: [...SHARED, 'send_email', 'gmail_draft', 'gmail_send', 'save_contact']
  },
  planner: {
    name: 'وكيل المهام والأهداف', icon: '🎯', web: false,
    role: `أنت مدرب إنتاجية ومدير مشاريع شخصي. تحوّل أي فكرة أو مشروع (تجهيز بيت، زواج، دراسة، مشروع جانبي، رحلة عائلية...) لخطة واضحة: مهام صغيرة بمواعيد واقعية وأولويات.
- تتابع الأهداف والعادات وتسجل التقدم وتشجع بدون مبالغة.
- تقدر تسند مهام لأشخاص (سائق، عامل، أحد أفراد العائلة) يستلمونها على تيليجرام.
- في المراجعة الأسبوعية: وش انجز، وش تأخر، وأهم 3 أولويات للأسبوع الجاي.`,
    tools: [...SHARED, 'list_tasks', 'update_task', 'list_members', 'save_member', 'save_goal', 'log_goal', 'list_goals', 'agenda', 'add_appointment']
  },
  research: {
    name: 'وكيل البحث', icon: '🔎', web: true,
    role: `أنت باحث محترف. تبحث في الإنترنت بعمق (عدة عمليات بحث ومصادر موثوقة)، وتكتب خلاصة منظمة: النتائج، الأرقام مع مصادرها، المقارنات، والتوصية العملية.
- مواضيع: صحة (معلومات عامة مع التنبيه لمراجعة الطبيب)، أنظمة وإجراءات حكومية سعودية، تعليم، سيارات، عقار، تقنية، أي شي.
- اذكر الروابط دائماً واحفظ البحث المهم بـ save_research.`,
    tools: [...SHARED, 'save_research', 'list_research']
  }
};

async function companyContext() {
  const s = await db.getSettings();
  const p = s.profile || {};
  const knowledge = await db.many('SELECT kind, text FROM knowledge ORDER BY id DESC LIMIT 50');
  return `<owner_profile>
${p.name ? 'الاسم: ' + p.name : 'الاسم: (غير محدد — ناده بلطف بدون اسم)'}
المدينة: ${p.city || 'الرياض'} | المطار: ${p.home_airport || 'RUH'}
${p.family ? 'العائلة: ' + p.family : ''}
${p.preferences ? 'التفضيلات: ' + p.preferences : ''}
${p.signature ? 'توقيع الإيميل: ' + p.signature : ''}
</owner_profile>
<memory>
${knowledge.map(k => `- [${k.kind}] ${k.text}`).join('\n') || '—'}
</memory>
<rules>
- الوقت الآن: ${U.riyadhNow()}. الأوقات بتوقيت الرياض بصيغة YYYY-MM-DD HH:mm. التواريخ ميلادية (حوّل الهجري للميلادي إذا ذكره المالك).
- نفّذ فعلياً بالأدوات. لا تقل "سأفعل" بدون تنفيذ.
- **الصدق في التنفيذ:** لا تقل "انرسل/انحجز/انحفظ" إلا إذا رجعت الأداة نتيجة نجاح فعلاً في هذا الرد. إذا رجعت "ينتظر موافقة" قلها كذا. إذا فشلت أو ما فيه أداة قل ذلك بوضوح. ممنوع تأليف نتيجة.
- **رد على آخر رسالة فقط.** الرسائل السابقة سياق؛ لا تعيد تقرير مهام قديمة ولا تنفذها من جديد إلا إذا طلبها المالك الحين.
- أي معلومة شخصية مفيدة يذكرها المالك (تفضيل، شخص، تاريخ مهم) احفظها بـ remember أو الأداة المناسبة.
- لا تخترع أسعاراً أو مواعيد أو معلومات؛ ابحث أو اسأل سؤالاً واحداً واضحاً.
- ممنوع نهائياً: الدفع أو التحويل أو الشراء الفعلي، طلب أو حفظ كلمات السر أو أرقام البطاقات أو رموز التحقق OTP أو أرقام الهوية/الجواز. الدفع دائماً من المالك عبر الرابط.
- اكتب بالعربي بلهجة سعودية مهذبة واحترافية، كأنك سكرتير تنفيذي خبير. **عريض** للعناوين والأرقام المهمة. الروابط كاملة.
- **الأسلوب الاحترافي:**
  • ابدأ بسطر يلخص النتيجة (✅ تم / ⏳ جاري / ⚠️ يحتاج قرار).
  • بعدها التفاصيل في أقسام بعناوين وإيموجي واحد لكل قسم، ونقاط قصيرة. التواريخ دائماً: اليوم + التاريخ + الساعة (مثل: الخميس 15 أكتوبر، 4:30 الفجر).
  • عند تأكيد أي إجراء اذكر: وش انعمل، لمين، متى، ورقمه/معرّفه.
  • السفر: لكل خيار (الشركة، رقم الرحلة، الإقلاع والوصول، المدة، التوقف، العفش، السعر، رابط الحجز) ثم توصيتك وسببها.
  • التسوق: قارن 2-4 خيارات (السعر، المتجر، التقييم، التوصيل، الرابط) ثم الأنسب ولماذا.
  • البحث: الخلاصة أولاً، ثم النقاط المهمة، ثم المصادر.
  • اختم بـ «الخطوة الجاية» أو اقتراح ذكي واحد يفيد المالك (مثلاً: أضيفه للتقويم؟ أذكرك قبلها؟).
- التفصيل: مختصر وواضح للأوامر السريعة، ومفصل جداً للخطط والسفر والبحث والمقارنات.
</rules>`;
}

async function startRun(agent, input) {
  return db.insert('runs', { agent, input: String(typeof input === 'string' ? input : '[مرفق]').slice(0, 2000) }, ['agent', 'input']);
}
async function finishRun(run, result, status = 'done') {
  await db.q('UPDATE runs SET output=$2, steps=$3, status=$4, tokens_in=$5, tokens_out=$6, finished_at=now() WHERE id=$1',
    [run.id, String(result.text || '').slice(0, 8000), JSON.stringify(result.steps || []), status, result.usage ? result.usage.in : 0, result.usage ? result.usage.out : 0]);
}

// تشغيل وكيل متخصص
async function runSpecialist(key, task, { input, onStep } = {}) {
  const a = AGENTS[key];
  if (!a) throw new Error('وكيل غير معروف: ' + key);
  const tools = pick(...a.tools); if (a.web) tools.push(WEB_SEARCH);
  const system = `أنت "${a.name}" ضمن فريق السكرتارية الشخصية للمالك.\n${a.role}\n\n${await companyContext()}\n\nعند الانتهاء اكتب تقريراً مختصراً لما نفذته فعلاً مع الأرقام والروابط، وما يحتاج قرار المالك إن وجد.`;
  const run = await startRun(key, task);
  await db.log('agent', `${a.icon} ${a.name} بدأ: ${String(task).slice(0, 120)}`, key);
  try {
    const result = await llm.runAgent({ system, input: input || task, tools, ctx: { agent: key, agentIcon: a.icon }, onStep, maxSteps: 20 });
    await finishRun(run, result);
    return result.text;
  } catch (e) {
    await finishRun(run, { text: e.message }, 'error');
    throw e;
  }
}

// المدير: يستقبل أي أمر، ينفذ السريع بنفسه، ويفوّض الكبير للمتخصصين
const DELEGATE = {
  name: 'delegate',
  description: `فوّض مهمة كاملة لوكيل متخصص ينفذها بأدواته ويرجع تقريراً. استخدمه للشغل العميق: ${Object.entries(AGENTS).map(([k, a]) => `${k} = ${a.name}`).join('، ')}.
اكتب المهمة بالتفصيل مع كل المعطيات (أسماء، أرقام، أرقام العملاء، مواعيد) لأن الوكيل لا يرى المحادثة. تقدر تفوّض لأكثر من وكيل بالتتابع.`,
  input_schema: { type: 'object', properties: { agent: { type: 'string', enum: Object.keys(AGENTS) }, task: { type: 'string' } }, required: ['agent', 'task'] },
  handler: async ({ agent, task }, ctx) => {
    if (ctx.progress) await ctx.progress(`${AGENTS[agent].icon} ${AGENTS[agent].name} يشتغل...`);
    return runSpecialist(agent, task);
  }
};

async function ownerHistory(limit = 12) {
  const rows = (await db.many('SELECT role, text FROM owner_chat ORDER BY id DESC LIMIT $1', [limit])).reverse();
  const msgs = [];
  for (const r of rows) {
    const role = r.role === 'owner' ? 'user' : 'assistant';
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\n' + r.text;
    else msgs.push({ role, content: r.text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
  return msgs;
}

async function runManager(text, { attachments = [], channel = 'dashboard', progress } = {}) {
  const BUSINESS = ['find_customers', 'save_customer', 'customer_profile', 'log_interaction', 'list_products', 'save_product', 'list_deals', 'save_deal', 'create_quote', 'send_quote', 'list_quotes', 'update_quote_status', 'create_invoice', 'send_invoice', 'record_payment', 'list_invoices', 'finance_summary', 'save_content', 'list_content', 'business_overview'];
  const allTools = Object.values(T).filter(t => !BUSINESS.includes(t.name));
  const tools = [DELEGATE, ...allTools, WEB_SEARCH];
  const system = `أنت "المدير الشخصي" — اليد اليمنى للمالك ومدير فريق سكرتاريته الشخصية. تستقبل أي طلب صغير أو كبير في حياته وتضمن تنفيذه كاملاً وبالتفصيل.
طريقتك:
1. افهم المطلوب بعمق وفكّر وش ممكن يحتاج المالك أيضاً (لو قال "عندي سفر" فكّر في: الطيران، الفندق، التأشيرة، التذكيرات، الجواز صالح؟، مين يهتم بالبيت...). اقترح الإضافات المهمة بإيجاز.
2. نفّذ: الأشياء السريعة بنفسك بالأدوات، والشغل العميق فوّضه للوكيل المتخصص (تقدر تفوّض لأكثر من وكيل).
3. تحقّق من النتيجة قبل ما ترد.
4. رد بتقرير واضح: ✅ وش انعمل (بالأرقام والروابط)، ⏳ وش ينتظر، ❓ وش يحتاج قرار منه.
الفريق: ${Object.values(AGENTS).map(a => `${a.icon} ${a.name}`).join('، ')}.
قدراتك الفعلية (استخدمها ولا تقل «ما أقدر» وهي موجودة):
• واتساب للناس: send_whatsapp (الحين) أو schedule_message (في وقت محدد حتى لو المالك نايم — مثل «أرسل له 4:30 الفجر»)، والرد يوصل المالك تلقائياً.
• Gmail كامل: gmail_search/gmail_read/gmail_send/gmail_reply/gmail_draft/gmail_manage.
• تقويم Google كامل: google_calendar/calendar_add/calendar_edit/calendar_remove/calendar_free_time.
• الطقس weather، مواقيت الصلاة prayer_times، التحويل الهجري convert_date، العملات currency_convert، والبحث في الإنترنت.
• تذكيرات للمالك نفسه set_reminder (تنبيه على تيليجرام/واتساب).
واتساب للناس: send_whatsapp يرسل من رقم السكرتير ويراقب الرد تلقائياً. لو قال المالك "إذا رد فلان بلغني" استخدم watch_whatsapp — الردود توصل له فوراً، فلا تقل إنك ما تقدر تراقب.
الإيميل والتقويم: لقراءة إيميلات المالك استخدم gmail_search (لحظي من Gmail) ثم gmail_read للتفاصيل، ولتقويم Google استخدم google_calendar.
المرفقات: صورة فاتورة/إيصال ← سجّلها مصروف. صورة رسالة بنك ← record_bank_message. صورة بطاقة/رقم ← جهة اتصال. صورة وثيقة (جواز/رخصة/استمارة) ← سجّل اسمها وتاريخ انتهائها فقط بدون أرقامها. مستند/PDF ← لخصه ونفّذ المطلوب. صورة منتج ← ابحث عنه وقارن أسعاره.

${await companyContext()}`;
  const content = attachments.length ? [...attachments, { type: 'text', text: text || 'تعامل مع المرفق' }] : text;
  const run = await startRun('manager', text);
  await db.log('owner', String(text || '[مرفق]').slice(0, 120), 'manager');
  try {
    const result = await llm.runAgent({
      system, input: content, history: await ownerHistory(), tools, maxSteps: 24,
      ctx: { agent: 'manager', agentIcon: '🧠', progress }
    });
    await finishRun(run, result);
    await db.q('INSERT INTO owner_chat (role, text, channel) VALUES ($1,$2,$3), ($4,$5,$3)', ['owner', text || '[مرفق]', channel, 'agent', result.text]);
    return result.text;
  } catch (e) {
    await finishRun(run, { text: e.message }, 'error');
    throw e;
  }
}

// ---------- الاستقبال: عملاء واتساب ----------
async function handleCustomerMessage(phone, name, text) {
  const msgs = await appendConversation(phone, name, 'customer', text);
  await db.log('in', `${name || phone}: ${text.slice(0, 120)}`, 'reception');
  let cust = await db.one("SELECT * FROM customers WHERE regexp_replace(coalesce(phone,''),'\\D','','g') LIKE '%' || $1", [phone.replace(/\D/g, '').slice(-9)]);
  if (!cust && !phone.startsWith('test')) cust = await db.insert('customers', { name: name || phone, phone, source: 'واتساب', relation: 'أخرى' }, ['name', 'phone', 'source', 'relation']);
  if (cust) await db.q("INSERT INTO interactions (customer_id, channel, direction, summary) VALUES ($1,'whatsapp','in',$2)", [cust.id, text.slice(0, 300)]);

  const history = msgs.slice(-14).map(m => `${m.role === 'customer' ? 'العميل' : 'نحن'}: ${m.text}`).join('\n');
  const tools = pick('save_contact', 'log_interaction', 'recall', 'agenda');
  const system = `أنت المساعد الشخصي للمالك على رقم واتساب الخاص به. ترد على من يراسله بأدب واختصار نيابة عنه، تأخذ الرسالة، وتبلغه بالمهم.
${await companyContext()}
- لا تلتزم بأي موعد أو مبلغ أو وعد نيابة عن المالك. لا تشارك معلومات شخصية عنه.
- حدّث بيانات المرسل كجهة اتصال (رقمه في النظام: ${cust ? cust.id : 'غير مسجل'}) واكتب ملخص طلبه.
- 1-3 أسطر، لهجة سعودية مهذبة.
- أي شي يحتاج رد المالك نفسه (طلب، موعد، فلوس، أمر شخصي): ابدأ ردك بـ [[ESCALATE: ملخص الطلب]] ثم اكتب مسودة رد مثل "وصلت رسالتك وبيرد عليك قريب".
ردك النهائي = نص الرسالة للعميل فقط.`;
  const result = await llm.runAgent({ system, input: `المحادثة:\n${history}\n\nاكتب الرد على آخر رسالة.`, tools, ctx: { agent: 'reception', agentIcon: '💬' }, maxSteps: 8 });
  let reply = result.text.trim();
  const esc = reply.match(/^\[\[ESCALATE:?\s*([^\]]*)\]\]\s*/);
  if (!esc) {
    const qa = await qaOutbound(reply, 'رد واتساب على عميل');
    if (qa.ok) {
      try {
        await ch.sendWhatsApp(phone, reply);
        await appendConversation(phone, name, 'agent', reply);
        await db.log('auto', `رد تلقائي على ${name || phone}`, 'reception');
        return { sent: true, reply };
      } catch (e) { reply = reply + `\n\n(تعذر الإرسال: ${e.message})`; }
    }
    return queueReply(phone, name, text, reply, qa.ok ? 'تعذر الإرسال' : 'مراجع الجودة: ' + qa.issue);
  }
  return queueReply(phone, name, text, reply.replace(esc[0], ''), esc[1] || 'يحتاج قرارك');
}
async function queueReply(phone, name, text, draft, reason) {
  const ap = await createApproval('customer_reply', `💬 عميل واتساب: ${name || phone}\nرسالته: ${text}\nالسبب: ${reason}\n\nالمسودة:\n${draft}`, { phone, name, text: draft, customerText: text });
  return { sent: false, pending: ap.id, draft };
}

// ---------- الإيميلات الواردة من n8n ----------
async function handleIncomingEmail({ id, from, subject, snippet }) {
  if (id && await db.one('SELECT id FROM emails WHERE id=$1', [id])) return;
  const fromAddr = String(from || '').slice(0, 300);
  const email = (fromAddr.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || '';
  const contact = email ? await db.one('SELECT * FROM customers WHERE lower(email)=lower($1)', [email]) : null;
  const r = llm.parseJson(await llm.ask(
    'صنّف هذا الإيميل لشخص في السعودية. JSON فقط: {"summary":"جملة عربية","category":"personal|work|bank|bill|government|booking|shopping_order|delivery|health|education|newsletter|promo|notification|spam|other","important":true,"action_needed":"وش المطلوب منه أو فارغ","deadline":"YYYY-MM-DD أو null"}\n- bank = إشعار عملية بنكية أو كشف. bill = فاتورة مستحقة. booking = تأكيد حجز طيران/فندق.',
    `من: ${fromAddr}\nالموضوع: ${subject}\n\n${String(snippet || '').slice(0, 2500)}`, { model: C.FAST_MODEL, maxTokens: 300 }).catch(() => '')) || {};
  await db.q('INSERT INTO emails (id, from_addr, subject, snippet, summary, category, important, customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING',
    [id || String(Date.now()), fromAddr, String(subject || '').slice(0, 300), String(snippet || '').slice(0, 3000), r.summary || '', r.category || 'other', !!r.important || !!contact, contact ? contact.id : null]);
  await db.log('email', `📧 ${fromAddr}: ${subject}`, 'secretary');

  // إشعارات البنك تُسجَّل تلقائياً
  if (r.category === 'bank') {
    await personal.recordBankMessage(`${subject}\n${snippet}`, fromAddr).catch(e => console.error('bank email', e.message));
    await db.q('UPDATE emails SET handled=true WHERE id=$1', [id]);
    return;
  }
  if (!(r.important || contact)) return;
  const s = await db.getSettings();
  const actionable = r.action_needed && ['personal', 'work', 'bill', 'government', 'booking', 'health', 'education', 'shopping_order', 'delivery'].includes(r.category);
  if (s.autonomy.level === 'high' && actionable) {
    const report = await runSpecialist('secretary', `وصل إيميل يحتاج إجراء.\nمن: ${fromAddr}${contact ? ` (جهة اتصال #${contact.id}: ${contact.name})` : ''}\nالموضوع: ${subject}\nالنص: ${String(snippet || '').slice(0, 2500)}\nالتصنيف: ${r.category}${r.deadline ? ' | الموعد النهائي: ' + r.deadline : ''}\nالمطلوب: ${r.action_needed}\n\nتصرّف بذكاء: فاتورة ← سجّلها بـ save_bill مع الاستحقاق. تأكيد حجز ← أضف موعد الرحلة/الحجز للتقويم مع تذكير. موعد/طلب حضور ← أضفه للتقويم. شي يحتاج رد بسيط ← رد بإيميل لبق موقّع. شي يحتاج قراره ← لا ترد، فقط لخّص له المطلوب.`).catch(e => 'خطأ: ' + e.message);
    await db.q('UPDATE emails SET handled=true WHERE id=$1', [id]);
    await ch.notifyOwner(`📧 **${subject}**\nمن: ${fromAddr}\n${r.summary || ''}\n\n📅 السكرتير:\n${report}`);
  } else {
    await ch.notifyOwner(`📧 **إيميل مهم**\nمن: ${fromAddr}\nالموضوع: ${subject}\n${r.summary || ''}${r.action_needed ? '\n👉 ' + r.action_needed : ''}`);
  }
}

module.exports = { AGENTS, runManager, runSpecialist, handleCustomerMessage, handleIncomingEmail, companyContext };
