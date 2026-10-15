// معلومات العالم بدون مفاتيح: الطقس، مواقيت الصلاة، التاريخ الهجري، أسعار العملات
const OM = process.env.OPEN_METEO_BASE || 'https://api.open-meteo.com';
const GEO = process.env.OPEN_METEO_GEO || 'https://geocoding-api.open-meteo.com';
const ALADHAN = process.env.ALADHAN_BASE || 'https://api.aladhan.com';
const FX = process.env.FX_BASE || 'https://open.er-api.com';

const cache = new Map();
async function cached(key, ms, fn) {
  const c = cache.get(key);
  if (c && c.exp > Date.now()) return c.v;
  const v = await fn();
  cache.set(key, { v, exp: Date.now() + ms });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return v;
}
async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'sakrtir/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const SA = { 'الرياض': 'Riyadh', 'جدة': 'Jeddah', 'جده': 'Jeddah', 'مكة': 'Mecca', 'مكه': 'Mecca', 'مكة المكرمة': 'Mecca', 'المدينة': 'Medina', 'المدينة المنورة': 'Medina', 'الدمام': 'Dammam', 'الخبر': 'Khobar', 'الظهران': 'Dhahran',
  'الطائف': 'Taif', 'أبها': 'Abha', 'ابها': 'Abha', 'خميس مشيط': 'Khamis Mushait', 'تبوك': 'Tabuk', 'بريدة': 'Buraydah', 'القصيم': 'Buraydah', 'عنيزة': 'Unaizah', 'حائل': 'Hail', 'جازان': 'Jizan', 'جيزان': 'Jizan',
  'نجران': 'Najran', 'الأحساء': 'Hofuf', 'الاحساء': 'Hofuf', 'الهفوف': 'Hofuf', 'ينبع': 'Yanbu', 'الجبيل': 'Jubail', 'الباحة': 'Al Bahah', 'سكاكا': 'Sakakah', 'الجوف': 'Sakakah', 'عرعر': 'Arar', 'القطيف': 'Qatif',
  'حفر الباطن': 'Hafar Al-Batin', 'العلا': 'Al-Ula', 'دبي': 'Dubai', 'أبوظبي': 'Abu Dhabi', 'الدوحة': 'Doha', 'المنامة': 'Manama', 'الكويت': 'Kuwait City', 'مسقط': 'Muscat', 'القاهرة': 'Cairo', 'عمان': 'Amman',
  'إسطنبول': 'Istanbul', 'اسطنبول': 'Istanbul', 'لندن': 'London', 'باريس': 'Paris' };

async function geocode(city) {
  const name = String(city || 'الرياض').trim();
  return cached('geo:' + name, 30 * 864e5, async () => {
    for (const q of [name, SA[name]].filter(Boolean)) {
      const d = await getJSON(`${GEO}/v1/search?name=${encodeURIComponent(q)}&count=1&language=ar&format=json`).catch(() => ({}));
      const r = d.results && d.results[0];
      if (r) return { name: r.name || name, country: r.country || '', lat: r.latitude, lon: r.longitude, tz: r.timezone || 'Asia/Riyadh' };
    }
    if (/رياض|riyadh/i.test(name)) return { name: 'الرياض', country: 'السعودية', lat: 24.7136, lon: 46.6753, tz: 'Asia/Riyadh' };
    throw new Error(`ما لقيت مدينة باسم «${name}»`);
  });
}

const WMO = c => c === 0 ? 'صحو ☀️' : c <= 2 ? 'غائم جزئياً 🌤️' : c === 3 ? 'غائم ☁️' : c <= 48 ? 'ضباب 🌫️' : c <= 57 ? 'رذاذ 🌦️' : c <= 67 ? 'مطر 🌧️' : c <= 77 ? 'ثلج ❄️' : c <= 82 ? 'زخات مطر 🌧️' : c <= 86 ? 'زخات ثلج 🌨️' : 'عواصف رعدية ⛈️';
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

