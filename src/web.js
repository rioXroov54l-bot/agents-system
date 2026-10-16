// وكيل التنفيذ على المواقع: متصفح حقيقي على السيرفر (خدمة browser) يفتح المواقع ويعبي النماذج ويحجز المواعيد نيابة عن المالك.
// الأمان: ما يدخل كلمات سر ولا بيانات بطاقات ولا يدفع، رموز CAPTCHA يكتبها المالك نفسه، رموز التحقق تُطلب منه وقتها وما تنحفظ،
// وما يقدر يفتح عناوين داخلية في السيرفر.
const C = require('./config');
const db = require('./db');
const ch = require('./channels');
const { T } = require('./tools');

let pw; const PW = () => (pw = pw || require('playwright-core'));
const WS = () => process.env.BROWSER_WS || '';
const enabled = () => !!WS();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// ---------- عناوين ممنوعة (خدمات السيرفر الداخلية) ----------
function isInternal(u) {
  let x; try { x = new URL(u); } catch (_) { return false; }
  if (!/^https?:$/.test(x.protocol)) return !/^(data|blob|about):$/.test(x.protocol);
  const h = x.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|lan|home|docker)$/.test(h)) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (h === '::1' || /^f[cd]/.test(h) || /^fe80/.test(h)) return true;
  if (C.PUBLIC_URL && h === (() => { try { return new URL(C.PUBLIC_URL).hostname; } catch (_) { return ''; } })()) return true;
  return false;
}

// ---------- سؤال المالك أثناء التنفيذ (رمز، اختيار، بيانات ناقصة) ----------
let pending = null;
function pendingAsk() {
  if (pending && Date.now() > pending.expires) { const p = pending; pending = null; p.resolve({ timeout: true }); }
  return pending;
}
// يرجع true إذا الرسالة كانت جواب لسؤال مفتوح (فما تروح للمدير)
function answer(text) {
  const p = pendingAsk();
  if (!p || !String(text || '').trim()) return false;
  pending = null; p.resolve({ text: String(text).trim() });
  return true;
}
async function sendOwner(channel, text) {
  if (channel === 'telegram' && ch.tgEnabled()) { const id = await ch.ownerTelegramId(); if (id) return ch.tgSend(id, text); }
  if (channel === 'whatsapp' && C.OWNER_PHONE) return ch.sendWhatsApp(C.OWNER_PHONE, text);
  return ch.notifyOwner(text);
}

// ---------- جلسة المتصفح (وحدة لكل مهمة، تنقفل في النهاية) ----------
async function session(ctx) {
  if (ctx.web) return ctx.web;
  if (!enabled()) throw new Error('المتصفح غير مفعّل على السيرفر (خدمة browser)');
  let browser;
  try { browser = await PW().chromium.connect(WS(), { timeout: 30000 }); }
  catch (e) {
    const why = browserError(e);
    await db.log('error', '🌐 المتصفح: ' + why).catch(() => {});
    throw new Error('خدمة المتصفح على السيرفر ما ردت — ' + why);
  }
  const context = await browser.newContext({ locale: 'ar-SA', timezoneId: 'Asia/Riyadh', viewport: { width: 1280, height: 900 }, userAgent: UA, acceptDownloads: false, ignoreHTTPSErrors: false });
  await context.route('**/*', r => isInternal(r.request().url()) ? r.abort('blockedbyclient') : r.continue());
  const s = { browser, context, page: await context.newPage(), dialogs: [], refs: new Map(), host: '' };
  const hook = p => {
    p.setDefaultTimeout(20000);
    p.on('dialog', d => { s.dialogs.push(d.message().slice(0, 300)); d.accept().catch(() => {}); });
  };
  hook(s.page);
  context.on('page', p => { hook(p); s.page = p; }); // نافذة جديدة ← نكمل فيها
  ctx.web = s;
  (ctx.cleanup = ctx.cleanup || []).push(() => browser.close().catch(() => {}));
  return s;
}
async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(400);
}

