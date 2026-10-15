// القوة التنفيذية: ملفات Excel/PowerPoint/Word/PDF وتحليل بيانات وتشغيل كود (في حاوية Anthropic الآمنة)،
// استقبال أي ملف من المالك لتحليله، وربط خدمات خارجية عبر MCP (GitHub، Zapier لآلاف التطبيقات، Notion...)
const crypto = require('crypto');
const db = require('./db');
const U = require('./util');
const C = require('./config');
const ch = require('./channels');
const { T } = require('./tools');

const API = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
const H = (beta) => ({ 'x-api-key': C.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', ...(beta ? { 'anthropic-beta': 'files-api-2025-04-14' } : {}) });
// Files API: لو رفض الطلب نعيده مع ترويسة النسخة التجريبية
async function af(path, opts = {}, ms = 60000) {
  let r = await fetch(API() + path, { ...opts, headers: H(), signal: AbortSignal.timeout(ms) });
  if ([400, 403, 404].includes(r.status)) r = await fetch(API() + path, { ...opts, headers: H(true), signal: AbortSignal.timeout(ms) });
  return r;
}
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', json: 'application/json', html: 'text/html', md: 'text/markdown', zip: 'application/zip', svg: 'image/svg+xml', mp3: 'audio/mpeg', mp4: 'video/mp4' };
const mimeOf = name => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
const ICON = n => /\.xlsx?$|\.csv$/i.test(n) ? '📊' : /\.pptx?$/i.test(n) ? '📽️' : /\.docx?$/i.test(n) ? '📝' : /\.pdf$/i.test(n) ? '📕' : /\.(png|jpe?g|svg|gif|webp)$/i.test(n) ? '🖼️' : '📎';

// ---------- ملفات Anthropic ----------
const fileMeta = fileId => af(`/v1/files/${fileId}`, {}, 30000).then(r => r.json()).catch(() => ({}));
async function fetchAnthropicFile(fileId, meta) {
  meta = meta || await fileMeta(fileId);
  const r = await af(`/v1/files/${fileId}/content`, {}, 120000);
  if (!r.ok) throw new Error('تعذر تحميل الملف ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const name = meta.filename || fileId;
  return { name, mime: meta.mime_type || mimeOf(name), buf };
}
async function uploadToAnthropic(buf, name, mime) {
  const mk = () => { const fd = new FormData(); fd.append('file', new Blob([buf], { type: mime || mimeOf(name) }), name); return fd; };
  let r = await fetch(`${API()}/v1/files`, { method: 'POST', headers: H(), body: mk(), signal: AbortSignal.timeout(120000) });
  if ([400, 403, 404].includes(r.status)) r = await fetch(`${API()}/v1/files`, { method: 'POST', headers: H(true), body: mk(), signal: AbortSignal.timeout(120000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error('تعذر رفع الملف: ' + ((d.error && d.error.message) || r.status));
  return d.id;
}

// ---------- تخزين الملفات وروابطها ----------
async function saveFile({ name, mime, buf }) {
  const token = crypto.randomBytes(12).toString('hex');
  await db.q('INSERT INTO files (token, name, mime, size, data) VALUES ($1,$2,$3,$4,$5)', [token, name, mime, buf.length, buf]);
  return { token, url: `${C.PUBLIC_URL}/f/${token}`, name, mime, size: buf.length };
}
async function getFile(token) {
  if (!/^[a-f0-9]{24}$/.test(String(token))) return null;
  const f = await db.one('SELECT name, mime, data FROM files WHERE token=$1', [token]);
  if (f && typeof f.data === 'string') f.data = f.data.startsWith('\\x') ? Buffer.from(f.data.slice(2), 'hex') : Buffer.from(f.data, 'binary');
  return f;
}

// يرسل الملف نفسه للمالك على قناته (واتساب/تيليجرام)، وإلا الرابط
async function sendFileToOwner(channel, f, buf, caption) {
  try {
    if (channel === 'telegram' && ch.tgEnabled()) {
      const id = await ch.ownerTelegramId();
      if (id) {
        const fd = new FormData();
        fd.append('chat_id', String(id)); fd.append('caption', (caption || f.name).slice(0, 1000));
        fd.append('document', new Blob([buf], { type: f.mime }), f.name);
        const r = await fetch(`${ch.TG_BASE}/bot${C.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) }).then(x => x.json());
        if (r.ok) return true;
      }
    }
    if (channel === 'whatsapp' && ch.evoEnabled() && C.OWNER_PHONE) {
      const isImg = /^image\//.test(f.mime);
      await ch.evo('POST', `/message/sendMedia/${C.EVOLUTION_INSTANCE}`, { number: C.OWNER_PHONE, mediatype: isImg ? 'image' : 'document', mimetype: f.mime, caption: (caption || f.name).slice(0, 1000), media: buf.toString('base64'), fileName: f.name });
      return true;
    }
  } catch (e) { console.error('send file', e.message); }
  return false;
}

// بعد ما يخلص الوكيل: ننزل ملفاته، نحفظها، ونرسلها للمالك
const JUNK = /\.(py|pyc|sh|js|log|ipynb|tmp)$|^(tmp|temp)|~\$/i;
async function deliver(fileIds, channel) {
  // نجيب الأسماء أول: نشيل السكربتات والملفات المؤقتة، ولو انحفظ نفس الملف أكثر من مرة نأخذ آخر نسخة
  const byName = new Map();
  for (const id of [...new Set(fileIds || [])].slice(-30)) {
    const meta = await fileMeta(id);
    const name = meta.filename || id;
    if (JUNK.test(name.split('/').pop())) continue;
    byName.delete(name); byName.set(name, { id, meta });
  }
  const out = [];
  for (const { id, meta } of [...byName.values()].slice(-8)) {
    try {
      const f = await fetchAnthropicFile(id, meta);
      const saved = await saveFile(f);
      const sent = await sendFileToOwner(channel, saved, f.buf, `${ICON(f.name)} ${f.name}`);
      out.push({ ...saved, sent });
      await db.log('file', `${ICON(f.name)} ملف جاهز: ${f.name}`);
    } catch (e) { console.error('deliver', e.message); }
  }
  return out;
}

// ---------- ملفات المالك (Excel/Word/CSV/...) للتحليل ----------
async function ownerUpload(buf, name, mime) {
  const fileId = await uploadToAnthropic(buf, name, mime);
  await db.q("INSERT INTO files (token, name, mime, size, anthropic_id, source) VALUES ($1,$2,$3,$4,$5,'owner')", [crypto.randomBytes(12).toString('hex'), name, mime || mimeOf(name), buf.length, fileId]);
  return fileId;
}

// ---------- خدمات MCP الخارجية ----------
async function mcpServers() {
  const list = (await db.getSettings()).mcp_servers || [];
  return list.filter(m => m && m.enabled !== false && /^https:\/\//.test(m.url || '') && /^[a-z0-9_-]{2,40}$/i.test(m.name || ''));
}
async function mcpSave(list) {
  const clean = (list || []).filter(m => m && m.name && m.url).map(m => ({ name: String(m.name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40), url: String(m.url).trim(), token: m.token ? String(m.token).trim() : undefined, enabled: m.enabled !== false, label: m.label || m.name }));
  for (const m of clean) if (!/^https:\/\//.test(m.url)) throw new Error('رابط الخدمة لازم يبدأ بـ https://');
  if (new Set(clean.map(m => m.name)).size !== clean.length) throw new Error('فيه اسمين متكررين');
  await db.setSetting('mcp_servers', clean);
  return clean;
}

// فحص اتصال خدمة MCP (بروتوكول Streamable HTTP): initialize ثم tools/list
function rpcParse(t) {
  try { return JSON.parse(t); } catch (_) {}
  const lines = String(t).split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
  for (const l of lines.reverse()) { try { const j = JSON.parse(l); if (j.result || j.error) return j; } catch (_) {} }
  return null;
}
async function mcpTest(m) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(m.token ? { authorization: 'Bearer ' + m.token } : {}) };
  const post = (body, extra = {}) => fetch(m.url, { method: 'POST', headers: { ...h, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  try {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sakrtir', version: '1.0' } } });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'الرمز (Token) غلط أو ما له صلاحية' };
    if (!r.ok) return { ok: false, error: 'الخدمة ردت بخطأ ' + r.status };
    const init = rpcParse(await r.text());
    if (!init || init.error) return { ok: false, error: (init && init.error && init.error.message) || 'الرابط مو خدمة MCP' };
    const sid = r.headers.get('mcp-session-id');
    const sh = sid ? { 'mcp-session-id': sid } : {};
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sh).catch(() => {});
    const lr = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sh);
    const list = rpcParse(await lr.text());
    const tools = (list && list.result && list.result.tools) || [];
    return { ok: true, server: (init.result.serverInfo && init.result.serverInfo.name) || m.name, tools: tools.length, sample: tools.slice(0, 8).map(t => t.name) };
  } catch (e) { return { ok: false, error: /timeout|abort/i.test(e.message) ? 'الخدمة ما ردت (انتهى الوقت)' : 'ما قدرت أوصل للرابط' }; }
}

// ---------- الأدوات ----------
const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
T.list_files = { name: 'list_files', description: 'الملفات اللي جهزتها للمالك أو أرسلها هو (Excel، PowerPoint، Word، PDF...) مع روابطها.', input_schema: S({}),
  handler: async () => (await db.many('SELECT name, token, size, source, anthropic_id, created_at FROM files ORDER BY id DESC LIMIT 25')).map(f => ({ name: f.name, from: f.source === 'owner' ? 'المالك' : 'السكرتير', url: f.source === 'owner' ? null : `${C.PUBLIC_URL}/f/${f.token}`, file_id: f.anthropic_id, date: U.fmt(f.created_at).slice(0, 10) })) };

module.exports = { mcpTest, fileMeta, deliver, saveFile, getFile, ownerUpload, uploadToAnthropic, fetchAnthropicFile, sendFileToOwner, mcpServers, mcpSave, mimeOf };
