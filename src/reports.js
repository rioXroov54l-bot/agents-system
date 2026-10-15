// مستندات وتقارير احترافية: تقارير بحث، دراسات جدوى، خطابات رسمية، سير ذاتية، برامج رحلات...
// كل مستند له رابط خاص سري، صفحة عربية أنيقة، وتنحفظ PDF من زر الطباعة.
const crypto = require('crypto');
const db = require('./db');
const U = require('./util');
const C = require('./config');
const { T } = require('./tools');

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const def = (name, description, input_schema, handler) => { T[name] = { name, description, input_schema, handler }; };

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Markdown مبسط وآمن → HTML
function inline(t) {
  return esc(t)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = []; let i = 0;
  const isTable = l => /^\s*\|.*\|\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { const n = Math.min(m[1].length + 1, 5); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (isTable(l)) {
      const rows = []; while (i < lines.length && isTable(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const body = rows.filter(r => !(/^[\s|:\-]+$/.test(r) && r.includes('--')));
      const [head, ...rest] = body;
      out.push(`<div class="tw"><table><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(l)) { const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]/.test(l), items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(x => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*>|\s*([-*•]|\d+[.)])\s+|\s*---\s*$)/.test(lines[i])) p.push(lines[i++]);
    out.push(`<p>${p.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

const KINDS = { report: '📊 تقرير', study: '📈 دراسة', letter: '✉️ خطاب', cv: '👤 سيرة ذاتية', itinerary: '✈️ برنامج رحلة', plan: '🗂️ خطة', guide: '🧭 دليل', contract: '📜 عقد', other: '📄 مستند' };

function page(r, { print = false } = {}) {
  const meta = typeof r.meta === 'string' ? JSON.parse(r.meta || '{}') : (r.meta || {});
  const d = new Date(r.created_at || Date.now());
  const greg = U.fmt(d).slice(0, 10), hij = require('./world').hijri(d);
  const isLetter = r.kind === 'letter';
  const head = isLetter
    ? `<div class="lhead"><div class="ldate">التاريخ: ${hij}<br>الموافق: ${greg}</div>${meta.to ? `<div class="lto">${esc(meta.to).replace(/\n/g, '<br>')}</div>` : ''}${meta.subject ? `<div class="lsub">الموضوع: ${esc(meta.subject)}</div>` : ''}</div>`
    : `<header><div class="kind">${KINDS[r.kind] || KINDS.other}</div><h1>${esc(r.title)}</h1><div class="date">${greg} — ${hij}${meta.author ? ' · ' + esc(meta.author) : ''}</div></header>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.title)}</title><meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#1d2433;--mute:#5d6678;--line:#e3e7ef;--acc:#0f6e5c;--bg:#f6f7fb;--card:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.85 "IBM Plex Sans Arabic",system-ui,sans-serif}
.wrap{max-width:860px;margin:24px auto;background:var(--card);padding:44px 52px;border-radius:14px;box-shadow:0 2px 18px rgba(20,30,60,.07)}
header{border-bottom:3px solid var(--acc);padding-bottom:14px;margin-bottom:22px}.kind{color:var(--acc);font-weight:700;font-size:14px}
h1{margin:6px 0 4px;font-size:28px;line-height:1.4}.date{color:var(--mute);font-size:13px}
h2{font-size:21px;margin:30px 0 10px;color:var(--acc);border-bottom:1px solid var(--line);padding-bottom:6px}h3{font-size:18px;margin:22px 0 8px}h4,h5{font-size:16px;margin:16px 0 6px}
p{margin:10px 0}ul,ol{padding-inline-start:22px;margin:8px 0}li{margin:4px 0}a{color:#1b5fc1;word-break:break-word}
blockquote{margin:14px 0;padding:10px 16px;background:#f0f7f5;border-inline-start:4px solid var(--acc);border-radius:6px}
.tw{overflow-x:auto;margin:14px 0}table{border-collapse:collapse;width:100%;font-size:14.5px}th,td{border:1px solid var(--line);padding:8px 10px;text-align:right;vertical-align:top}
th{background:#eef3f2;font-weight:700}tr:nth-child(even) td{background:#fafbfd}hr{border:0;border-top:1px solid var(--line);margin:24px 0}code{background:#f1f3f8;padding:1px 5px;border-radius:4px}
.lhead{margin-bottom:26px}.ldate{text-align:left;color:var(--mute);font-size:14px;margin-bottom:22px}.lto{font-weight:600;margin-bottom:14px}.lsub{font-weight:700;text-decoration:underline;text-align:center;margin:18px 0}
.sign{margin-top:40px;text-align:left;font-weight:600;white-space:pre-line}
.bar{max-width:860px;margin:16px auto 0;display:flex;gap:8px;justify-content:flex-start;padding:0 6px}
.bar button{font:inherit;border:0;border-radius:10px;padding:9px 16px;background:var(--acc);color:#fff;cursor:pointer}.bar .ghost{background:#e6ebf3;color:var(--ink)}
footer{margin-top:34px;padding-top:12px;border-top:1px solid var(--line);color:var(--mute);font-size:12px;text-align:center}
@media (max-width:640px){.wrap{margin:10px;padding:22px 18px}h1{font-size:23px}body{font-size:15.5px}}
@media print{body{background:#fff}.bar{display:none}.wrap{box-shadow:none;margin:0;max-width:none;padding:0}@page{size:A4;margin:16mm}a{color:inherit;text-decoration:none}h2{break-after:avoid}tr,blockquote{break-inside:avoid}}
</style></head><body>
<div class="bar"><button onclick="window.print()">⬇️ حفظ PDF / طباعة</button><button class="ghost" onclick="navigator.share?navigator.share({title:document.title,url:location.href}):navigator.clipboard.writeText(location.href).then(()=>alert('انسخ الرابط ✅'))">↗️ مشاركة</button></div>
<main class="wrap">${head}${md(r.body)}${isLetter && meta.signature ? `<div class="sign">${esc(meta.signature)}</div>` : ''}<footer>${isLetter ? '' : 'أُعدّ بواسطة سكرتيري · ' + greg}</footer></main>
${print ? '<script>window.onload=()=>setTimeout(()=>window.print(),400)</script>' : ''}
</body></html>`;
}

async function publish({ kind = 'report', title, content, to, subject, signature }) {
  if (!title || !content) throw new Error('لازم عنوان ومحتوى');
  const token = crypto.randomBytes(12).toString('hex');
  const s = await db.getSettings();
  const meta = { to, subject, signature: signature || (kind === 'letter' ? ((s.profile || {}).signature || (s.profile || {}).name || '') : ''), author: (s.profile || {}).name || '' };
  const r = await db.insert('reports', { token, kind: KINDS[kind] ? kind : 'other', title, body: content, meta: JSON.stringify(meta) }, ['token', 'kind', 'title', 'body', 'meta']);
  await db.log('report', `${KINDS[kind] || '📄'} «${title}» #${r.id}`);
  const url = `${C.PUBLIC_URL}/r/${token}`;
  return { ok: true, id: r.id, url, message: `✅ المستند جاهز: ${url}\n(يفتح في الجوال، وفيه زر «حفظ PDF / طباعة»)` };
}

async function render(token, opts = {}) {
  if (!/^[a-f0-9]{24}$/.test(String(token))) return null;
  const r = await db.one('SELECT * FROM reports WHERE token=$1', [token]);
  return r ? page(r, opts) : null;
}

def('publish_document', 'حوّل أي محتوى طويل لمستند احترافي برابط خاص يفتح في الجوال ويحفظ PDF: تقرير بحث، دراسة جدوى، مقارنة شاملة، خطة، دليل خطوات، برنامج رحلة، خطاب رسمي، سيرة ذاتية، عقد. اكتب المحتوى بـ Markdown (عناوين ##، جداول |، قوائم -، **عريض**، روابط). للخطاب: kind=letter مع to و subject (والتوقيع تلقائي). أرسل الرابط للمالك مع ملخص قصير.',
  S({ kind: str('report | study | letter | cv | itinerary | plan | guide | contract | other'), title: str('العنوان'), content: str('المحتوى كامل بـ Markdown'), to: str('للخطاب: المرسل إليه (سطر أو أكثر)'), subject: str('للخطاب: الموضوع'), signature: str('للخطاب: التوقيع (اختياري)') }, ['title', 'content']),
  async (a) => publish(a));
def('list_documents_published', 'المستندات والتقارير اللي جهزتها للمالك (روابطها).', S({}),
  async () => (await db.many('SELECT id, kind, title, token, created_at FROM reports ORDER BY id DESC LIMIT 20')).map(r => ({ id: r.id, kind: KINDS[r.kind] || r.kind, title: r.title, url: `${C.PUBLIC_URL}/r/${r.token}`, date: U.fmt(r.created_at).slice(0, 10) })));

module.exports = { publish, render, md, page };