async function weather(city, days = 3) {
  const g = await geocode(city);
  const n = Math.min(Math.max(Number(days) || 3, 1), 14);
  return cached(`wx:${g.lat},${g.lon},${n}`, 30 * 6e4, async () => {
    const d = await getJSON(`${OM}/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,uv_index_max&timezone=auto&forecast_days=${n}`);
    const c = d.current || {}, y = d.daily || {};
    return {
      city: g.name, country: g.country,
      now: { temp: Math.round(c.temperature_2m), feels_like: Math.round(c.apparent_temperature), humidity: c.relative_humidity_2m, wind_kmh: Math.round(c.wind_speed_10m), sky: WMO(c.weather_code) },
      days: (y.time || []).map((t, i) => ({ date: t, day: DAYS[new Date(t + 'T12:00:00Z').getUTCDay()], max: Math.round(y.temperature_2m_max[i]), min: Math.round(y.temperature_2m_min[i]), sky: WMO(y.weather_code[i]), rain_chance: y.precipitation_probability_max ? y.precipitation_probability_max[i] : null, wind_max_kmh: y.wind_speed_10m_max ? Math.round(y.wind_speed_10m_max[i]) : null, uv: y.uv_index_max ? y.uv_index_max[i] : null }))
    };
  });
}

const PRAYERS = [['Fajr', 'الفجر'], ['Sunrise', 'الشروق'], ['Dhuhr', 'الظهر'], ['Asr', 'العصر'], ['Maghrib', 'المغرب'], ['Isha', 'العشاء']];
async function prayerTimes(city, date) {
  const g = await geocode(city);
  const d = date ? new Date(date) : new Date(Date.now() + 3 * 3600e3);
  const ds = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
  return cached(`pr:${g.lat},${g.lon},${ds}`, 12 * 3600e3, async () => {
    const r = await getJSON(`${ALADHAN}/v1/timings/${ds}?latitude=${g.lat}&longitude=${g.lon}&method=4`);
    const t = r.data.timings, h = r.data.date && r.data.date.hijri;
    return { city: g.name, date: ds, hijri: h ? `${h.day} ${(h.month && h.month.ar) || ''} ${h.year}هـ` : hijri(d), times: Object.fromEntries(PRAYERS.map(([k, ar]) => [ar, String(t[k] || '').slice(0, 5)])) };
  });
}
// الصلاة الجاية من الآن
async function nextPrayer(city) {
  const p = await prayerTimes(city);
  const now = new Date(Date.now() + 3 * 3600e3).toISOString().slice(11, 16);
  const list = Object.entries(p.times).filter(([n]) => n !== 'الشروق');
  const nx = list.find(([, t]) => t > now) || list[0];
  return { name: nx[0], time: nx[1] };
}

// التاريخ الهجري بتقويم أم القرى (بدون إنترنت)
function hijri(date = new Date()) {
  try { return new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(date)); }
  catch (_) { return ''; }
}
function convertDate({ gregorian, hijri: h }) {
  if (gregorian) { const d = new Date(gregorian); return { gregorian: d.toISOString().slice(0, 10), day: DAYS[d.getUTCDay()], hijri: hijri(d) }; }
  if (h) { // بحث بسيط: نمر على الأيام حول التاريخ التقريبي حتى يطابق
    const m = String(h).match(/(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s](\d{4})/);
    if (!m) throw new Error('اكتب الهجري بصيغة يوم/شهر/سنة مثل 15/9/1448');
    const [, dd, mm, yy] = m.map(Number);
    const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric' });
    const approx = new Date(Date.UTC(622, 6, 16) + ((yy - 1) * 354.367 + (mm - 1) * 29.53 + dd) * 864e5);
    for (let i = -40; i <= 40; i++) {
      const d = new Date(approx.getTime() + i * 864e5);
      const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
      if (Number(parts.day) === dd && Number(parts.month) === mm && parseInt(parts.year) === yy) return { gregorian: d.toISOString().slice(0, 10), day: DAYS[d.getUTCDay()], hijri: hijri(d) };
    }
    throw new Error('ما قدرت أحوّل التاريخ');
  }
  throw new Error('حدد تاريخ ميلادي أو هجري');
}

async function currency({ amount = 1, from = 'USD', to = 'SAR' }) {
  const F = String(from).toUpperCase().trim(), T = String(to).toUpperCase().trim();
  const d = await cached('fx:' + F, 3 * 3600e3, () => getJSON(`${FX}/v6/latest/${F}`));
  if (d.result !== 'success' || !d.rates || !d.rates[T]) throw new Error('عملة غير معروفة');
  const rate = d.rates[T];
  return { amount: Number(amount), from: F, to: T, rate: Math.round(rate * 1e6) / 1e6, result: Math.round(Number(amount) * rate * 100) / 100, updated: d.time_last_update_utc || '' };
}

module.exports = { geocode, weather, prayerTimes, nextPrayer, hijri, convertDate, currency, WMO };
