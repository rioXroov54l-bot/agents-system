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

async function gget(kind, url) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + await token(kind) }, signal: AbortSignal.timeout(20000) });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) delete cache[kind];
  if (!res.ok) throw new Error(`Google ${res.status}: ${(d.error && d.error.message) || ''}`.slice(0, 200));
  return d;
}

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

module.exports = { gmailSearch, gmailRead, calendarEvents, status, n8nDecrypt, n8nEncrypt };
