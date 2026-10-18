// «طريق الماك» للمواقع السعودية: كثير من المواقع (التأمين، الحكومية، البنوك...) تحجب السيرفرات اللي برا السعودية،
// وسيرفرنا برا. الحل: متصفح وكيل المواقع يطلع للإنترنت عن طريق ماك المالك (إنترنت بيته في السعودية).
//
// كيف يشتغل:
//  1) جسر الجوال على الماك (deploy/phone/phone_bridge.py) يفتح اتصال WebSocket خارج للسيرفر: /phone-bridge/tunnel
//     (نفس رمز الجسر، وما يفتح أي منفذ على الماك).
//  2) هنا داخل السيرفر نشغّل بروكسي SOCKS5 (المنفذ 1080، داخلي فقط) — المتصفح يستخدمه للمواقع اللي تحتاج.
//  3) كل اتصال من المتصفح يمر في الـ WebSocket للماك، والماك يفتح الاتصال للموقع ويرجع البيانات.
// الأمان: الماك يرفض أي عنوان داخلي (شبكة البيت، الراوتر، الماك نفسه) ويقبل المنافذ 80/443 فقط، والسيرفر بعد يقبل 80/443 فقط.
const crypto = require('crypto');
const net = require('net');
const db = require('./db');

const SOCKS_PORT = Number(process.env.TUNNEL_SOCKS_PORT || 1080);
const PATH = '/phone-bridge/tunnel';
const T_OPEN = 1, T_OK = 2, T_FAIL = 3, T_DATA = 4, T_CLOSE = 5;
const ALLOWED_PORTS = new Set([80, 443]);