// يقرأ الصفحة: نص مختصر + كل العناصر التفاعلية بأرقام (حتى داخل الإطارات)
const SNAP = (max) => {
  const vis = el => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0'; };
  const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
  const labelOf = el => {
    let l = el.getAttribute('aria-label') || '';
    const by = el.getAttribute('aria-labelledby');
    if (!l && by) l = by.split(/\s+/).map(id => (document.getElementById(id) || {}).innerText || '').join(' ');
    if (!l && el.labels && el.labels.length) l = el.labels[0].innerText;
    if (!l && el.id) { const lb = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (lb) l = lb.innerText; }
    if (!l) l = el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (!l && /^(BUTTON|A)$/.test(el.tagName) || el.getAttribute('role')) l = l || el.innerText;
    if (!l && el.tagName === 'INPUT' && /^(submit|button)$/.test(el.type)) l = el.value;
    if (!l) { const img = el.querySelector && el.querySelector('img[alt]'); if (img) l = img.alt; }
    if (!l) l = el.getAttribute('name') || '';
    return clean(l).slice(0, 90);
  };
  document.querySelectorAll('[data-sk]').forEach(e => e.removeAttribute('data-sk'));
  const sel = 'input,select,textarea,button,a[href],[role=button],[role=link],[role=checkbox],[role=radio],[role=option],[role=tab],[role=menuitem],[role=combobox],[role=gridcell],[onclick],[contenteditable=true],td[data-date],.day,.ui-state-default';
  const forms = [], links = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (el.type === 'hidden') continue;
    const box = /^(checkbox|radio)$/.test(el.type);
    if (!vis(el) && !box) continue;
    n++; el.setAttribute('data-sk', String(n));
    const tag = el.tagName.toLowerCase();
    const it = { n, tag, label: labelOf(el) };
    if (el.type && tag === 'input') it.type = el.type;
    if (el.getAttribute('role')) it.role = el.getAttribute('role');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') it.disabled = true;
    if (tag === 'select') { it.options = [...el.options].slice(0, 60).map(o => clean(o.text)).filter(Boolean); it.value = el.selectedIndex >= 0 ? clean(el.options[el.selectedIndex].text) : ''; }
    else if (box) it.checked = !!el.checked;
    else if (/^(input|textarea)$/.test(tag) && el.type !== 'password') it.value = String(el.value || '').slice(0, 60);
    if (tag === 'a') it.href = (el.getAttribute('href') || '').slice(0, 80);
    if (/^(input|select|textarea)$/.test(tag) || it.role === 'combobox' || box) it.required = el.required || el.getAttribute('aria-required') === 'true' || undefined;
    const sig = `${tag} ${el.type || ''} ${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''} ${it.label}`.toLowerCase();
    if (el.type === 'password') it.secret = 'password';
    else if (/cc-|card.?num|cardnumber|cvv|cvc|security.?code|expir|بطاقة|رمز الأمان|تاريخ الانتهاء للبطاقة/.test(sig) && /^(input|select)$/.test(tag)) it.secret = 'card';
    (tag === 'a' && !it.role ? links : forms).push(it);
  }
  const caps = [...document.querySelectorAll('img,canvas')].filter(i => vis(i) && /captcha|verif|تحقق|security/i.test(`${i.id} ${i.className} ${i.getAttribute('src') || ''} ${i.alt || ''}`));
  caps.forEach(i => { n++; i.setAttribute('data-sk', String(n)); forms.push({ n, tag: 'img', label: 'صورة رمز التحقق (CAPTCHA)', captcha: true }); });
  const recaptcha = !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],.g-recaptcha,.h-captcha,.cf-turnstile');
  const text = clean(document.body ? document.body.innerText : '').slice(0, max);
  return { title: document.title, text, forms: forms.slice(0, 160), links: links.slice(0, 70), recaptcha };
};

