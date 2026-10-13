// مستندات قابلة للطباعة (PDF من المتصفح): عرض سعر وفاتورة ضريبية
const C = require('./config');
const U = require('./util');

const link = (type, row) => `${C.PUBLIC_URL}/d/${type}/${row.id}/${row.token}`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nl = s => esc(s).replace(/\n/g, '<br>');

// رمز QR للفاتورة الضريبية المبسطة (المرحلة الأولى - هيئة الزكاة): TLV بترميز Base64
function zatcaQR({ seller, vatNumber, timestamp, total, vat }) {
  const parts = [seller, vatNumber, timestamp, Number(total).toFixed(2), Number(vat).toFixed(2)];
  const bufs = parts.map((v, i) => {
    const b = Buffer.from(String(v || ''), 'utf8');
    return Buffer.concat([Buffer.from([i + 1, b.length]), b]);
  });
  return Buffer.concat(bufs).toString('base64');
}

function render(kind, doc, customer, settings) {
  const co = settings.company;
  const items = typeof doc.items === 'string' ? JSON.parse(doc.items) : (doc.items || []);
  const isInv = kind === 'i';
  const title = isInv ? 'فاتورة ضريبية' : 'عرض سعر';
  const date = isInv ? U.fmtDay(doc.issue_date || doc.created_at) : U.fmtDay(doc.created_at);
  const qr = isInv ? zatcaQR({ seller: co.name, vatNumber: co.vat_number, timestamp: new Date(doc.created_at).toISOString(), total: doc.total, vat: doc.vat }) : '';
  const remaining = isInv ? Number(doc.total) - Number(doc.paid_amount || 0) : 0;
  const statusLabel = { draft: 'مسودة', sent: 'مرسل', accepted: 'مقبول', rejected: 'مرفوض', expired: 'منتهي', issued: 'مستحقة', partial: 'مدفوعة جزئياً', paid: 'مدفوعة', overdue: 'متأخرة', cancelled: 'ملغاة' }[doc.status] || doc.status;

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} ${esc(doc.number)} — ${esc(co.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#14213d;--accent:#0f766e;--gold:#b08d57;--muted:#64748b;--line:#e2e8f0;--soft:#f8fafc}
*{box-sizing:border-box}
body{margin:0;background:#e9edf2;font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;min-height:297mm;margin:24px auto;background:#fff;padding:16mm 15mm 14mm;position:relative;box-shadow:0 10px 40px rgba(20,33,61,.12);display:flex;flex-direction:column}
.top{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding-bottom:10px}
.logo{max-height:90px;max-width:260px;object-fit:contain}
.coname{font-size:22px;font-weight:700;letter-spacing:.2px}
.coname-en{font-size:12px;color:var(--muted);letter-spacing:2px;text-transform:uppercase}
.parent{font-size:11px;color:var(--muted)}
.title{margin:14px 0 18px;text-align:center;position:relative}
.title h1{display:inline-block;margin:0;font-size:26px;font-weight:700;color:var(--accent);padding:0 22px;background:#fff;position:relative;z-index:1}
.title:before{content:"";position:absolute;inset:50% 0 auto;border-top:1px solid var(--gold)}
.title:after{content:"";position:absolute;left:50%;transform:translateX(-50%);bottom:-6px;width:56px;height:3px;background:var(--gold);border-radius:3px}
.boxes{display:grid;grid-template-columns:1.3fr 1fr;gap:12px;margin-bottom:16px}
.box{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--soft)}
.box h3{margin:0 0 6px;font-size:12px;color:var(--gold);font-weight:600}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:13px}
.kv span{color:var(--muted)}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;margin-bottom:12px}
thead th{background:var(--ink);color:#fff;font-weight:600;padding:9px 8px;text-align:center}
thead th:first-child{border-radius:0 8px 0 0}thead th:last-child{border-radius:8px 0 0 0}
td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:center;vertical-align:top}
td.desc{text-align:right}
td.desc small{display:block;color:var(--muted);margin-top:2px;line-height:1.5}
tbody tr:nth-child(even) td{background:var(--soft)}
.sum{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.totals{min-width:250px;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
.totals div{display:flex;justify-content:space-between;gap:18px;padding:7px 12px;border-bottom:1px solid var(--line)}
.totals div.grand{background:var(--accent);color:#fff;font-weight:700;font-size:15px}
.totals div:last-child{border:0}
.notes{flex:1;font-size:12.5px;line-height:1.8}
.notes h4{margin:0 0 4px;font-size:12.5px;color:var(--gold)}
.qr{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:10px;color:var(--muted)}
.foot{margin-top:auto;padding-top:14px;border-top:2px solid var(--ink);display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;font-size:12px}
.foot b{color:var(--accent);font-weight:600}
.foot .full{grid-column:1/-1;text-align:center;color:var(--muted);font-size:11px}
.stamp{position:absolute;top:18mm;left:15mm;border:2px solid var(--accent);color:var(--accent);border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;transform:rotate(-6deg)}
.actions{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);display:flex;gap:8px}
.actions button{font:inherit;border:0;background:var(--accent);color:#fff;padding:11px 20px;border-radius:999px;cursor:pointer;box-shadow:0 6px 20px rgba(15,118,110,.35)}
@media (max-width:820px){.page{width:auto;margin:0;padding:18px 14px;min-height:auto;box-shadow:none}.boxes{grid-template-columns:1fr}.sum{flex-direction:column}.totals{width:100%}}
@media print{body{background:#fff}.page{margin:0;box-shadow:none;width:auto;min-height:auto}.actions{display:none}@page{size:A4;margin:10mm}}
</style></head><body>
<div class="page">
  ${isInv ? `<div class="stamp">${esc(statusLabel)}</div>` : ''}
  <div class="top">
    ${co.logo_url ? `<img class="logo" src="${esc(co.logo_url)}" alt="${esc(co.name)}">` : ''}
    <div class="coname">${esc(co.name)}</div>
    ${co.name_en ? `<div class="coname-en">${esc(co.name_en)}</div>` : ''}
    ${co.parent ? `<div class="parent">${esc(co.parent)}</div>` : ''}
  </div>
  <div class="title"><h1>${title}</h1></div>
  <div class="boxes">
    <div class="box"><h3>${isInv ? 'بيانات المشتري' : 'مقدم إلى'}</h3><div class="kv">
      <span>الاسم</span><div>${esc(customer ? customer.name : '—')}</div>
      ${customer && customer.company ? `<span>الجهة</span><div>${esc(customer.company)}</div>` : ''}
      ${customer && customer.phone ? `<span>الجوال</span><div dir="ltr" style="text-align:right">${esc(customer.phone)}</div>` : ''}
      ${customer && customer.city ? `<span>المدينة</span><div>${esc(customer.city)}</div>` : ''}
    </div></div>
    <div class="box"><h3>بيانات ${isInv ? 'الفاتورة' : 'العرض'}</h3><div class="kv">
      <span>الرقم</span><div>${esc(doc.number)}</div>
      <span>التاريخ</span><div>${date}</div>
      ${isInv ? `<span>الاستحقاق</span><div>${U.fmtDay(doc.due_date)}</div>` : `<span>صالح حتى</span><div>${U.fmtDay(doc.valid_until)}</div>`}
      ${co.vat_number ? `<span>الرقم الضريبي</span><div>${esc(co.vat_number)}</div>` : ''}
      ${co.cr_number ? `<span>السجل التجاري</span><div>${esc(co.cr_number)}</div>` : ''}
    </div></div>
  </div>
  <table><thead><tr><th style="width:36px">#</th><th>البيان</th><th style="width:70px">الكمية</th><th style="width:70px">الوحدة</th><th style="width:100px">سعر الوحدة</th><th style="width:110px">الإجمالي</th></tr></thead><tbody>
    ${items.map((it, i) => `<tr><td>${i + 1}</td><td class="desc">${esc(it.name)}${it.description ? `<small>${nl(it.description)}</small>` : ''}</td><td>${it.qty}</td><td>${esc(it.unit || '')}</td><td>${U.money(it.price)}</td><td>${U.money(it.total ?? it.qty * it.price)}</td></tr>`).join('')}
  </tbody></table>
  <div class="sum">
    <div class="notes">
      ${doc.notes ? `<h4>ملاحظات</h4><div>${nl(doc.notes)}</div>` : ''}
      ${!isInv && doc.terms ? `<h4 style="margin-top:8px">الشروط والأحكام</h4><div>${nl(doc.terms)}</div>` : ''}
      ${isInv && co.bank ? `<h4>بيانات التحويل</h4><div>${nl(co.bank)}</div>` : ''}
      ${isInv ? `<div class="qr" style="align-items:flex-start;margin-top:10px"><div id="qr"></div><span>رمز الفاتورة الإلكترونية</span></div>` : ''}
    </div>
    <div class="totals">
      <div><span>المجموع قبل الضريبة</span><b>${U.money(doc.subtotal)}</b></div>
      ${Number(doc.discount) ? `<div><span>الخصم</span><b>- ${U.money(doc.discount)}</b></div>` : ''}
      <div><span>ضريبة القيمة المضافة ${settings.vat_rate}%</span><b>${U.money(doc.vat)}</b></div>
      <div class="grand"><span>الإجمالي شامل الضريبة</span><b>${U.money(doc.total)} ر.س</b></div>
      ${isInv && Number(doc.paid_amount) ? `<div><span>المدفوع</span><b>${U.money(doc.paid_amount)}</b></div><div><span>المتبقي</span><b>${U.money(remaining)} ر.س</b></div>` : ''}
    </div>
  </div>
  <div class="foot">
    ${(co.phones_admin || []).length ? `<div><b>الإدارة:</b> <span dir="ltr">${co.phones_admin.map(esc).join(' &nbsp;|&nbsp; ')}</span></div>` : ''}
    ${(co.phones_sales || []).length ? `<div><b>المبيعات والمناديب:</b> <span dir="ltr">${co.phones_sales.map(esc).join(' &nbsp;|&nbsp; ')}</span></div>` : ''}
    ${co.email ? `<div><b>البريد:</b> ${esc(co.email)}</div>` : ''}
    ${co.website ? `<div><b>الموقع:</b> ${esc(co.website)}</div>` : ''}
    <div class="full">${esc(co.address || '')}</div>
  </div>
</div>
<div class="actions"><button onclick="window.print()">طباعة / حفظ PDF</button></div>
${isInv ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>try{new QRCode(document.getElementById('qr'),{text:${JSON.stringify(qr)},width:110,height:110,correctLevel:QRCode.CorrectLevel.M});}catch(e){document.getElementById('qr').textContent='QR';}</script>` : ''}
</body></html>`;
}

module.exports = { link, render, zatcaQR };
