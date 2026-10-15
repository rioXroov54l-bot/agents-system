// قاعدة البيانات: جداول حقيقية لكل أقسام الشركة
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');

let pool = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY, name text NOT NULL, company text, phone text, email text, city text,
  source text, tags jsonb DEFAULT '[]', notes text, status text DEFAULT 'lead',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_contact_at timestamptz);
CREATE INDEX IF NOT EXISTS customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS customers_email ON customers(lower(email));

CREATE TABLE IF NOT EXISTS interactions (
  id serial PRIMARY KEY, customer_id int REFERENCES customers(id) ON DELETE CASCADE,
  channel text, direction text, summary text, at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY, sku text, name text NOT NULL, unit text DEFAULT 'قطعة', price numeric(14,2) DEFAULT 0,
  cost numeric(14,2), description text, active boolean DEFAULT true, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS deals (
  id serial PRIMARY KEY, customer_id int REFERENCES customers(id) ON DELETE SET NULL, title text NOT NULL,
  stage text DEFAULT 'lead', value numeric(14,2) DEFAULT 0, probability int DEFAULT 20,
  next_action text, next_action_at timestamptz, owner_member_id int, notes text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), closed_at timestamptz);

CREATE TABLE IF NOT EXISTS quotes (
  id serial PRIMARY KEY, number text UNIQUE, customer_id int REFERENCES customers(id) ON DELETE SET NULL,
  deal_id int REFERENCES deals(id) ON DELETE SET NULL, items jsonb NOT NULL DEFAULT '[]',
  subtotal numeric(14,2) DEFAULT 0, discount numeric(14,2) DEFAULT 0, vat numeric(14,2) DEFAULT 0, total numeric(14,2) DEFAULT 0,
  valid_until date, notes text, terms text, status text DEFAULT 'draft', token text,
  created_at timestamptz DEFAULT now(), sent_at timestamptz);

CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY, number text UNIQUE, customer_id int REFERENCES customers(id) ON DELETE SET NULL,
  quote_id int REFERENCES quotes(id) ON DELETE SET NULL, items jsonb NOT NULL DEFAULT '[]',
  subtotal numeric(14,2) DEFAULT 0, discount numeric(14,2) DEFAULT 0, vat numeric(14,2) DEFAULT 0, total numeric(14,2) DEFAULT 0,
  paid_amount numeric(14,2) DEFAULT 0, issue_date date DEFAULT CURRENT_DATE, due_date date, status text DEFAULT 'issued',
  notes text, token text, created_at timestamptz DEFAULT now(), reminded_at timestamptz);

