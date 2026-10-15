// قراءة Gmail وتقويم Google مباشرة باستخدام نفس حساب Google المربوط في n8n
// (نفك تشفير بيانات الربط من قاعدة n8n بمفتاح N8N_ENCRYPTION_KEY ونجدد التوكن بأنفسنا)
const crypto = require('crypto');
const db = require('./db');

const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GMAIL = (process.env.GOOGLE_API_BASE || 'https://gmail.googleapis.com') + '/gmail/v1/users/me';
const GCAL = (process.env.GOOGLE_API_BASE || 'https://www.googleapis.com') + '/calendar/v3';
const TYPES = {
  gmail: ['gmailOAuth2', 'googleOAuth2Api'],
  calendar: ['googleCalendarOAuth2Api', 'googleOAuth2Api']
};
const cache = {}; // kind -> { token, exp }

// نفس تشفير n8n (OpenSSL "Salted__" + AES-256-CBC + اشتقاق MD5)
function n8nDecrypt(data, key) {
  const input = Buffer.from(data, 'base64');
  if (input.subarray(0, 8).toString() !== 'Salted__') throw new Error('صيغة تشفير غير معروفة');
  const salt = input.subarray(8, 16);
  const password = Buffer.concat([Buffer.from(key, 'binary'), salt]);
  const h1 = crypto.createHash('md5').update(password).digest();
  const h2 = crypto.createHash('md5').update(Buffer.concat([h1, password])).digest();
  const iv = crypto.createHash('md5').update(Buffer.concat([h2, password])).digest();
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.concat([h1, h2]), iv);
  return JSON.parse(Buffer.concat([d.update(input.subarray(16)), d.final()]).toString('utf8'));
}
function n8nEncrypt(obj, key) { // للاختبارات
  const salt = crypto.randomBytes(8);
  const password = Buffer.concat([Buffer.from(key, 'binary'), salt]);
  const h1 = crypto.createHash('md5').update(password).digest();
  const h2 = crypto.createHash('md5').update(Buffer.concat([h1, password])).digest();
  const iv = crypto.createHash('md5').update(Buffer.concat([h2, password])).digest();
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.concat([h1, h2]), iv);
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(JSON.stringify(obj), 'utf8'), c.final()]).toString('base64');
}

async function credential(kind) {
  const key = process.env.N8N_ENCRYPTION_KEY;
  if (!key) throw new Error('حساب Google غير مربوط (مفتاح n8n غير موجود)');
  const rows = await db.many('SELECT type, data FROM n8n.credentials_entity WHERE type = ANY($1)', [TYPES[kind]]).catch(() => []);
  rows.sort((a, b) => TYPES[kind].indexOf(a.type) - TYPES[kind].indexOf(b.type));
  for (const r of rows) {
    try {
      const c = n8nDecrypt(r.data, key);
      const t = c.oauthTokenData || {};
      if (c.clientId && c.clientSecret && t.refresh_token) return c;
    } catch (_) {}
  }
  throw new Error(kind === 'gmail' ? 'Gmail غير مربوط في n8n' : 'تقويم Google غير مربوط في n8n');
}

async function token(kind) {
  const c = cache[kind];
  if (c && c.exp > Date.now() + 60000) return c.token;
  const cred = await credential(kind);
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cred.clientId, client_secret: cred.clientSecret, refresh_token: cred.oauthTokenData.refresh_token, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(20000)
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error('ما قدرت أجدد صلاحية Google: ' + (d.error_description || d.error || res.status) + ' — افتح n8n وأعد ربط حساب Google');
  cache[kind] = { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3000) * 1000 };
  return d.access_token;
}

async function greq(kind, method, url, body) {
  const res = await fetch(url, {
    method, headers: { Authorization: 'Bearer ' + await token(kind), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000)
  });
  const d = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401) delete cache[kind];
  if (!res.ok) throw new Error(`Google ${res.status}: ${(d.error && d.error.message) || ''}`.slice(0, 200));
  return d;
}
const gget = (kind, url) => greq(kind, 'GET', url);

const header = (m, n) => ((m.payload && m.payload.headers) || []).find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

