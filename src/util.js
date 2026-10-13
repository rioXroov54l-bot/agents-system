// أدوات مساعدة: الوقت بتوقيت الرياض والأرقام
const C = require('./config');
const OFF = C.TZ_OFFSET_H * 3600e3;

const riyadh = (d = new Date()) => new Date(new Date(d).getTime() + OFF);
const riyadhDay = (d = new Date()) => riyadh(d).toISOString().slice(0, 10);
const riyadhHour = (d = new Date()) => riyadh(d).getUTCHours();
const riyadhNow = () => {
  const r = riyadh();
  const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  return `${days[r.getUTCDay()]} ${r.toISOString().slice(0, 16).replace('T', ' ')} (توقيت الرياض)`;
};
const fmt = iso => iso ? riyadh(iso).toISOString().slice(0, 16).replace('T', ' ') : '—';
const fmtDay = iso => iso ? riyadh(iso).toISOString().slice(0, 10) : '—';

// يحول "2026-10-20 14:30" أو "2026-10-20T14:30" (بتوقيت الرياض) إلى ISO
function parseLocal(s) {
  if (!s) return null;
  if (s instanceof Date) return s.toISOString();
  const str = String(s).trim().replace(' ', 'T');
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(str)) { const d = new Date(str); return isNaN(d) ? null : d.toISOString(); }
  const full = /^\d{4}-\d{2}-\d{2}$/.test(str) ? str + 'T09:00' : str;
  const d = new Date(full + (full.length === 16 ? ':00' : '') + '+03:00');
  return isNaN(d) ? null : d.toISOString();
}

const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = n => Math.round(Number(n || 0) * 100) / 100;

// حساب بنود عرض/فاتورة: كل بند {name, qty, unit, price} والأسعار قبل الضريبة
function computeTotals(items, discount = 0, vatRate = 15) {
  const clean = (items || []).map(it => {
    const qty = num(it.qty ?? it.quantity ?? 1), price = num(it.price ?? it.unit_price ?? 0);
    return { name: String(it.name || it.description || '').slice(0, 300), description: it.description && it.name ? String(it.description).slice(0, 500) : undefined, qty, unit: it.unit || 'قطعة', price, total: num(qty * price) };
  }).filter(it => it.name);
  const subtotal = num(clean.reduce((s, it) => s + it.total, 0));
  const disc = num(discount);
  const taxable = Math.max(0, subtotal - disc);
  const vat = num(taxable * vatRate / 100);
  return { items: clean, subtotal, discount: disc, vat, total: num(taxable + vat) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { riyadh, riyadhDay, riyadhHour, riyadhNow, fmt, fmtDay, parseLocal, money, num, computeTotals, sleep };
