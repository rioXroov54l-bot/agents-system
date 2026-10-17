// التحكم بجوال المالك (آيفون عبر iPhone Mirroring على ماكه) باستخدام phone-harness.
// الماك يشغّل «جسر جوال السكرتير» (deploy/phone/phone_bridge.py) اللي يتصل بالسيرفر (اتصال خارج فقط)
// ويستلم أوامر محددة (قراءة الشاشة، لقطة، ضغط، كتابة، فتح تطبيق) — ما ينفذ أي كود يجيه من السيرفر.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const C = require('./config');
const db = require('./db');
const { T } = require('./tools');

const DENY_APPS = /bank|بنك|مصرف|rajhi|راجحي|ahli|الأهلي|snb|alinma|الإنماء|riyad|albilad|البلاد|aljazira|الجزيرة|\bsab\b|ساب|stc ?pay|urpay|wallet|محفظ|apple ?pay|password|كلمات ?(ال)?سر|keychain|authenticator|binance|crypto|tadawul|تداول|derayah|دراية|sahm|سهم|mubasher|مباشر|tabby|تابي|tamara|تمارا|paypal|western ?union/i;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- حالة الجسر ----------
let lastSeen = 0, savedAt = 0, info = {}, inflight = 0;
// نسخة الجسر الحالية (الجسر على الماك يتحدث لحاله لو اختلفت)
let BRIDGE_VERSION = '';
try { BRIDGE_VERSION = (require('fs').readFileSync(require('path').join(__dirname, '..', 'deploy', 'phone', 'phone_bridge.py'), 'utf8').match(/VERSION = "([^"]+)"/) || [])[1] || ''; } catch (_) {}
const queue = [];              // أوامر تنتظر الجسر
const waiting = new Map();     // id → {resolve, reject, timer}
let poller = null;             // طلب poll مفتوح من الجسر

async function cfg() { return (await db.getSettings()).phone_bridge || null; }
async function checkToken(req) {
  const c = await cfg();
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!c || !c.hash || !tok) return false;
  const a = Buffer.from(sha(tok)), b = Buffer.from(c.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function seen(req) {
  lastSeen = Date.now(); info = { version: req.query.v || (req.body && req.body.v) || info.version || '', ip: req.ip };
  if (Date.now() - savedAt > 60e3) { savedAt = Date.now(); const c = await cfg(); if (c) await db.setSetting('phone_bridge', { ...c, last_seen: new Date().toISOString(), version: info.version }); }
}
// متصل = نبض خلال آخر 75 ثانية، أو فيه أمر شغال عنده الحين
const connected = () => Date.now() - lastSeen < 75e3 || inflight > 0;
const ago = () => { if (!lastSeen) return ''; const m = Math.round((Date.now() - lastSeen) / 6e4); return m < 1 ? ' (آخر اتصال قبل أقل من دقيقة)' : ` (آخر اتصال قبل ${m} دقيقة)`; };
async function status() {
  const c = await cfg();
  if (!c || !c.hash) return { configured: false, connected: false };
  return { configured: true, connected: connected(), last_seen: lastSeen ? new Date(lastSeen).toISOString() : c.last_seen || null, version: info.version || c.version || '' };
}

function deliver() {
  while (poller && queue.length) {
    const p = poller; poller = null; clearTimeout(p.timer);
    if (p.res.writableEnded || (p.res.socket && p.res.socket.destroyed)) continue; // الاتصال انقفل: ننتظر الـ poll الجاي
    const cmd = queue.shift();
    const w = waiting.get(cmd.id); if (w && !w.taken) { w.taken = true; inflight++; }
    p.res.json(cmd);
    return;
  }
}

// يرسل أمر للجوال وينتظر النتيجة
async function call(op, args = {}, timeoutMs = 90e3) {
  const c = await cfg();
  if (!c || !c.hash) throw new Error('جوالك مو مربوط للحين: لوحة التحكم ← الإعدادات ← «التحكم بجوالك» وشغّل أمر التثبيت على الماك.');
  if (!connected()) throw new Error('جسر الجوال مو متصل الحين' + ago() + ': تأكد إن الماك شغال (مو نايم) ونافذة «جسر جوال السكرتير» مفتوحة فيه (لو انقفلت: Terminal ← open ~/.sakrtir/sakrtir-bridge.command).');
  const id = crypto.randomBytes(8).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (waiting.has(id) && waiting.get(id).taken) inflight = Math.max(0, inflight - 1);
      waiting.delete(id);
      const i = queue.findIndex(q => q.id === id); if (i >= 0) queue.splice(i, 1);
      reject(new Error('الجوال ما رد خلال الوقت — ممكن الماك نام أو iPhone Mirroring انقطع.'));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    queue.push({ id, op, args });
    deliver();
  });
}

