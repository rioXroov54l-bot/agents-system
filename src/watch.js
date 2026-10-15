// مراقبة ردود أشخاص معيّنين على رقم السكرتير: يوصّل ردودهم للمالك، ويشكرهم برد مهذب قصير
const db = require('./db');
const key = n => String(n || '').replace(/\D/g, '').slice(-9);

async function all() {
  const w = (await db.getSettings()).wa_watch || {};
  const now = Date.now(), out = {};
  for (const [k, v] of Object.entries(w)) if (!v.until || new Date(v.until).getTime() > now) out[k] = v;
  return out;
}
async function get(num) { return (await all())[key(num)] || null; }
async function add(num, { name = '', note = '', days = 30, outbound = '' } = {}) {
  const k = key(num); if (k.length < 9) throw new Error('رقم غير صحيح');
  const w = await all(), old = w[k] || {};
  w[k] = { ...old, phone: String(num).replace(/\D/g, ''), name: name || old.name || '', note: note || old.note || '', since: old.since || new Date().toISOString(), until: new Date(Date.now() + Math.max(1, Number(days) || 30) * 864e5).toISOString(),
    ...(outbound ? { last_out: new Date().toISOString(), last_out_text: String(outbound).slice(0, 600) } : {}) };
  await db.setSetting('wa_watch', w);
  return w[k];
}
async function update(num, patch) { const w = await all(), k = key(num); if (!w[k]) return; w[k] = { ...w[k], ...patch }; await db.setSetting('wa_watch', w); }
async function remove(num) { const w = await all(); delete w[key(num)]; await db.setSetting('wa_watch', w); }

module.exports = { all, get, add, update, remove, key };