CREATE TABLE IF NOT EXISTS payments (
  id serial PRIMARY KEY, invoice_id int REFERENCES invoices(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL, method text, note text, at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS expenses (
  id serial PRIMARY KEY, category text, vendor text, amount numeric(14,2) NOT NULL, vat numeric(14,2) DEFAULT 0,
  date date DEFAULT CURRENT_DATE, note text, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS members (
  id serial PRIMARY KEY, name text NOT NULL, role text, phone text, email text,
  telegram_id text, link_code text, active boolean DEFAULT true, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS tasks (
  id serial PRIMARY KEY, title text NOT NULL, details text, assignee_id int REFERENCES members(id) ON DELETE SET NULL,
  priority text DEFAULT 'normal', status text DEFAULT 'todo', due_at timestamptz,
  customer_id int, deal_id int, created_by text DEFAULT 'owner',
  created_at timestamptz DEFAULT now(), done_at timestamptz, reminded_at timestamptz);

CREATE TABLE IF NOT EXISTS appointments (
  id serial PRIMARY KEY, title text NOT NULL, at timestamptz NOT NULL, end_at timestamptz,
  customer_id int, location text, notes text, gcal_id text, reminded boolean DEFAULT false,
  created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS vault (
  id serial PRIMARY KEY, label text NOT NULL, holder text DEFAULT 'أنا', data text NOT NULL,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (label, holder));

CREATE TABLE IF NOT EXISTS purchases (
  id serial PRIMARY KEY, kind text DEFAULT 'other', title text NOT NULL, vendor text, amount numeric, currency text DEFAULT 'SAR', link text,
  details jsonb DEFAULT '{}', trip_id int, status text DEFAULT 'awaiting_payment', confirmation text, reminded_at timestamptz,
  created_at timestamptz DEFAULT now(), paid_at timestamptz);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id serial PRIMARY KEY, channel text NOT NULL DEFAULT 'whatsapp', recipient text NOT NULL, name text, subject text, text text NOT NULL,
  at timestamptz NOT NULL, repeat text DEFAULT 'none', status text DEFAULT 'pending', error text, sent_at timestamptz, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS reminders (
  id serial PRIMARY KEY, text text NOT NULL, at timestamptz NOT NULL, done boolean DEFAULT false,
  created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS trips (
  id serial PRIMARY KEY, title text NOT NULL, origin text, destination text, depart_at timestamptz, return_at timestamptz,
  travelers int DEFAULT 1, budget numeric(14,2), status text DEFAULT 'planning', options jsonb DEFAULT '[]',
  chosen jsonb, checklist jsonb DEFAULT '[]', notes text, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS content (
  id serial PRIMARY KEY, type text DEFAULT 'post', platform text, title text, body text,
  status text DEFAULT 'draft', scheduled_at timestamptz, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS research (
  id serial PRIMARY KEY, topic text NOT NULL, summary text, sources jsonb DEFAULT '[]', created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS emails (
  id text PRIMARY KEY, from_addr text, subject text, snippet text, summary text, category text,
  important boolean DEFAULT false, customer_id int, handled boolean DEFAULT false, at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS knowledge (
  id serial PRIMARY KEY, kind text DEFAULT 'fact', text text NOT NULL, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS approvals (
  id serial PRIMARY KEY, kind text NOT NULL, summary text, payload jsonb, status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now(), decided_at timestamptz);

CREATE TABLE IF NOT EXISTS conversations (
  phone text PRIMARY KEY, name text, channel text DEFAULT 'whatsapp', messages jsonb DEFAULT '[]', updated_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS owner_chat (
  id serial PRIMARY KEY, role text, text text, channel text DEFAULT 'dashboard', at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS activity (
  id serial PRIMARY KEY, type text, agent text, text text, at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS activity_at ON activity(at);

CREATE TABLE IF NOT EXISTS runs (
  id serial PRIMARY KEY, agent text, input text, output text, steps jsonb DEFAULT '[]', status text DEFAULT 'running',
  tokens_in int DEFAULT 0, tokens_out int DEFAULT 0, started_at timestamptz DEFAULT now(), finished_at timestamptz);

-- ===== الحياة الشخصية =====
ALTER TABLE customers ADD COLUMN IF NOT EXISTS relation text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS repeat text DEFAULT 'none';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method text;

CREATE TABLE IF NOT EXISTS bills (
  id serial PRIMARY KEY, name text NOT NULL, amount numeric(14,2), cycle text DEFAULT 'monthly', next_due date,
  category text, autopay boolean DEFAULT false, notes text, active boolean DEFAULT true, reminded_for date,
  created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS documents (
  id serial PRIMARY KEY, name text NOT NULL, holder text, expires_on date, notes text,
  reminded jsonb DEFAULT '[]', created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS occasions (
  id serial PRIMARY KEY, person text NOT NULL, type text DEFAULT 'birthday', month int NOT NULL, day int NOT NULL,
  year int, notes text, notified jsonb DEFAULT '[]', created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS goals (
  id serial PRIMARY KEY, title text NOT NULL, why text, target numeric, unit text, period text DEFAULT 'once',
  deadline date, status text DEFAULT 'active', created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS goal_logs (
  id serial PRIMARY KEY, goal_id int REFERENCES goals(id) ON DELETE CASCADE, amount numeric DEFAULT 1, note text, at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS shopping (
  id serial PRIMARY KEY, item text NOT NULL, qty text, store text, category text, done boolean DEFAULT false, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS notes (
  id serial PRIMARY KEY, title text, body text NOT NULL, tags jsonb DEFAULT '[]', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS income (
  id serial PRIMARY KEY, source text, amount numeric(14,2) NOT NULL, date date DEFAULT CURRENT_DATE, note text, created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS backups (day text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now());
CREATE SCHEMA IF NOT EXISTS n8n;
`;

const DEFAULT_SETTINGS = {
  // بيانات اختيارية تظهر في أي مستند يصدره النظام
  company: { name: '', name_en: '', parent: '', vat_number: '', cr_number: '', address: '', email: '', website: '', logo_url: '', phones_admin: [], phones_sales: [], bank: '' },
  business_info: '',
  profile: {
    name: '',            // اسمك كما تحب يناديك السكرتير
    city: 'الرياض',
    home_airport: 'RUH',
    family: '',          // أفراد عائلتك ومعلومات تساعد السكرتير
    preferences: '',     // تفضيلاتك: درجة الطيران، الفنادق، الأكل، أوقات المواعيد...
    signature: ''        // توقيع الإيميلات
  },
  budgets: {},           // ميزانية شهرية لكل تصنيف { "مطاعم": 1500 }
  autonomy: {
    level: 'high',
    approval_threshold: 5000,   // أي إجراء فيه مبلغ أعلى يحتاج موافقتك
    max_discount_pct: 0,
    auto_followup: false,
    followup_after_days: 3,
    auto_invoice_reminders: false
  },
  vat_rate: 15,
  quote_validity_days: 15,
  quote_terms: '',
  invoice_due_days: 15,
  report_hour: C.REPORT_HOUR,
  morning_hour: 8,
  weekly_review: { day: 6, hour: 20 },   // السبت 8 مساءً
  counters: { quote: 0, invoice: 0 },
  telegram: { owner_id: '', pair_code: '' },
  owner: { name: '', email: '', home_city: 'الرياض', preferences: '' }
};

// ---------- اتصال ----------
// SSL فقط للقواعد الخارجية؛ الداخلية (Docker/Railway الداخلي/المحلي) بدون SSL
function needsSsl(url) {
  if (process.env.DB_SSL) return process.env.DB_SSL === 'true';
  if (/sslmode=disable/.test(url)) return false;
  if (/sslmode=(require|verify)/.test(url)) return true;
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  if (!host || !host.includes('.') || /\.internal$|^localhost$|^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}
async function connect() {
  if (!C.DATABASE_URL) throw new Error('DATABASE_URL غير محدد');
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: C.DATABASE_URL,
    ssl: needsSsl(C.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    max: 10
  });
  await pool.query(SCHEMA);
  await migrateLegacy();
  console.log('✅ متصل بقاعدة البيانات');
}

const q = (sql, params = []) => pool.query(sql, params);
const many = async (sql, params) => (await q(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params)).rows[0] || null;

// إدخال/تحديث عام بأعمدة مسموحة فقط
async function insert(table, data, cols) {
  const keys = Object.keys(data).filter(k => cols.includes(k) && data[k] !== undefined);
  if (!keys.length) throw new Error('لا توجد بيانات');
  const vals = keys.map(k => jsonify(data[k]));
  return one(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
}
async function update(table, id, data, cols) {
  const keys = Object.keys(data).filter(k => cols.includes(k) && data[k] !== undefined);
  if (!keys.length) return one(`SELECT * FROM ${table} WHERE id=$1`, [id]);
  const vals = keys.map(k => jsonify(data[k]));
  const extra = ['customers', 'deals'].includes(table) ? ', updated_at=now()' : '';
  return one(`UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')}${extra} WHERE id=$${keys.length + 1} RETURNING *`, [...vals, id]);
}
const jsonify = v => (v !== null && typeof v === 'object' && !(v instanceof Date)) ? JSON.stringify(v) : v;

// ---------- الإعدادات ----------
let settingsCache = null;
async function getSettings() {
  if (settingsCache) return settingsCache;
  const rows = await many('SELECT key, value FROM settings');
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of rows) {
    const v = r.value; // pg يفك jsonb تلقائياً
    s[r.key] = (v && typeof v === 'object' && !Array.isArray(v) && s[r.key] && typeof s[r.key] === 'object') ? { ...s[r.key], ...v } : v;
  }
  settingsCache = s;
  return s;
}
async function setSetting(key, value) {
  await q('INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()', [key, JSON.stringify(value)]);
  settingsCache = null;
  return getSettings();
}
async function nextNumber(kind) {
  const s = await getSettings();
  const counters = { ...s.counters, [kind]: (Number(s.counters[kind]) || 0) + 1 };
  await setSetting('counters', counters);
  const y = new Date(Date.now() + C.TZ_OFFSET_H * 3600e3).getUTCFullYear();
  return `${kind === 'quote' ? 'Q' : 'INV'}-${y}-${String(counters[kind]).padStart(4, '0')}`;
}
const token = () => crypto.randomBytes(12).toString('hex');

// ---------- السجل ----------
async function log(type, text, agent = null) {
  try { await q('INSERT INTO activity (type, agent, text) VALUES ($1,$2,$3)', [type, agent, String(text).slice(0, 1000)]); }
  catch (e) { console.error('log', e.message); }
}

// ---------- نقل البيانات من النظام القديم ----------
async function migrateLegacy() {
  const done = await one("SELECT value FROM settings WHERE key='legacy_migrated'");
  if (done) return;
  let old = null;
  try {
    await q('CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())');
    const r = await one('SELECT data FROM app_state WHERE id=1');
    if (r) old = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  } catch (_) {}
  if (!old) { try { old = JSON.parse(fs.readFileSync(path.join(C.DATA_DIR, 'data.json'), 'utf8')); } catch (_) {} }
  if (old) {
    for (const [phone, c] of Object.entries(old.conversations || {})) {
      await q('INSERT INTO conversations (phone, name, messages) VALUES ($1,$2,$3) ON CONFLICT (phone) DO NOTHING', [phone, c.name, JSON.stringify(c.messages || [])]);
    }
    for (const a of old.appointments || []) {
      await q('INSERT INTO appointments (title, at, notes, gcal_id, reminded) VALUES ($1,$2,$3,$4,$5)', [a.title, a.at, [a.customer, a.notes].filter(Boolean).join(' — '), a.gcalId || null, !!a.reminded]);
    }
    for (const l of old.lessons || []) await q("INSERT INTO knowledge (kind, text) VALUES ('reply_example', $1)", [`العميل: ${l.q}\nالرد المعتمد: ${l.a}`]);
    for (const m of (old.ownerChat || []).slice(-40)) await q('INSERT INTO owner_chat (role, text, at) VALUES ($1,$2,$3)', [m.role, m.text, m.at]);
    for (const p of old.pending || []) {
      await q("INSERT INTO approvals (kind, summary, payload) VALUES ('customer_reply', $1, $2)", [`${p.category || ''} — ${p.name}: ${p.customerText}`, JSON.stringify(p)]);
    }
    if (old.settings && old.settings.businessInfo) await q("INSERT INTO settings (key, value) VALUES ('business_info', $1) ON CONFLICT DO NOTHING", [JSON.stringify(old.settings.businessInfo)]);
    console.log('📦 انتقلت البيانات القديمة للجداول الجديدة');
  }
  await q("INSERT INTO settings (key, value) VALUES ('legacy_migrated', 'true') ON CONFLICT DO NOTHING");
}

// نسخة احتياطية يومية لكل الجداول المهمة
async function dailyBackup() {
  const day = new Date(Date.now() + C.TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
  const exists = await one('SELECT day FROM backups WHERE day=$1', [day]);
  if (exists) return;
  const data = {};
  for (const t of ['settings', 'customers', 'expenses', 'income', 'bills', 'documents', 'occasions', 'goals', 'goal_logs', 'shopping', 'notes', 'members', 'tasks', 'appointments', 'reminders', 'trips', 'research', 'knowledge', 'deals', 'quotes', 'invoices', 'payments', 'products', 'content']) {
    data[t] = await many(`SELECT * FROM ${t}`);
  }
  await q('INSERT INTO backups (day, data) VALUES ($1,$2) ON CONFLICT (day) DO NOTHING', [day, JSON.stringify(data)]);
  await q("DELETE FROM backups WHERE day < to_char(now() - interval '30 days', 'YYYY-MM-DD')");
}

module.exports = { connect, q, one, many, insert, update, getSettings, setSetting, nextNumber, token, log, dailyBackup, DEFAULT_SETTINGS, get pool() { return pool; } };