async function snapshot(s, { max = 5000 } = {}) {
  const page = s.page;
  s.refs.clear();
  if (isInternal(page.url())) { await page.goto('about:blank').catch(() => {}); throw new Error('الموقع حوّلني لعنوان غير مسموح، فوقفت. أعطِ المالك الرابط ليكمل بنفسه.'); }
  const frames = page.frames().filter(f => f === page.mainFrame() || (f.url() && !/^about:/.test(f.url()) && !isInternal(f.url())));
  let out = { title: '', text: '', forms: [], links: [], recaptcha: false }, g = 0;
  for (const [fi, f] of frames.entries()) {
    const r = await f.evaluate(SNAP, fi === 0 ? max : 1500).catch(() => null);
    if (!r) continue;
    const map = it => { g++; s.refs.set(g, { frame: f, n: it.n, item: it }); return { ...it, n: g }; };
    if (fi === 0) { out.title = r.title; out.text = r.text; } else if (r.text) out.text += `\n[إطار ${fi}] ${r.text}`;
    out.forms.push(...r.forms.map(map)); out.links.push(...r.links.map(map)); out.recaptcha = out.recaptcha || r.recaptcha;
  }
  const url = page.url();
  try { s.host = new URL(url).hostname; } catch (_) {}
  const line = it => `[${it.n}] ${it.tag}${it.type ? '(' + it.type + ')' : ''}${it.role ? '{' + it.role + '}' : ''} «${it.label || '—'}»` +
    (it.options ? ` خيارات: ${it.options.join(' | ')}${it.value ? ` ← المختار: ${it.value}` : ''}` : '') +
    (it.value !== undefined && !it.options && it.value !== '' ? ` = "${it.value}"` : '') + (it.checked !== undefined ? (it.checked ? ' ☑' : ' ☐') : '') +
    (it.disabled ? ' (معطل)' : '') + (it.required ? ' *مطلوب' : '') + (it.secret === 'password' ? ' ⛔كلمة سر' : it.secret === 'card' ? ' ⛔بيانات بطاقة' : '') + (it.captcha ? ' 🧩' : '') + (it.href && !/^javascript|^#/.test(it.href) ? ` → ${it.href}` : '');
  const notes = [];
  if (s.dialogs.length) notes.push('💬 رسائل منبثقة: ' + s.dialogs.splice(0).join(' / '));
  if (out.forms.some(i => i.secret === 'card')) notes.push('⛔ هذي صفحة دفع/بطاقة: لا تعبي شي فيها — وقف وأرسل للمالك وش باقي.');
  if (out.forms.some(i => i.captcha)) notes.push('🧩 فيه رمز تحقق مصور: استخدم web_ask_owner مع show_ref رقم الصورة — المالك يكتبه.');
  if (out.recaptcha) notes.push('🤖 فيه تحقق «أنا لست روبوت» (reCAPTCHA/Turnstile): جرّب تكمل، وإذا منعك وقف وأعطِ المالك الرابط ليكمل الخطوة الأخيرة بنفسه.');
  return [`🌐 ${out.title || ''}\n🔗 ${url}`, notes.join('\n'), `📄 النص:\n${out.text}`,
    out.forms.length ? `🧾 الحقول والأزرار:\n${out.forms.map(line).join('\n')}` : '', out.links.length ? `🔗 روابط:\n${out.links.map(line).join('\n')}` : ''].filter(Boolean).join('\n\n');
}

function el(s, ref) {
  const r = s.refs.get(Number(ref));
  if (!r) throw new Error(`العنصر [${ref}] مو موجود — اقرأ الصفحة من جديد بـ web_read`);
  return { loc: r.frame.locator(`[data-sk="${r.n}"]`).first(), item: r.item };
}
function guard(item, what) {
  if (item.secret === 'password') throw new Error('ممنوع: ما أدخل كلمات سر نيابة عن المالك. وقف واطلب منه يسجل دخوله بنفسه أو أعطه الرابط والخطوات.');
  if (item.secret === 'card') throw new Error('ممنوع: ما أعبي بيانات بطاقات ولا أدفع. وقف وأعطِ المالك الرابط ليدفع بنفسه.');
  if (item.disabled && what !== 'read') throw new Error(`العنصر [${item.n}] معطل حالياً — غالباً لازم تختار شي قبله.`);
}
const shot = async (s, ref) => {
  if (ref) { const { loc } = el(s, ref); return loc.screenshot({ type: 'png', timeout: 10000 }); }
  return s.page.screenshot({ type: 'jpeg', quality: 60, timeout: 15000 });
};
const img = (buf, mime) => ({ type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } });
const maskDigits = t => String(t || '').replace(/\d(?=\d{2})/g, '•');

