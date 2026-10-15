// متابعة سعر وتوفر المنتجات (جرير، نون، أمازون، إكسترا، أبل...) كل ساعة بدون تكلفة ذكاء اصطناعي:
// يقرأ بيانات المنتج المنظمة من الصفحة (JSON-LD / meta)، ويبلغ المالك فقط لما يتغير شي.
const db = require('./db');
const U = require('./util');
const C = require('./config');
const llm = require('./llm');
const ch = require('./channels');
const { T } = require('./tools');

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const int = d => ({ type: 'integer', description: d });
const numb = d => ({ type: 'number', description: d });
const def = (name, description, input_schema, handler) => { T[name] = { name, description, input_schema, handler }; };

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const num = v => { if (v === null || v === undefined) return null; const n = parseFloat(String(v).replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; };
const AVAIL = a => { const t = String(a || '').toLowerCase().replace(/[\s_-]/g, ''); if (!t) return null; if (/outofstock|soldout|discontinued|backorder|preorder|غيرمتوفر|نفد|نفذ/.test(t)) return false; if (/instock|limitedavailability|onlineonly|instoreonly|available|متوفر/.test(t)) return true; return null; };

function fromJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const nodes = [];
  const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); nodes.push(o); if (o['@graph']) walk(o['@graph']); };
  for (const b of blocks) { try { walk(JSON.parse(b.trim())); } catch (_) {} }
  for (const n of nodes) {
    const type = [].concat(n['@type'] || []).join(',');
    if (!/Product/i.test(type)) continue;
    const offers = [].concat(n.offers || []).flatMap(o => o && o['@type'] === 'AggregateOffer' ? [o, ...[].concat(o.offers || [])] : [o]).filter(Boolean);
    const o = offers.find(x => num(x.price) || num(x.lowPrice)) || offers[0] || {};
    const price = num(o.price) ?? num(o.lowPrice) ?? (o.priceSpecification ? num([].concat(o.priceSpecification)[0].price) : null);
    const availRaw = o.availability || (offers.find(x => x.availability) || {}).availability;
    if (price || availRaw) return { title: n.name || '', price, currency: o.priceCurrency || (o.priceSpecification && [].concat(o.priceSpecification)[0].priceCurrency) || 'SAR', available: AVAIL(availRaw), source: 'jsonld' };
  }
  return null;
}
function fromMeta(html) {
  const meta = k => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${k}["'][^>]*content=["']([^"']+)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${k}["']`, 'i')); return m ? m[1] : null; };
  const price = num(meta('product:price:amount') || meta('og:price:amount') || meta('price'));
  const ip = html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i);
  const ia = html.match(/itemprop=["']availability["'][^>]*(?:href|content)=["']([^"']+)["']/i);
  const p = price ?? (ip ? num(ip[1]) : null);
  const a = AVAIL(meta('product:availability') || meta('og:availability') || (ia && ia[1]));
  if (p || a !== null) return { title: meta('og:title') || '', price: p, currency: meta('product:price:currency') || meta('og:price:currency') || 'SAR', available: a, source: 'meta' };
  return null;
}
async function fromText(html, url) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 12000);
  if (text.length < 200) return null;
  const r = llm.parseJson(await llm.ask('استخرج من نص صفحة المنتج: JSON فقط {"title":"","price":رقم أو null,"currency":"SAR","available":true|false|null}. available=false إذا مكتوب غير متوفر/نفدت الكمية/Out of stock/قريباً.', `${url}\n\n${text}`, { model: C.FAST_MODEL, maxTokens: 150 }).catch(() => '')) || {};
  return r.price || r.available !== undefined ? { title: r.title || '', price: num(r.price), currency: r.currency || 'SAR', available: typeof r.available === 'boolean' ? r.available : null, source: 'ai' } : null;
}

async function check(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ar-SA,ar;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('الموقع رد ' + res.status);
  const html = await res.text();
  const r = fromJsonLd(html) || fromMeta(html) || await fromText(html, url);
  if (!r) throw new Error('ما لقيت السعر في الصفحة');
  return r;
}

const fmtP = (p, c) => p ? `${Number(p).toLocaleString('en-US')} ${!c || c === 'SAR' ? 'ريال' : c}` : 'غير معروض';
const every = m => m >= 60 ? ({ 1: 'ساعة', 2: 'ساعتين' }[m / 60] || `${Math.round(m / 60)} ساعات`) : `${m} دقيقة`;
const fmtA = a => a === true ? '✅ متوفر' : a === false ? '❌ غير متوفر' : '❔ غير واضح';

