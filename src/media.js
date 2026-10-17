// صور وملفات المالك ← أي صيغة يبيها: PDF فوري (بدون ذكاء اصطناعي)، وأي صيغة ثانية عن طريق وكيل الملفات
// (Word، Excel، PowerPoint، PNG/JPG/WEBP/TIFF/GIF/ICO، نص مستخرج، ضغط، دمج، تقسيم، تغيير مقاس...).
// + تجميع الصور اللي تنرسل ورا بعض (ألبوم) في طلب واحد.
const crypto = require('crypto');
const C = require('./config');
const db = require('./db');
const U = require('./util');
const { T } = require('./tools');

// ---------- حفظ صور المالك ----------
const extOf = mime => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' }[mime] || 'bin');
async function saveOwnerMedia(buf, mime, name) {
  const token = crypto.randomBytes(12).toString('hex');
  const nm = name || `photo-${U.riyadhDay()}-${token.slice(0, 4)}.${extOf(mime)}`;
  await db.q("INSERT INTO files (token, name, mime, size, data, source) VALUES ($1,$2,$3,$4,$5,'owner_media')", [token, nm, mime, buf.length, buf]);
  return token;
}
const short = t => 'm_' + t.slice(0, 10);
async function resolve(refs) {
  const out = [];
  for (const r of refs || []) {
    const t = String(r).replace(/^m_/, '');
    const f = await db.one("SELECT id, token, name, mime, size, data, anthropic_id FROM files WHERE token LIKE $1 || '%' AND source IN ('owner_media','owner') ORDER BY id DESC LIMIT 1", [t]);
    if (f) { if (typeof f.data === 'string') f.data = f.data.startsWith('\\x') ? Buffer.from(f.data.slice(2), 'hex') : Buffer.from(f.data, 'binary'); out.push(f); }
  }
  return out;
}
async function recent({ minutes = 180, count } = {}) {
  const rows = await db.many("SELECT token, name, mime, size, created_at FROM files WHERE source='owner_media' AND created_at > now() - ($1 || ' minutes')::interval ORDER BY id DESC LIMIT $2", [minutes, count || 30]);
  return rows.reverse();
}

// ---------- JPEG: المقاس واتجاه الصورة ----------
function jpegInfo(b) {
  if (!(b[0] === 0xFF && b[1] === 0xD8)) return null;
  let i = 2, orient = 1, w, h, comps;
  while (i < b.length - 9) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m === 0xE1 && b.toString('latin1', i + 4, i + 8) === 'Exif') orient = exifOrientation(b, i + 10) || orient;
    if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); comps = b[i + 9]; break; }
    i += 2 + len;
  }
  return w && h ? { w, h, comps, orient } : null;
}
function exifOrientation(b, t) {
  try {
    const le = b.toString('latin1', t, t + 2) === 'II';
    const r16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), r32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
    const ifd = t + r32(t + 4), n = r16(ifd);
    for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (r16(e) === 0x0112) return r16(e + 8); }
  } catch (_) {}
  return 1;
}