// ---------- الأدوات ----------
const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const num = d => ({ type: 'integer', description: d });
const ownerOnly = ctx => { if (!ctx.byOwner) throw new Error('المتصفح للمالك فقط'); };

T.web_open = { name: 'web_open', description: 'يفتح رابط في المتصفح ويرجع محتوى الصفحة وعناصرها المرقمة.', input_schema: S({ url: str('رابط كامل يبدأ بـ https://') }, ['url']),
  handler: async ({ url }, ctx) => {
    ownerOnly(ctx);
    if (!/^https?:\/\//i.test(url || '')) url = 'https://' + String(url || '').replace(/^\/+/, '');
    if (isInternal(url)) throw new Error('رابط غير مسموح');
    const s = await session(ctx);
    const r = await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => { throw new Error(/timeout/i.test(e.message) ? 'الموقع ما فتح (انتهى الوقت) — ممكن يكون حاجب الدخول من خارج السعودية أو واقف' : 'الموقع ما فتح: ' + e.message.split('\n')[0].slice(0, 160)); });
    await settle(s.page);
    const st = r ? r.status() : 0;
    return (st >= 400 ? `⚠️ الموقع رد بخطأ ${st}${st === 403 ? ' (غالباً حاجب الدخول من السيرفر)' : ''}\n\n` : '') + await snapshot(s);
  } };
T.web_read = { name: 'web_read', description: 'يقرأ الصفحة الحالية من جديد (النص والعناصر المرقمة). full=true لنص أطول.', input_schema: S({ full: { type: 'boolean' } }),
  handler: async ({ full }, ctx) => { ownerOnly(ctx); const s = await session(ctx); await settle(s.page); return snapshot(s, { max: full ? 15000 : 5000 }); } };
T.web_click = { name: 'web_click', description: 'يضغط على عنصر برقمه (زر، رابط، يوم في التقويم، خيار...). يرجع الصفحة بعد الضغط.', input_schema: S({ ref: num('رقم العنصر') }, ['ref']),
  handler: async ({ ref }, ctx) => {
    ownerOnly(ctx); const s = await session(ctx); const { loc, item } = el(s, ref); guard(item);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await loc.click({ timeout: 10000 }).catch(async e => { await loc.click({ timeout: 5000, force: true }).catch(() => { throw new Error('ما قدرت أضغط: ' + e.message.split('\n')[0].slice(0, 120)); }); });
    await settle(s.page);
    return snapshot(s);
  } };
T.web_type = { name: 'web_type', description: 'يكتب نص في حقل برقمه (يمسح القديم). enter=true يضغط Enter بعدها.', input_schema: S({ ref: num('رقم الحقل'), text: str('النص'), enter: { type: 'boolean' } }, ['ref', 'text']),
  redact: i => ({ ...i, text: maskDigits(i.text) }),
  handler: async ({ ref, text, enter }, ctx) => {
    ownerOnly(ctx); const s = await session(ctx); const { loc, item } = el(s, ref); guard(item);
    const v = String(text ?? '');
    await loc.fill(v, { timeout: 8000 }).catch(async () => { await loc.click({ timeout: 5000 }); await s.page.keyboard.press('Control+A').catch(() => {}); await s.page.keyboard.type(v, { delay: 40 }); });
    if (enter) { await loc.press('Enter').catch(() => {}); await settle(s.page); return snapshot(s); }
    const now = await loc.inputValue({ timeout: 3000 }).catch(() => null);
    return now === null || now === v ? `✓ انكتب في [${ref}] «${item.label}»` : `⚠️ الحقل [${ref}] صار فيه "${maskDigits(now)}" بدل المطلوب — تأكد من الصيغة (مثل 05xxxxxxxx أو تاريخ بصيغة معينة)`;
  } };