async function gmailSearch({ query = 'newer_than:1d', max = 15 } = {}) {
  const list = await gget('gmail', `${GMAIL}/messages?maxResults=${Math.min(Number(max) || 15, 30)}&q=${encodeURIComponent(query)}`);
  const ids = (list.messages || []).map(m => m.id);
  const out = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.all(ids.slice(i, i + 5).map(id =>
      gget('gmail', `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => null)));
    for (const m of batch.filter(Boolean)) out.push({
      id: m.id, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'),
      unread: (m.labelIds || []).includes('UNREAD'), snippet: (m.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    });
  }
  return { query, count: out.length, emails: out };
}

function bodyText(part) {
  if (!part) return '';
  const dec = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (part.mimeType === 'text/plain' && part.body && part.body.data) return dec(part.body.data);
  let html = '';
  for (const p of part.parts || []) { const t = bodyText(p); if (t && p.mimeType !== 'text/html') return t; if (p.mimeType === 'text/html' && p.body && p.body.data) html = dec(p.body.data); }
  if (!html && part.mimeType === 'text/html' && part.body && part.body.data) html = dec(part.body.data);
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function gmailRead(id) {
  const m = await gget('gmail', `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
  return { id: m.id, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'), body: bodyText(m.payload).slice(0, 8000) };
}

// ---------- Gmail: إرسال ورد ومسودات وتنظيم ----------
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encWord = t => /^[\x00-\x7F]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t).toString('base64')}?=`;
function mime({ to, cc, subject, body, inReplyTo }) {
  const h = [`To: ${to}`, cc ? `Cc: ${cc}` : '', `Subject: ${encWord(subject || '')}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '', inReplyTo ? `References: ${inReplyTo}` : ''].filter(Boolean);
  return b64url(h.join('\r\n') + '\r\n\r\n' + Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'));
}
async function gmailSend({ to, cc, subject, body }) {
  if (!to) throw new Error('لازم إيميل المستلم');
  const r = await greq('gmail', 'POST', `${GMAIL}/messages/send`, { raw: mime({ to, cc, subject, body }) });
  return { ok: true, id: r.id, threadId: r.threadId };
}
async function gmailReply({ id, body, reply_all = false }) {
  const m = await gget('gmail', `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=To`);
  const subject = header(m, 'Subject'), msgId = header(m, 'Message-ID');
  const to = header(m, 'Reply-To') || header(m, 'From');
  const cc = reply_all ? [header(m, 'To'), header(m, 'Cc')].filter(Boolean).join(', ') : '';
  const r = await greq('gmail', 'POST', `${GMAIL}/messages/send`, { threadId: m.threadId, raw: mime({ to, cc, subject: /^re:/i.test(subject) ? subject : 'Re: ' + subject, body, inReplyTo: msgId }) });
  return { ok: true, id: r.id, to, subject };
}
async function gmailDraft({ to, cc, subject, body }) {
  const r = await greq('gmail', 'POST', `${GMAIL}/drafts`, { message: { raw: mime({ to: to || '', cc, subject, body }) } });
  return { ok: true, draft_id: r.id, note: 'انحفظت مسودة في Gmail — يقدر المالك يراجعها ويرسلها' };
}
const MODS = { read: { removeLabelIds: ['UNREAD'] }, unread: { addLabelIds: ['UNREAD'] }, archive: { removeLabelIds: ['INBOX'] }, inbox: { addLabelIds: ['INBOX'] },
  star: { addLabelIds: ['STARRED'] }, unstar: { removeLabelIds: ['STARRED'] }, important: { addLabelIds: ['IMPORTANT'] }, not_important: { removeLabelIds: ['IMPORTANT'] }, spam: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } };
async function gmailModify({ ids, action }) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).slice(0, 50);
  if (!list.length) throw new Error('ما فيه إيميلات');
  if (action === 'trash') { for (const id of list) await greq('gmail', 'POST', `${GMAIL}/messages/${encodeURIComponent(id)}/trash`); return { ok: true, action, count: list.length }; }
  if (!MODS[action]) throw new Error('إجراء غير معروف');
  await greq('gmail', 'POST', `${GMAIL}/messages/batchModify`, { ids: list, ...MODS[action] });
  return { ok: true, action, count: list.length };
}

