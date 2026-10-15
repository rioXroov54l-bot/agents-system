// قرارات الموافقة (من تيليجرام أو لوحة التحكم)
const db = require('./db');
const { executors } = require('./tools');

async function decide(id, approve, editedText) {
  const ap = await db.one('SELECT * FROM approvals WHERE id=$1', [Number(id)]);
  if (!ap) return 'ما لقيت طلب بهذا الرقم';
  if (ap.status !== 'pending') return `الطلب #${id} سبق ${ap.status === 'approved' ? 'الموافقة عليه' : 'رفضه'}`;
  const payload = typeof ap.payload === 'string' ? JSON.parse(ap.payload) : (ap.payload || {});
  if (!approve) {
    await db.q("UPDATE approvals SET status='rejected', decided_at=now() WHERE id=$1", [ap.id]);
    await db.log('rejected', `❌ رفض #${ap.id}`);
    return `❌ رفضت #${ap.id}، ما انرسل شي`;
  }
  if (editedText) {
    if (ap.kind === 'customer_reply' || ap.kind === 'send_whatsapp') payload.text = editedText;
    else if (ap.kind === 'send_email' || ap.kind === 'gmail_reply') payload.body = editedText;
    else payload.message = editedText;
    if (ap.kind === 'customer_reply' && payload.customerText) {
      await db.q("INSERT INTO knowledge (kind, text) VALUES ('reply_example', $1)", [`العميل: ${payload.customerText}\nالرد المعتمد: ${editedText}`]);
    }
  }
  const exec = executors[ap.kind] || executors.note;
  try {
    const out = await exec(payload);
    await db.q("UPDATE approvals SET status='approved', decided_at=now() WHERE id=$1", [ap.id]);
    await db.log('approved', `✅ موافقة #${ap.id}`);
    return out;
  } catch (e) {
    return `⚠️ وافقت لكن التنفيذ فشل: ${e.message}`;
  }
}

module.exports = { decide };
