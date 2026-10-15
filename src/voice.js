// تحويل الرسائل الصوتية لنص: Groq أو OpenAI (إذا فيه مفتاح) وإلا Whisper على نفس السيرفر
const db = require('./db');

const ext = mime => /ogg|opus/.test(mime) ? 'ogg' : /mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /wav/.test(mime) ? 'wav' : /webm/.test(mime) ? 'webm' : 'ogg';

async function cloud(url, key, model, buf, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'audio/ogg' }), 'voice.' + ext(mime));
  fd.append('model', model);
  fd.append('language', 'ar');
  fd.append('response_format', 'json');
  fd.append('prompt', 'محادثة باللهجة السعودية: مواعيد، تذكير، رسائل، حجوزات، فلوس.');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal: AbortSignal.timeout(60000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'HTTP ' + r.status);
  return d.text || '';
}

async function local(buf, mime) {
  const base = (process.env.WHISPER_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('خدمة الصوت غير مفعلة');
  const fd = new FormData();
  fd.append('audio_file', new Blob([buf], { type: mime || 'audio/ogg' }), 'voice.' + ext(mime));
  const r = await fetch(`${base}/asr?task=transcribe&language=ar&output=json&encode=true&vad_filter=true`, { method: 'POST', body: fd, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error('Whisper HTTP ' + r.status);
  const t = await r.text();
  try { return JSON.parse(t).text || ''; } catch (_) { return t; }
}

// يرجع النص المكتوب من الصوت
async function transcribe(base64, mime = 'audio/ogg') {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > 24e6) throw new Error('الرسالة الصوتية طويلة جداً');
  const s = await db.getSettings().catch(() => ({}));
  const groq = process.env.GROQ_API_KEY || s.groq_key, openai = process.env.OPENAI_API_KEY || s.openai_key;
  const tries = [];
  if (groq) tries.push(() => cloud(process.env.GROQ_STT_URL || 'https://api.groq.com/openai/v1/audio/transcriptions', groq, 'whisper-large-v3-turbo', buf, mime));
  if (openai) tries.push(() => cloud(process.env.OPENAI_STT_URL || 'https://api.openai.com/v1/audio/transcriptions', openai, 'whisper-1', buf, mime));
  if (process.env.WHISPER_URL) tries.push(() => local(buf, mime));
  if (!tries.length) throw new Error('فهم الصوت غير مفعل');
  let last;
  for (const t of tries) {
    try { const text = String(await t()).trim(); if (text) return text; } catch (e) { last = e; console.error('stt', e.message); }
  }
  throw last || new Error('ما قدرت أفهم الصوت');
}

const enabled = async () => !!(process.env.WHISPER_URL || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || (await db.getSettings().catch(() => ({}))).groq_key);

module.exports = { transcribe, enabled };
