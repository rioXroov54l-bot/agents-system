// نظام فريق وكلاء الأعمال — نقطة التشغيل
require('./src/app').start().catch(e => {
  console.error('❌ فشل التشغيل:', e);
  process.exit(1);
});