// ---------- صور ← PDF (بدون أي مكتبة) ----------
const PAGES = { a4: [595.28, 841.89], letter: [612, 792], a5: [419.53, 595.28] };
function imagesToPdf(images, { page = 'a4', orientation = 'auto', marginPt = 18 } = {}) {
  const objs = []; // [content Buffer]
  const add = buf => { objs.push(buf); return objs.length; };
  const catalogId = add(null), pagesId = add(null);
  const kids = [];
  for (const img of images) {
    const info = jpegInfo(img);
    if (!info) throw new Error('صورة مو JPEG');
    const rot = [5, 6, 7, 8].includes(info.orient);
    const dw = rot ? info.h : info.w, dh = rot ? info.w : info.h; // المقاس بعد التدوير
    let pw, ph, m = marginPt;
    if (page === 'original') { const s = Math.min(1, 842 / Math.max(dw, dh)); pw = dw * s; ph = dh * s; m = 0; }
    else { const [a, b] = PAGES[page] || PAGES.a4; const land = orientation === 'landscape' || (orientation === 'auto' && dw > dh); pw = land ? b : a; ph = land ? a : b; }
    const s = Math.min((pw - 2 * m) / dw, (ph - 2 * m) / dh);
    const W = dw * s, Hh = dh * s, x = (pw - W) / 2, y = (ph - Hh) / 2;
    const f = n => (Math.round(n * 100) / 100).toString();
    const cm = info.orient === 6 ? [0, -Hh, W, 0, x, y + Hh] : info.orient === 8 ? [0, Hh, -W, 0, x + W, y] : info.orient === 3 ? [-W, 0, 0, -Hh, x + W, y + Hh] : [W, 0, 0, Hh, x, y];
    const cs = info.comps === 1 ? '/DeviceGray' : info.comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
    const imgId = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${info.w} /Height ${info.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`, 'latin1'), img, Buffer.from('\nendstream', 'latin1')]));
    const content = `q ${cm.map(f).join(' ')} cm /Im0 Do Q`;
    const contId = add(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, 'latin1'));
    kids.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contId} 0 R >>`, 'latin1')));
  }
  objs[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1');
  objs[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`, 'latin1');
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let off = parts[0].length; const xref = [];
  objs.forEach((o, i) => { const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), tail = Buffer.from('\nendobj\n', 'latin1'); xref.push(off); parts.push(head, o, tail); off += head.length + o.length + tail.length; });
  const xr = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + xref.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(Buffer.from(xr, 'latin1'));
  return Buffer.concat(parts);
}

// ---------- تجميع الصور اللي تنرسل ورا بعض ----------
const albums = new Map();
// يرجع true إذا الرسالة انضافت لألبوم (والمعالجة بتصير بعد ثواني لما تكتمل الصور)
function collect(key, { image, text }, onFlush, ms = 5000) {
  let a = albums.get(key);
  if (!image && !a) return false;
  if (!a) { a = { images: [], texts: [] }; albums.set(key, a); }
  if (image) a.images.push(image);
  if (text) a.texts.push(text);
  clearTimeout(a.timer);
  const flush = () => { albums.delete(key); onFlush(a.images, a.texts.join('\n').trim()); };
  if (!image) flush(); else a.timer = setTimeout(flush, ms);
  return true;
}
// يحفظ الصور ويكتب ملاحظة للمدير فيها مراجعها
async function prepareImages(images, text) {
  const refs = [];
  for (const im of images) refs.push(short(await saveOwnerMedia(Buffer.from(im.source.data, 'base64'), im.source.media_type)));
  const note = `[${images.length === 1 ? 'صورة' : images.length + ' صور'} من المالك محفوظة: ${refs.join(', ')}] — لو طلب تحويلها لأي صيغة: PDF ← images_to_pdf، وأي صيغة ثانية ← convert_files.`;
  return { text: `${text || (images.length > 1 ? 'أرسلت لك هالصور' : 'تعامل مع المرفق')}\n\n${note}`, attachments: images.slice(0, 8), refs };
}

// ---------- الأدوات ----------
const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const refsSchema = { type: 'array', items: { type: 'string' }, description: 'مراجع الصور/الملفات (m_...) — أو اتركها فاضية وحدد count لآخر الصور' };
async function pick(refs, count) {
  if (refs && refs.length) return resolve(refs);
  const rows = await recent({ count: count || 1 });
  return resolve(rows.map(r => r.token));
}
const sendToOwner = async (ctx, saved, buf, caption) => require('./power').sendFileToOwner(ctx.channel, saved, buf, caption);

T.my_recent_images = { name: 'my_recent_images', description: 'الصور اللي أرسلها المالك مؤخراً (آخر 3 ساعات) مع مراجعها m_... — للتحويل أو الدمج.', input_schema: S({}),
  handler: async () => (await recent({})).map(r => ({ ref: short(r.token), name: r.name, kb: Math.round(r.size / 1024), at: U.fmt(r.created_at) })) };

T.images_to_pdf = { name: 'images_to_pdf', description: 'يحوّل صورة أو عدة صور للمالك إلى ملف PDF واحد فوراً (كل صورة صفحة) ويرسله له. للـ PDF فقط؛ أي صيغة ثانية convert_files.',
  input_schema: S({ refs: refsSchema, count: { type: 'integer', description: 'آخر كم صورة (لو ما فيه refs)' }, page: { type: 'string', enum: ['a4', 'letter', 'a5', 'original'], description: 'a4 (افتراضي) أو original = بمقاس الصورة' }, orientation: { type: 'string', enum: ['auto', 'portrait', 'landscape'] }, margin_mm: { type: 'number' }, file_name: str('اسم الملف بدون امتداد') }),
  handler: async ({ refs, count, page = 'a4', orientation = 'auto', margin_mm = 6, file_name }, ctx) => {
    if (!ctx.byOwner) throw new Error('للمالك فقط');
    const files = (await pick(refs, count)).filter(f => /^image\//.test(f.mime));
    if (!files.length) throw new Error('ما لقيت صور — اطلب من المالك يرسلها');
    if (files.some(f => !jpegInfo(f.data))) return 'فيه صور مو JPEG — استخدم convert_files بنفس المراجع وtarget=pdf.';
    const pdf = imagesToPdf(files.map(f => f.data), { page, orientation, marginPt: Math.max(0, Number(margin_mm) || 0) * 2.835 });
    const name = (String(file_name || `مستند-${U.riyadhDay()}`).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)) + '.pdf';
    const saved = await require('./power').saveFile({ name, mime: 'application/pdf', buf: pdf });
    const sent = await sendToOwner(ctx, saved, pdf, `📕 ${name} — ${files.length} صفحة`);
    await db.log('file', `📕 PDF من ${files.length} صورة: ${name}`);
    return { ok: true, pages: files.length, size_kb: Math.round(pdf.length / 1024), sent_as_file: sent, url: saved.url, note: sent ? 'انرسل للمالك كملف' : 'أعطِ المالك الرابط' };
  } };

T.convert_files = { name: 'convert_files', description: 'يحوّل صور/ملفات المالك لأي صيغة يطلبها (Word، Excel، PowerPoint، PNG، JPG، WEBP، TIFF، GIF، ICO، نص مستخرج OCR، PDF بتنسيق خاص، ضغط/تصغير، دمج، تقسيم، قص، تغيير مقاس، أبيض وأسود، شكل «سكانر»...) عن طريق وكيل الملفات، ويرسل الناتج للمالك.',
  input_schema: S({ refs: refsSchema, count: { type: 'integer' }, target: str('الصيغة المطلوبة مثل docx أو xlsx أو png أو "نص"'), instructions: str('تفاصيل المالك: المقاس، الجودة، الاسم، الترتيب، اللغة...') }, ['target']),
  handler: async ({ refs, count, target, instructions }, ctx) => {
    if (!ctx.byOwner) throw new Error('للمالك فقط');
    const files = await pick(refs, count);
    if (!files.length) throw new Error('ما لقيت الملفات — اطلب من المالك يرسلها');
    const P = require('./power');
    const fileIds = [];
    for (const f of files) {
      let id = f.anthropic_id;
      if (!id) { id = await P.uploadToAnthropic(f.data, f.name, f.mime); await db.q('UPDATE files SET anthropic_id=$2 WHERE id=$1', [f.id, id]); }
      fileIds.push(id);
    }
    const images = files.filter(f => f.data && /^image\/(jpeg|png|webp|gif)$/.test(f.mime) && f.data.length < 4.5e6).slice(0, 6)
      .map(f => ({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } }));
    const task = `حوّل ملفات المالك المرفقة (${files.map(f => f.name).join('، ')}) إلى: ${target}.
${instructions ? 'تفاصيل المالك: ' + instructions : ''}
- الملفات موجودة في مجلد العمل بالحاوية${images.length ? '، وتقدر تشوف الصور هنا كمان (لو تحتاج تقرأ النص اللي فيها اقرأه من الصورة بنفسك بدقة)' : ''}.
- النتيجة ملف/ملفات بالصيغة المطلوبة بجودة عالية واسم واضح. العربي RTL وبخط يدعم العربي.
- لو الصيغة ما تنفع أو تحتاج أداة مو موجودة، جرّب بديل قريب وقل وش سويت.`;
    return require('./agents').runSpecialist('builder', task, { byOwner: true, channel: ctx.channel, fileIds, extraBlocks: images });
  } };

module.exports = { saveOwnerMedia, recent, resolve, jpegInfo, imagesToPdf, collect, prepareImages };
