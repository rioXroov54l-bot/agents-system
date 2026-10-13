// استيراد بيانات السيرفر القديم (ملف التصدير) إلى قاعدة السيرفر الجديد
// الاستخدام: node deploy/import.js /migrate.json
const fs = require('fs');
const db = require('../src/db');

const SKIP_SETTINGS = ['migrate', 'evo_state', 'whatsapp_status', 'n8n_status', 'sched'];

function fixValue(v, type) {
  if (v === null || v === undefined) return null;
  if (type === 'json' || type === 'jsonb') return JSON.stringify(v);
  if (type === 'bytea' && v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  return v;
}

(async () => {
  const file = process.argv[2] || '/migrate.json';
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  const oldHost = (dump.source || '').replace(/^https?:\/\//, '');
  await db.connect(); // ينشئ جداول السكرتير إن ما كانت موجودة
  const client = await db.pool.connect();
  const report = [];
  try {
    await client.query('BEGIN');
    await client.query("SET session_replication_role = 'replica'"); // نتجاوز القيود أثناء النسخ
    const schemas = Object.entries(dump.schemas || {}).filter(([schema]) => !(schema === 'n8n' && process.env.SKIP_N8N));
    // 1) نفرغ كل الجداول المستهدفة أولاً (عشان CASCADE ما يمسح شي استوردناه)
    const plan = [];
    for (const [schema, tables] of schemas) {
      for (const [table, rows] of Object.entries(tables)) {
        const cols = (await client.query('SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [schema, table])).rows;
        if (!cols.length) { report.push(`- تخطيت ${schema}.${table} (غير موجود هنا)`); continue; }
        plan.push({ schema, table, rows, types: Object.fromEntries(cols.map(c => [c.column_name, c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type])) });
      }
    }
    if (plan.length) await client.query(`TRUNCATE ${plan.map(p => `"${p.schema}"."${p.table}"`).join(', ')} CASCADE`);
    // 2) نستورد
    for (const { schema, table, rows, types } of plan) {
      {
        let n = 0;
        for (let row of rows) {
          if (schema === 'public' && table === 'settings' && SKIP_SETTINGS.includes(row.key)) continue;
          if (schema === 'n8n' && /^workflow_(entity|history)$/.test(table) && oldHost) {
            // روابط السيرفر القديم داخل الـ workflow تتحول للعنوان الداخلي الجديد
            row = JSON.parse(JSON.stringify(row).split(`https://${oldHost}`).join('http://agents:3000'));
          }
          const keys = Object.keys(row).filter(k => k in types);
          if (!keys.length) continue;
          await client.query(`INSERT INTO "${schema}"."${table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
            keys.map(k => fixValue(row[k], types[k])));
          n++;
        }
        report.push(`✓ ${schema}.${table}: ${n}`);
      }
    }
    // تحديث العدادات التلقائية
    const seqs = (await client.query(`SELECT n.nspname AS schema, c.relname AS table, a.attname AS col, pg_get_serial_sequence(quote_ident(n.nspname)||'.'||quote_ident(c.relname), a.attname) AS seq
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','n8n') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`)).rows.filter(r => r.seq);
    for (const s of seqs) await client.query(`SELECT setval('${s.seq}', coalesce((SELECT max("${s.col}") FROM "${s.schema}"."${s.table}"), 0) + 1, false)`);
    await client.query('COMMIT');
    console.log(report.join('\n'));
    console.log(`\n✅ تم الاستيراد (${seqs.length} عداد محدّث)`);
    process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ فشل الاستيراد:', e.message);
    process.exit(1);
  }
})();