// ---------- المسارات (عامة لكن محمية برمز الجسر) ----------
function mount(app) {
  const file = n => path.join(__dirname, '..', 'deploy', 'phone', n);
  app.get('/phone-bridge/install.sh', (_req, res) => {
    try { res.type('text/plain; charset=utf-8').send(fs.readFileSync(file('install-mac.sh'), 'utf8').replace(/__SAKRTIR_URL__/g, C.PUBLIC_URL)); }
    catch (e) { res.status(500).send('missing'); }
  });
  app.get('/phone-bridge/bridge.py', (_req, res) => {
    try { res.type('text/plain; charset=utf-8').send(fs.readFileSync(file('phone_bridge.py'), 'utf8')); } catch (e) { res.status(500).send('missing'); }
  });
  app.post('/phone-bridge/ping', async (req, res) => {
    if (!(await checkToken(req))) return res.sendStatus(401);
    await seen(req).catch(() => {});
    res.json({ ok: true, version: BRIDGE_VERSION });
  });
  app.get('/phone-bridge/poll', async (req, res) => {
    if (!(await checkToken(req))) return res.sendStatus(401);
    await seen(req).catch(() => {});
    if (BRIDGE_VERSION) res.set('X-Bridge-Version', BRIDGE_VERSION);
    if (poller) { clearTimeout(poller.timer); try { if (!poller.res.writableEnded) poller.res.sendStatus(204); } catch (_) {} }
    const p = { res, timer: setTimeout(() => { if (poller === p) poller = null; try { if (!res.writableEnded) res.sendStatus(204); } catch (_) {} }, 25e3) };
    poller = p;
    res.on('close', () => { if (poller === p) { clearTimeout(p.timer); poller = null; } });
    deliver();
  });
  app.post('/phone-bridge/result', async (req, res) => {
    if (!(await checkToken(req))) return res.sendStatus(401);
    await seen(req).catch(() => {});
    const b = req.body || {}, w = waiting.get(b.id);
    if (w) { waiting.delete(b.id); clearTimeout(w.timer); if (w.taken) inflight = Math.max(0, inflight - 1); b.ok ? w.resolve(b.result) : w.reject(new Error(friendly(b.error))); }
    res.json({ ok: true });
  });
}
function friendly(e) {
  const m = String(e || '');
  if (/PermissionError/.test(m)) return m.replace(/^PermissionError:\s*/, '');
  if (/unlock|locked|in use|Connect|mirroring/i.test(m)) return 'iPhone Mirroring مو جاهز: خلّ الجوال **مقفول** وقريب من الماك (لما تستخدم الجوال المراية توقف). التفاصيل: ' + m.slice(0, 160);
  if (/Accessibility|Screen Recording|permission/i.test(m)) return 'الماك يحتاج صلاحيات لـ Terminal (Accessibility وScreen Recording) من إعدادات الخصوصية. ' + m.slice(0, 120);
  if (/not found|No text|NotFound/i.test(m)) return 'ما لقيت المطلوب على الشاشة: ' + m.slice(0, 160);
  return m.slice(0, 300);
}

// ---------- إنشاء/إلغاء رمز الربط (من اللوحة) ----------
async function newToken() {
  const token = crypto.randomBytes(24).toString('hex');
  await db.setSetting('phone_bridge', { hash: sha(token), created_at: new Date().toISOString() });
  lastSeen = 0;
  return { token, command: `curl -fsSL ${C.PUBLIC_URL}/phone-bridge/install.sh | bash -s -- ${token}` };
}
async function revoke() { await db.setSetting('phone_bridge', null); lastSeen = 0; queue.length = 0; }

// ---------- أدوات وكيل الجوال ----------
const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const num = d => ({ type: 'number', description: d });
const ownerOnly = ctx => { if (!ctx.byOwner) throw new Error('التحكم بالجوال للمالك فقط'); };
const fmtBoxes = boxes => (boxes || []).slice(0, 160).map(b => `«${b.t}» (${b.x},${b.y})`).join('\n') || '(ما فيه نص ظاهر — جرّب لقطة شاشة)';
const asScreen = r => '📱 النص الظاهر على الشاشة (النص + نقطة الضغط x,y):\n' + fmtBoxes(r && r.boxes);
const img = im => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.jpeg_b64 } });
const act = (op, argsOf, timeout) => async (input, ctx) => { ownerOnly(ctx); return asScreen(await call(op, argsOf(input), timeout)); };

T.phone_status = { name: 'phone_status', description: 'هل جوال المالك جاهز للتحكم (الجسر متصل، iPhone Mirroring جاهز)؟ ابدأ فيه.', input_schema: S({}),
  handler: async (_i, ctx) => {
    ownerOnly(ctx); const s = await status();
    if (!s.connected) return JSON.stringify({ ...s, problem: 'جسر الجوال مو متصل' + ago() + ' — الماك نايم أو نافذة الجسر مقفلة' });
    const ph = await call('status', {}, 60e3);
    return JSON.stringify({ ...s, phone: ph, ready: ph && ph.state === 'ready', what_to_tell_owner: ph && ph.state !== 'ready' ? (ph.hint || ph.detail) : undefined });
  } };