T.web_select = { name: 'web_select', description: 'يختار من قائمة منسدلة برقمها (بالنص الظاهر، تكفي كلمة منه). يرجع الصفحة بعد الاختيار.', input_schema: S({ ref: num('رقم القائمة'), option: str('نص الخيار') }, ['ref', 'option']),
  handler: async ({ ref, option }, ctx) => {
    ownerOnly(ctx); const s = await session(ctx); const { loc, item } = el(s, ref); guard(item);
    if (item.tag === 'select') {
      const opts = item.options || [];
      const want = String(option).trim();
      const hit = opts.find(o => o === want) || opts.find(o => o.includes(want)) || opts.find(o => want.includes(o) && o.length > 1);
      if (!hit) throw new Error(`ما لقيت «${want}» في الخيارات: ${opts.join(' | ')}`);
      await loc.selectOption({ label: hit }, { timeout: 8000 });
    } else { // قوائم مخصصة: نضغطها ثم نضغط الخيار بالنص
      await loc.click({ timeout: 8000 });
      await s.page.waitForTimeout(500);
      await s.page.getByText(String(option), { exact: false }).first().click({ timeout: 8000 });
    }
    await settle(s.page);
    return snapshot(s);
  } };
T.web_check = { name: 'web_check', description: 'يحدد أو يلغي تحديد مربع اختيار/دائرة برقمه (مثل الموافقة على الشروط).', input_schema: S({ ref: num('رقم المربع'), on: { type: 'boolean', description: 'افتراضي true' } }, ['ref']),
  handler: async ({ ref, on = true }, ctx) => {
    ownerOnly(ctx); const s = await session(ctx); const { loc, item } = el(s, ref); guard(item);
    await (on ? loc.check({ timeout: 8000, force: true }) : loc.uncheck({ timeout: 8000, force: true })).catch(() => loc.click({ force: true }));
    await settle(s.page);
    return `✓ [${ref}] ${on ? '☑' : '☐'}`;
  } };
T.web_back = { name: 'web_back', description: 'يرجع للصفحة السابقة.', input_schema: S({}),
  handler: async (_i, ctx) => { ownerOnly(ctx); const s = await session(ctx); await s.page.goBack({ timeout: 15000 }).catch(() => {}); await settle(s.page); return snapshot(s); } };
T.web_screenshot = { name: 'web_screenshot', description: 'لقطة شاشة للصفحة (أو لعنصر برقمه) تشوفها أنت. send_to_owner=true ترسلها للمالك (مثل صفحة تأكيد الحجز).', input_schema: S({ ref: num('اختياري: رقم عنصر'), send_to_owner: { type: 'boolean' }, caption: str('وصف للمالك') }),
  handler: async ({ ref, send_to_owner, caption }, ctx) => {
    ownerOnly(ctx); const s = await session(ctx);
    const item = ref ? el(s, ref).item : null;
    if (item && item.captcha && !send_to_owner) throw new Error('رمز التحقق المصور يكتبه المالك: استخدم web_ask_owner مع show_ref');
    const buf = await shot(s, ref);
    const mime = ref ? 'image/png' : 'image/jpeg';
    let sent = false;
    if (send_to_owner) sent = await require('./power').sendFileToOwner(ctx.channel, { name: `screen.${ref ? 'png' : 'jpg'}`, mime }, buf, caption || `📸 ${s.host}`);
    if (item && item.captcha) return sent ? '✓ انرسلت الصورة للمالك' : 'ما قدرت أرسل الصورة';
    return { __blocks: [{ type: 'text', text: sent ? '✓ انرسلت للمالك. هذي اللقطة:' : 'اللقطة:' }, img(buf, mime)], __text: sent ? 'لقطة انرسلت للمالك' : 'لقطة' };
  } };