// احتياط: إذا الموقع يمنع القراءة المباشرة، نتحقق بالبحث في الإنترنت (أبطأ وبتكلفة بسيطة، كل 3 ساعات)
async function searchCheck(w) {
  const data = await llm.callClaude({
    model: C.FAST_MODEL, maxTokens: 1200,
    system: 'تحقق من سعر وتوفر منتج في متجر سعودي باستخدام البحث. رد في الأخير بـ JSON فقط: {"price": رقم أو null, "currency":"SAR", "available": true|false|null, "title":""}',
    messages: [{ role: 'user', content: `المنتج: ${w.label}
الرابط: ${w.url}
وش سعره الحين وهل هو متوفر للشراء أونلاين؟` }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'SA', city: 'Riyadh', timezone: 'Asia/Riyadh' } }]
  });
  const r = llm.parseJson(llm.textOf(data.content)) || {};
  if (!r.price && typeof r.available !== 'boolean') throw new Error('ما قدرت أتأكد بالبحث');
  return { title: r.title || '', price: num(r.price), currency: r.currency || 'SAR', available: typeof r.available === 'boolean' ? r.available : null, source: 'search' };
}

async function runCheck(w, { manual = false } = {}) {
  let r;
  try { r = w.mode === 'search' ? await searchCheck(w) : await check(w.url); }
  catch (e) {
    const fails = (w.fails || 0) + 1;
    await db.q('UPDATE price_watches SET last_check=now(), fails=$2, last_error=$3 WHERE id=$1', [w.id, fails, e.message.slice(0, 200)]);
    if (fails === 3 && w.mode !== 'search') {
      await db.q("UPDATE price_watches SET mode='search', every_minutes=GREATEST(every_minutes,180), fails=0 WHERE id=$1", [w.id]);
      await ch.notifyOwner(`ℹ️ موقع **${w.label}** ما يسمح بالقراءة المباشرة، فحولت المتابعة للبحث في الإنترنت كل 3 ساعات (تكلفة بسيطة). إذا عندك رابط ثاني للمنتج أرسله.`);
    } else if (fails === 3) await ch.notifyOwner(`⚠️ ما قدرت أتأكد من **${w.label}** 3 مرات. أرسل لي رابط ثاني للمنتج أو قل «وقف متابعة ${w.id}».`);
    if (manual) throw e;
    return null;
  }
  const hist = (typeof w.history === 'string' ? JSON.parse(w.history) : w.history) || [];
  hist.push({ at: new Date().toISOString(), price: r.price, available: r.available });
  await db.q('UPDATE price_watches SET last_check=now(), fails=0, last_error=NULL, last_price=$2, last_available=$3, currency=$4, title=coalesce(title,$5), history=$6 WHERE id=$1',
    [w.id, r.price, r.available, r.currency, r.title || null, JSON.stringify(hist.slice(-60))]);
  const first = w.last_check === null || w.last_check === undefined;
  const msgs = [];
  if (first) msgs.push(`👀 **بدأت أتابع: ${w.label}**\n💰 السعر: **${fmtP(r.price, r.currency)}** | ${fmtA(r.available)}\n⏱️ أشيك كل ${every(w.every_minutes)}، وأبلغك **بس لما يتغير شي**${w.target_price ? ` أو ينزل تحت ${fmtP(w.target_price)}` : ''}.`);
  else {
    if (w.last_available === false && r.available === true) msgs.push(`🚨 **توفر الحين: ${w.label}**\n💰 ${fmtP(r.price, r.currency)}\n👉 ${w.url}\n\nقل «جهز الدفع» وأرسل لك بطاقة الدفع بضغطة ⚡`);
    else if (w.last_available === true && r.available === false) msgs.push(`❌ **نفد: ${w.label}** — بكمل أتابع وأبلغك أول ما يرجع.`);
    const old = num(w.last_price);
    if (r.price && old && Math.abs(r.price - old) >= 0.01) {
      const diff = r.price - old, pct = Math.round(diff / old * 1000) / 10;
      msgs.push(`${diff < 0 ? '📉 **نزل السعر**' : '📈 **ارتفع السعر**'}: ${w.label}\n${fmtP(old, r.currency)} ← **${fmtP(r.price, r.currency)}** (${diff > 0 ? '+' : ''}${pct}%)\n👉 ${w.url}`);
    }
    if (w.target_price && r.price && r.price <= Number(w.target_price) && !(old && old <= Number(w.target_price))) msgs.push(`🎯 **وصل السعر اللي تبيه!** ${w.label}: ${fmtP(r.price, r.currency)} (هدفك ${fmtP(w.target_price)})\n👉 ${w.url}`);
  }
  if (msgs.length && !manual) await ch.notifyOwner(msgs.join('\n\n'));
  return { ...r, messages: msgs };
}

async function tick() {
  const due = await db.many("SELECT * FROM price_watches WHERE active AND (last_check IS NULL OR last_check <= now() - (every_minutes || ' minutes')::interval) ORDER BY last_check NULLS FIRST LIMIT 4").catch(() => []);
  for (const w of due) await runCheck(w).catch(e => console.error('pricewatch', e.message));
}