T.phone_screen = { name: 'phone_screen', description: 'يقرأ شاشة الجوال الحين: كل النص الظاهر مع نقاط الضغط. screenshot=true يضيف صورة الشاشة (للأيقونات بدون نص) — الصورة مقاسها مكتوب، واستخدم phone_tap_image لنقطة منها.', input_schema: S({ screenshot: { type: 'boolean' } }),
  handler: async ({ screenshot }, ctx) => {
    ownerOnly(ctx);
    const r = await call('screen', { screenshot: !!screenshot, width: 600 }, 90e3);
    const text = asScreen(r);
    if (!r.image) return text;
    return { __blocks: [{ type: 'text', text: `${text}\n\n🖼️ لقطة الشاشة (${r.image.width}×${r.image.height} بكسل):` }, img(r.image)], __text: text.slice(0, 200) };
  } };
T.phone_open_app = { name: 'phone_open_app', description: 'يفتح تطبيق على الجوال باسمه (مثل "WhatsApp" أو "Settings" أو "Uber"). ممنوع تطبيقات البنوك والمحافظ وكلمات السر.', input_schema: S({ name: str('اسم التطبيق كما يظهر') }, ['name']),
  handler: async ({ name }, ctx) => { ownerOnly(ctx); if (DENY_APPS.test(name)) throw new Error('ممنوع: ما أفتح تطبيقات البنوك والمحافظ وكلمات السر والاستثمار.'); return asScreen(await call('open_app', { name }, 120e3)); } };
T.phone_tap_text = { name: 'phone_tap_text', description: 'يضغط على نص ظاهر في الشاشة (زر أو خيار). index للتكرار الثاني فأكثر.', input_schema: S({ text: str('النص'), index: { type: 'integer' }, exact: { type: 'boolean' } }, ['text']),
  handler: act('tap_text', i => ({ text: i.text, index: i.index || 0, exact: !!i.exact })) };
T.phone_tap = { name: 'phone_tap', description: 'يضغط على نقطة (x,y) من نتائج phone_screen.', input_schema: S({ x: num('x'), y: num('y') }, ['x', 'y']),
  handler: act('tap', i => ({ x: i.x, y: i.y })) };
T.phone_tap_image = { name: 'phone_tap_image', description: 'يضغط على نقطة من لقطة الشاشة (بكسل الصورة) — للأيقونات اللي ما عليها نص. أعطه مقاس الصورة.', input_schema: S({ x: num('x بالصورة'), y: num('y بالصورة'), width: num('عرض الصورة'), height: num('ارتفاع الصورة') }, ['x', 'y', 'width', 'height']),
  handler: act('tap_image', i => ({ x: i.x, y: i.y, width: i.width, height: i.height })) };
T.phone_long_press = { name: 'phone_long_press', description: 'ضغط مطوّل على نقطة (x,y).', input_schema: S({ x: num('x'), y: num('y') }, ['x', 'y']),
  handler: act('long_press', i => ({ x: i.x, y: i.y })) };
T.phone_type = { name: 'phone_type', description: 'يكتب نص في الحقل اللي عليه المؤشر (اضغط الحقل أول). ممنوع كلمات السر وبيانات البطاقات.', input_schema: S({ text: str('النص') }, ['text']),
  redact: i => ({ ...i, text: String(i.text || '').replace(/\d(?=\d{2})/g, '•') }),
  handler: act('type', i => ({ text: i.text }), 120e3) };
T.phone_press = { name: 'phone_press', description: 'يضغط زر كيبورد: "enter" أو "delete" أو "escape" أو "tab".', input_schema: S({ key: str('الزر') }, ['key']),
  handler: act('press', i => ({ key: i.key })) };
T.phone_home = { name: 'phone_home', description: 'يرجع للشاشة الرئيسية.', input_schema: S({}), handler: act('home', () => ({})) };
T.phone_swipe = { name: 'phone_swipe', description: 'سحب بالإصبع: up/down/left/right (اتجاه حركة الإصبع).', input_schema: S({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } }, ['direction']),
  handler: act('swipe', i => ({ direction: i.direction })) };
T.phone_scroll = { name: 'phone_scroll', description: 'تمرير لكشف محتوى: down/up/left/right (اتجاه المحتوى اللي تبي تشوفه).', input_schema: S({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', description: '0.1-0.9 (افتراضي 0.5)' } }, ['direction']),
  handler: act('scroll', i => ({ direction: i.direction, amount: i.amount || 0.5 })) };

module.exports = { mount, call, status, newToken, revoke, connected, DENY_APPS };