// ---------- التقويم: إضافة وتعديل وحذف وأوقات فاضية ----------
const TZ = 'Asia/Riyadh';
const isoLocal = d => new Date(new Date(d).getTime() + 3 * 3600e3).toISOString().slice(0, 19); // بتوقيت الرياض بدون Z
function evBody({ title, start, end, location, description, attendees, reminder_minutes, all_day }) {
  const b = {};
  if (title !== undefined) b.summary = title;
  if (location !== undefined) b.location = location;
  if (description !== undefined) b.description = description;
  if (start) {
    if (all_day) { const d = isoLocal(start).slice(0, 10); b.start = { date: d }; b.end = { date: isoLocal(new Date(new Date(end || start).getTime() + (end ? 0 : 864e5))).slice(0, 10) }; }
    else { b.start = { dateTime: isoLocal(start), timeZone: TZ }; b.end = { dateTime: isoLocal(end || new Date(new Date(start).getTime() + 3600e3)), timeZone: TZ }; }
  }
  if (attendees && attendees.length) b.attendees = attendees.map(e => ({ email: e }));
  if (reminder_minutes !== undefined && reminder_minutes !== null) b.reminders = { useDefault: false, overrides: [].concat(reminder_minutes).map(m => ({ method: 'popup', minutes: Number(m) })) };
  return b;
}
async function calendarCreate(a) {
  if (!a.title || !a.start) throw new Error('لازم عنوان ووقت البداية');
  const e = await greq('calendar', 'POST', `${GCAL}/calendars/primary/events${a.attendees && a.attendees.length ? '?sendUpdates=all' : ''}`, evBody(a));
  return { ok: true, id: e.id, link: e.htmlLink || null, title: e.summary };
}
async function calendarUpdate(a) {
  if (!a.id) throw new Error('لازم معرّف الموعد');
  const e = await greq('calendar', 'PATCH', `${GCAL}/calendars/primary/events/${encodeURIComponent(a.id)}`, evBody(a));
  return { ok: true, id: e.id, title: e.summary };
}
async function calendarDelete(id) { await greq('calendar', 'DELETE', `${GCAL}/calendars/primary/events/${encodeURIComponent(id)}`); return { ok: true, deleted: id }; }
// الأوقات الفاضية بين ساعات العمل لكل يوم في الفترة
async function calendarFree({ from, to, day_start = 8, day_end = 22, min_minutes = 30 }) {
  const evs = (await calendarEvents({ from, to, max: 100 })).filter(e => e.start.includes('T'));
  const out = [];
  for (let d = new Date(from); d < new Date(to); d = new Date(d.getTime() + 864e5)) {
    const day = isoLocal(d).slice(0, 10);
    let cur = new Date(`${day}T${String(day_start).padStart(2, '0')}:00:00+03:00`);
    const stop = new Date(`${day}T${String(day_end).padStart(2, '0')}:00:00+03:00`);
    if (cur < new Date()) cur = new Date(Math.ceil(Date.now() / 9e5) * 9e5);
    const busy = evs.map(e => [new Date(e.start), new Date(e.end)]).filter(([s, e]) => e > cur && s < stop).sort((a, b) => a[0] - b[0]);
    const slots = [];
    for (const [s, e] of busy) { if ((s - cur) / 6e4 >= min_minutes) slots.push([cur, s]); if (e > cur) cur = e; }
    if ((stop - cur) / 6e4 >= min_minutes) slots.push([cur, stop]);
    out.push({ day, free: slots.map(([s, e]) => `${isoLocal(s).slice(11, 16)}–${isoLocal(e).slice(11, 16)}`) });
  }
  return out;
}

async function calendarEvents({ from, to, max = 30 } = {}) {
  const tMin = from ? new Date(from) : new Date(), tMax = to ? new Date(to) : new Date(Date.now() + 7 * 864e5);
  const d = await gget('calendar', `${GCAL}/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=${Math.min(max, 100)}&timeMin=${tMin.toISOString()}&timeMax=${tMax.toISOString()}`);
  return (d.items || []).map(e => ({ id: e.id, title: e.summary || '(بدون عنوان)', start: (e.start && (e.start.dateTime || e.start.date)) || '', end: (e.end && (e.end.dateTime || e.end.date)) || '', location: e.location || '' }));
}

async function status() {
  const out = {};
  for (const k of ['gmail', 'calendar']) { try { await credential(k); out[k] = true; } catch (_) { out[k] = false; } }
  return out;
}

module.exports = { gmailSearch, gmailRead, gmailSend, gmailReply, gmailDraft, gmailModify, calendarEvents, calendarCreate, calendarUpdate, calendarDelete, calendarFree, status, n8nDecrypt, n8nEncrypt };