def('watch_price', 'تابع سعر وتوفر منتج من رابط صفحته (جرير، نون، أمازون، إكسترا، أبل، أي متجر) كل ساعة تلقائياً وبدون تكلفة: يبلغ المالك فقط لما يتوفر/ينفد/يتغير السعر/يوصل السعر المطلوب. هذي الطريقة الصحيحة لـ«تابع لي السعر» و«علمني متى يتوفر» — لا تستخدم المهام المتكررة لها. لازم رابط صفحة المنتج نفسه (دوره بالبحث). لكل لون/سعة رابط مستقل.',
  S({ url: str('رابط صفحة المنتج'), label: str('اسم واضح مثل: آيفون 18 برو ماكس 256 برغندي — جرير'), target_price: numb('نبهني إذا نزل تحت هالسعر (اختياري)'), every_minutes: int('كل كم دقيقة (افتراضي 60، أقل شي 30)') }, ['url', 'label']),
  async (a) => {
    if (!/^https?:\/\//.test(a.url)) throw new Error('لازم رابط صفحة المنتج كامل');
    const n = await db.one('SELECT count(*) AS n FROM price_watches WHERE active');
    if (Number(n.n) >= 25) throw new Error('عندك 25 متابعة — أوقف وحدة قبل');
    const ex = await db.one('SELECT id FROM price_watches WHERE url=$1 AND active', [a.url]);
    if (ex) return `هذا المنتج أتابعه من قبل (#${ex.id})`;
    const w = await db.insert('price_watches', { url: a.url, label: a.label, target_price: a.target_price, every_minutes: Math.max(30, a.every_minutes || 60) }, ['url', 'label', 'target_price', 'every_minutes']);
    try {
      const r = await runCheck(w, { manual: true });
      return `✅ بدأت أتابع #${w.id} «${a.label}» كل ${every(Math.max(30, a.every_minutes || 60))}\nالحين: ${fmtP(r.price, r.currency)} — ${fmtA(r.available)}\nبيوصل المالك تنبيه فقط لما يتغير السعر أو التوفر.`;
    } catch (e) {
      return `⚠️ سجلت المتابعة #${w.id} بس أول فحص ما زبط (${e.message}). بحاول كل ساعة، وإذا استمر قل للمالك يرسل رابط ثاني أو تأكد إن الرابط لصفحة المنتج نفسه.`;
    }
  });
def('list_price_watches', 'المنتجات اللي أتابع سعرها وتوفرها.', S({}),
  async () => (await db.many('SELECT id, label, url, last_price, currency, last_available, target_price, every_minutes, last_check, last_error FROM price_watches WHERE active ORDER BY id')).map(w => ({ ...w, last_check: w.last_check ? U.fmt(w.last_check) : null })));
def('stop_price_watch', 'وقف متابعة منتج.', S({ id: int('رقم المتابعة') }, ['id']),
  async ({ id }) => { const r = await db.one('UPDATE price_watches SET active=false WHERE id=$1 RETURNING label', [id]); return r ? `⏹️ وقفت متابعة ${r.label}` : 'ما لقيتها'; });
def('check_price_now', 'شيك على منتج متابع الحين.', S({ id: int('رقم المتابعة') }, ['id']),
  async ({ id }) => { const w = await db.one('SELECT * FROM price_watches WHERE id=$1', [id]); if (!w) throw new Error('ما لقيتها'); const r = await runCheck(w, { manual: true }); return `${w.label}: ${fmtP(r.price, r.currency)} — ${fmtA(r.available)}${r.messages.length ? '\n' + r.messages.join('\n') : '\n(ما تغير شي)'}`; });

async function quick() {
  const ws = await db.many('SELECT * FROM price_watches WHERE active ORDER BY id').catch(() => []);
  if (!ws.length) return '🔔 ما أتابع أي منتج.\n\n💬 «تابع لي سعر آيفون 18 برو ماكس 256 في جرير وعلمني متى يتوفر»';
  return '🔔 **المنتجات اللي أتابعها**\n\n' + ws.map(w => `**#${w.id} ${w.label}**\n💰 ${fmtP(w.last_price, w.currency)} | ${fmtA(w.last_available)}${w.target_price ? ` | 🎯 ${fmtP(w.target_price)}` : ''}\n🕐 آخر فحص: ${w.last_check ? U.fmt(w.last_check).slice(5) : '—'}${w.last_error ? '\n⚠️ ' + w.last_error : ''}`).join('\n\n') + '\n\n💬 «وقف متابعة رقم ...»';
}

module.exports = { tick, check, runCheck, quick, fromJsonLd, fromMeta };