T.web_ask_owner = { name: 'web_ask_owner', description: 'يسأل المالك سؤال أثناء التنفيذ وينتظر رده (حتى 10 دقايق): رمز تحقق وصله بالجوال، رمز الصورة (CAPTCHA) مع show_ref، اختيار موعد/فرع، أو بيانات ناقصة. اجمع كل الناقص في سؤال واحد.',
  input_schema: S({ question: str('السؤال بوضوح، والخيارات مرقمة إن وجدت'), show_ref: num('اختياري: رقم عنصر نرسل صورته (مثل صورة رمز التحقق)'), show_page: { type: 'boolean', description: 'نرسل لقطة الصفحة مع السؤال' }, kind: { type: 'string', enum: ['otp', 'captcha', 'choice', 'info', 'nafath'] } }, ['question']),
  handler: async ({ question, show_ref, show_page, kind }, ctx) => {
    ownerOnly(ctx);
    const s = ctx.web;
    const host = s && s.host ? s.host : '';
    if (pendingAsk()) throw new Error('فيه سؤال ثاني مفتوح للمالك');
    let msg = `${ctx.agent === 'phone' ? '📱 **جوالك**' : '🌐 **' + (host || 'الموقع') + '**'} — أحتاج منك:\n${question}`;
    if (kind === 'otp' || (kind !== 'captcha' && /رمز التحقق|رمز التفعيل|كود|OTP|الرمز المرسل|رسالة نصية/i.test(question))) msg += `\n\n🔒 أرسل الرمز **فقط** إذا وصلك من ${host || 'نفس الجهة'} لهذا الطلب اللي طلبته. لو رسالة الرمز من بنك أو فيها مبلغ أو تحويل **لا ترسله**.`;
    if (kind === 'nafath') msg += '\n\n🔒 افتح تطبيق نفاذ وتأكد إن الطلب من نفس الجهة قبل ما توافق، وبعدها اكتب لي «تم».';
    msg += '\n\n(اكتب «إلغاء» لوقف العملية)';
    const ans = new Promise(resolve => { pending = { resolve, expires: Date.now() + 10 * 6e4, host }; });
    try {
      if ((show_ref || show_page) && s) {
        const buf = await shot(s, show_ref);
        const ok = await require('./power').sendFileToOwner(ctx.channel, { name: show_ref ? 'code.png' : 'page.jpg', mime: show_ref ? 'image/png' : 'image/jpeg' }, buf, kind === 'captcha' ? '🧩 اكتب لي اللي في الصورة' : `🌐 ${host}`);
        if (!ok) msg += '\n\n(ما قدرت أرسل الصورة)';
      }
      await sendOwner(ctx.channel, msg);
    } catch (e) { pending = null; throw e; }
    await db.log('web', `🌐 ينتظر رد المالك (${host}): ${kind || 'سؤال'}`).catch(() => {});
    const r = await ans;
    if (r.timeout) return 'المالك ما رد خلال 10 دقايق. وقف واكتب له وين وصلت والخطوة الباقية والرابط.';
    if (/^(إلغاء|الغاء|وقف|كنسل|cancel|stop)$/i.test(r.text)) return 'المالك ألغى العملية. لا تكمل — اكتب له وين وصلت باختصار.';
    return `رد المالك: ${r.text}`;
  } };

// سبب مفهوم لفشل الاتصال بالمتصفح
function browserError(e) {
  const m = String((e && e.message) || e).split('\n')[0];
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'خدمة المتصفح مو موجودة/مو شغالة على السيرفر (browser)';
  if (/ECONNREFUSED/.test(m)) return 'خدمة المتصفح لسا تشتغل (أول مرة تاخذ دقايق)';
  if (/Timeout/i.test(m)) return 'خدمة المتصفح ما ردت في الوقت';
  if (/428|version|Playwright version mismatch/i.test(m)) return 'نسخة المتصفح ما تطابق (' + m.slice(0, 80) + ')';
  return m.slice(0, 140);
}
// هل خدمة المتصفح جاهزة؟ يرجع true أو سبب المشكلة
async function ready() {
  if (!enabled()) return false;
  try { const b = await PW().chromium.connect(WS(), { timeout: 8000 }); await b.close().catch(() => {}); return true; } catch (e) { return browserError(e); }
}

module.exports = { enabled, ready, answer, pendingAsk, isInternal, snapshot, session };
