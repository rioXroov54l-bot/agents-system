// الخزنة: بيانات وثائق المالك (رقم الجواز، الهوية، الإقامة، الرخصة...) مشفرة AES-256-GCM.
// - ما تدخل سياق الذكاء الاصطناعي إلا إذا طلبها المالك بنفسه (vault_get في محادثته).
// - ممنوع تطلع لأي شخص في الإرسال التلقائي (فحص في guardedExternal).
// - بطاقات الدفع وكلمات السر ورموز OTP ممنوعة حتى هنا.
const crypto = require('crypto');
const db = require('./db');

const key = () => {
  const base = process.env.VAULT_KEY || process.env.N8N_ENCRYPTION_KEY || process.env.DASHBOARD_PASSWORD;
  if (!base) throw new Error('الخزنة غير مفعلة (ما فيه مفتاح تشفير)');
  return crypto.createHash('sha256').update('sakrtir-vault:' + base).digest();
};
function enc(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
function dec(s) {
  const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

const FORBIDDEN = /(password|passcode|كلمة\s*(ال)?(سر|مرور)|رمز\s*(التحقق|سري)|\botp\b|\bcvv\b|\bcvc\b|\bpin\b)/i;
const looksLikeCard = v => { const d = String(v).replace(/[\s-]/g, ''); if (!/^\d{13,19}$/.test(d)) return false; let s = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; };

async function save({ label, holder = 'أنا', fields = {} }) {
  if (!label) throw new Error('لازم اسم الوثيقة');
  const clean = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (FORBIDDEN.test(k) || FORBIDDEN.test(String(v))) throw new Error('كلمات السر ورموز التحقق ما تنحفظ حتى في الخزنة 🔒');
    if (looksLikeCard(v)) throw new Error('أرقام بطاقات الدفع ما تنحفظ حتى في الخزنة 🔒');
    clean[k] = String(v).slice(0, 300);
  }
  if (!Object.keys(clean).length) throw new Error('ما فيه بيانات');
  const old = await db.one('SELECT id, data FROM vault WHERE label=$1 AND holder=$2', [label, holder]);
  const merged = old ? { ...dec(old.data), ...clean } : clean;
  if (old) await db.q('UPDATE vault SET data=$2, updated_at=now() WHERE id=$1', [old.id, enc(merged)]);
  else await db.q('INSERT INTO vault (label, holder, data) VALUES ($1,$2,$3)', [label, holder, enc(merged)]);
  await db.log('vault', `🔐 حفظ في الخزنة: ${label} (${holder}) — ${Object.keys(clean).join('، ')}`);
  cacheAt = 0;
  return { ok: true, label, holder, saved_fields: Object.keys(clean) };
}
async function get({ label, holder } = {}) {
  const rows = await db.many('SELECT id, label, holder, data, updated_at FROM vault WHERE ($1::text IS NULL OR label ILIKE $1) AND ($2::text IS NULL OR holder ILIKE $2) ORDER BY label',
    [label ? '%' + label + '%' : null, holder ? '%' + holder + '%' : null]);
  await db.log('vault', `🔓 قراءة من الخزنة: ${label || 'الكل'}`);
  return rows.map(r => ({ id: r.id, label: r.label, holder: r.holder, fields: dec(r.data) }));
}
async function list() { return db.many('SELECT id, label, holder, updated_at FROM vault ORDER BY label'); }
async function remove(id) { const r = await db.one('DELETE FROM vault WHERE id=$1 RETURNING label', [Number(id)]); cacheAt = 0; return r ? `🗑️ انحذف «${r.label}» من الخزنة` : 'ما لقيته'; }

// قيم حساسة (للفحص قبل أي إرسال تلقائي)
let cache = [], cacheAt = 0;
async function secrets() {
  if (Date.now() - cacheAt < 6e4) return cache;
  const rows = await db.many('SELECT data FROM vault').catch(() => []);
  const vals = [];
  for (const r of rows) { try { for (const [k, v] of Object.entries(dec(r.data))) if (/number|رقم|no\b|id|mrz|registration/i.test(k) && String(v).replace(/\s/g, '').length >= 5) vals.push(String(v).replace(/\s/g, '').toUpperCase()); } catch (_) {} }
  cache = vals; cacheAt = Date.now();
  return vals;
}
async function containsSecret(text) {
  const t = String(text || '').replace(/\s/g, '').toUpperCase();
  return (await secrets()).some(v => t.includes(v));
}

module.exports = { save, get, list, remove, containsSecret };
