// الإعدادات العامة من متغيرات البيئة
const env = process.env;

const PUBLIC_URL = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT || 3000}`)).replace(/\/$/, '');

module.exports = {
  PORT: env.PORT || 3000,
  PUBLIC_URL,
  INTERNAL_URL: (env.INTERNAL_URL || '').replace(/\/$/, ''), // عنوان داخلي تستخدمه الخدمات على نفس السيرفر
  DATA_DIR: env.DATA_DIR || './data',
  DATABASE_URL: env.DATABASE_URL || '',

  // Claude
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  MODEL: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  FAST_MODEL: env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5',
  SMART_MODEL: env.CLAUDE_SMART_MODEL || env.CLAUDE_MODEL || 'claude-sonnet-5-5',

  // لوحة التحكم
  DASHBOARD_PASSWORD: env.DASHBOARD_PASSWORD,

  // واتساب
  WHATSAPP_TOKEN: env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: env.VERIFY_TOKEN,
  APP_SECRET: env.APP_SECRET,
  OWNER_PHONE: (env.OWNER_PHONE || '').replace(/\D/g, ''),
  GRAPH_VERSION: env.GRAPH_VERSION || 'v23.0',

  // تيليجرام
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_OWNER_ID: env.TELEGRAM_OWNER_ID || '',

  // واتساب عبر Evolution API (رقم السكرتير)
  EVOLUTION_URL: (env.EVOLUTION_URL || '').replace(/\/$/, ''),
  EVOLUTION_API_KEY: env.EVOLUTION_API_KEY || '',
  EVOLUTION_INSTANCE: env.EVOLUTION_INSTANCE || 'secretary',

  // n8n
  N8N_WEBHOOK_URL: env.N8N_WEBHOOK_URL || '',
  N8N_SECRET: env.N8N_SECRET || '',

  // أخرى
  BUSINESS_INFO: env.BUSINESS_INFO || '',
  REPORT_HOUR: Number(env.REPORT_HOUR || 21),
  TZ_OFFSET_H: 3 // الرياض
};