let ws = null;            // { sock, since }
let nextId = 1;
const streams = new Map(); // id → { sock, onOpen }
const stats = { since: 0, opened: 0, failed: 0, last_error: '' };

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
async function tokenOk(tok) {
  const c = (await db.getSettings()).phone_bridge;
  if (!c || !c.hash || !tok) return false;
  const a = Buffer.from(sha(tok)), b = Buffer.from(c.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- WebSocket (خادم بسيط: إطارات ثنائية + ping/pong) ----------
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function wsSend(type, id, data) {
  if (!ws) return false;
  const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(id, 1);
  return ws.sock.write(frame(0x2, data ? Buffer.concat([h, data]) : h));
}

function onMessage(buf) {
  if (buf.length < 5) return;
  const type = buf[0], id = buf.readUInt32BE(1), data = buf.subarray(5);
  const s = streams.get(id);
  if (!s) { if (type !== T_CLOSE) wsSend(T_CLOSE, id); return; }
  if (type === T_OK) s.onOpen && s.onOpen(null);
  else if (type === T_FAIL) { s.onOpen && s.onOpen(new Error(data.toString('utf8') || 'فشل')); }
  else if (type === T_DATA) {
    if (!s.sock.write(data)) { /* الضغط: نخلي TCP يتولاه */ }
  } else if (type === T_CLOSE) { streams.delete(id); s.sock.end(); }
}

function closeAll(reason) {
  for (const [, s] of streams) { try { s.onOpen && s.onOpen(new Error(reason)); s.sock.destroy(); } catch (_) {} }
  streams.clear();
}

function attachSocket(sock) {
  if (ws) { try { ws.sock.destroy(); } catch (_) {} closeAll('اتصال جديد من الماك'); }
  const me = { sock, since: Date.now() };
  ws = me; stats.since = me.since;
  sock.setNoDelay(true); sock.setKeepAlive(true, 20e3);
  let buf = Buffer.alloc(0), frag = null;
  const ping = setInterval(() => { try { sock.write(frame(0x9, Buffer.alloc(0))); } catch (_) {} }, 20e3);
  let lastRx = Date.now();
  const watchdog = setInterval(() => { if (Date.now() - lastRx > 70e3) sock.destroy(); }, 15e3);
  sock.on('data', chunk => {
    lastRx = Date.now();
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, fin = !!(buf[0] & 0x80), masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 8 * 1024 * 1024) { sock.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      buf = buf.subarray(need);
      if (op === 0x8) { sock.end(frame(0x8, Buffer.alloc(0))); return; }
      if (op === 0x9) { sock.write(frame(0xA, payload)); continue; }
      if (op === 0xA) continue;
      if (op === 0x0) { frag = frag ? Buffer.concat([frag, payload]) : payload; if (fin) { onMessage(frag); frag = null; } continue; }
      if (fin) onMessage(payload); else frag = payload;
    }
  });
  const done = () => {
    clearInterval(ping); clearInterval(watchdog);
    if (ws === me) { ws = null; closeAll('انقطع اتصال الماك'); }
  };
  sock.on('close', done); sock.on('error', done);
}

// يربط مسار /phone-bridge/tunnel على سيرفر HTTP
function attach(server) {
  server.on('upgrade', async (req, sock) => {
    let url; try { url = new URL(req.url, 'http://x'); } catch (_) { return sock.destroy(); }
    if (url.pathname !== PATH) return; // ترقيات ثانية (لو فيه) مو لنا
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const key = req.headers['sec-websocket-key'];
    if (!key || !(await tokenOk(tok).catch(() => false))) { sock.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    attachSocket(sock);
    db.log('web', '🏠 طريق الماك للمواقع السعودية: متصل').catch(() => {});
  });
  startSocks();
}

// ---------- بروكسي SOCKS5 داخلي (المتصفح يستخدمه) ----------
let socksServer = null;
function startSocks() {
  if (socksServer) return;
  socksServer = net.createServer(client => {
    client.setNoDelay(true);
    let stage = 0, buf = Buffer.alloc(0), id = 0;
    const fail = code => { try { client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (_) {} };
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return; if (buf[0] !== 5) return client.destroy();
        const n = buf[1]; if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n); stage = 1; client.write(Buffer.from([5, 0]));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[0] !== 5 || buf[1] !== 1) return fail(7);
        const atyp = buf[3]; let host, off;
        if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else if (atyp === 3) { const l = buf[4]; if (buf.length < 5 + l + 2) return; host = buf.subarray(5, 5 + l).toString('utf8'); off = 5 + l; }
        else if (atyp === 4) { if (buf.length < 22) return; host = buf.subarray(4, 20).toString('hex').match(/.{4}/g).join(':'); off = 20; }
        else return fail(8);
        const port = buf.readUInt16BE(off); const rest = buf.subarray(off + 2);
        stage = 2; client.removeListener('data', onData); client.pause();
        if (!ws) { stats.failed++; return fail(3); }
        if (!ALLOWED_PORTS.has(port)) { stats.failed++; return fail(2); }
        id = nextId++; if (nextId > 0x7fffffff) nextId = 1;
        const timer = setTimeout(() => { const s = streams.get(id); if (s && s.onOpen) s.onOpen(new Error('timeout')); }, 25e3);
        streams.set(id, { sock: client, onOpen: err => {
          clearTimeout(timer); const s = streams.get(id); if (s) s.onOpen = null;
          if (err) { stats.failed++; stats.last_error = String(err.message).slice(0, 120); streams.delete(id); wsSend(T_CLOSE, id); return fail(4); }
          stats.opened++;
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) wsSend(T_DATA, id, rest);
          client.on('data', d => { if (!wsSend(T_DATA, id, d) && ws) { client.pause(); ws.sock.once('drain', () => client.resume()); } });
          client.resume();
        } });
        client.on('close', () => { if (streams.has(id)) { streams.delete(id); wsSend(T_CLOSE, id); } });
        client.on('error', () => {});
        wsSend(T_OPEN, id, Buffer.from(JSON.stringify({ h: host, p: port })));
      }
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  socksServer.on('error', e => console.error('tunnel socks:', e.message));
  socksServer.listen(SOCKS_PORT, '0.0.0.0');
}

const online = () => !!ws;
function status() { return { online: online(), since: ws ? new Date(ws.since).toISOString() : null, streams: streams.size, ...stats }; }

module.exports = { attach, online, status, SOCKS_PORT, PATH };
