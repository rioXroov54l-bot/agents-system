// «حدّث الآن»: السكرتير يطلب من السيرفر يسحب آخر تحديث فوراً بدل ما ينتظر.
// الحاوية ما تقدر تشغّل git/docker على السيرفر، فتكتب ملف طلب في مجلد البيانات (/data)،
// وسكربت السيرفر deploy/update.sh (يشتغل كل دقيقة) يشوفه وينفذ التحديث ويكتب النتيجة في update-status.json.
const fs = require('fs');
const path = require('path');
const C = require('./config');
const U = require('./util');

const F = n => path.join(C.DATA_DIR, n);
const STATE = { checking: '🔎 يفحص', updating: '⬆️ يحدّث ويعيد البناء', done: '✅ تحدّث', uptodate: '✅ على آخر نسخة', failed: '❌ فشل التحديث' };

function status() {
  let s = null; try { s = JSON.parse(fs.readFileSync(F('update-status.json'), 'utf8')); } catch (_) {}
  let pendingAt = null; try { pendingAt = fs.readFileSync(F('update-now'), 'utf8').trim() || 'now'; } catch (_) {}
  let build = ''; try { build = fs.readFileSync(path.join(__dirname, '..', '.build'), 'utf8').trim(); } catch (_) {}
  return { pending: !!pendingAt, requested_at: pendingAt, last: s, build, supported: !!s };
}
function request() {
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  fs.writeFileSync(F('update-now'), new Date().toISOString());
  return status();
}
function describe(st) {
  const L = [];
  if (st.last) L.push(`آخر فحص: ${STATE[st.last.state] || st.last.state}${st.last.at ? ' — ' + U.fmt(st.last.at).slice(5) : ''}${st.last.sha ? ' (نسخة ' + st.last.sha + ')' : ''}`);
  if (st.build) L.push(`السكرتير الشغال الحين مبني: ${U.fmt(st.build).slice(5)}`);
  return L.join('\n');
}
// أمر سريع من واتساب/تيليجرام
async function quick() {
  const st = request();
  return '⬆️ **طلبت تحديث السيرفر الحين**\n\nخلال دقيقة يسحب آخر نسخة، ولو فيه تحديث يعيد البناء (1-3 دقايق، وممكن أسكت شوي وقتها).\nبعدها أرسل «حالة النظام» وشوف «آخر تحديث للسكرتير».'
    + (st.supported ? '' : '\n\nℹ️ أول مرة: السيرفر يفعّل هالميزة مع التحديث التلقائي الجاي (خلال 10-20 دقيقة)، وبعدها تصير فورية.')
    + (describe(st) ? '\n\n' + describe(st) : '');
}
module.exports = { status, request, quick, describe };
