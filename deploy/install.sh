#!/usr/bin/env bash
# سكرتيري — تثبيت كامل على سيرفر Ubuntu جديد (Contabo أو غيره) ونقل البيانات من Railway
# الاستخدام (كـ root):  bash <(curl -fsSL https://raw.githubusercontent.com/rioXroov54l-bot/agents-system/main/deploy/install.sh)
set -euo pipefail
REPO="https://github.com/rioXroov54l-bot/agents-system.git"
DIR="/opt/sakrtir"
OLD_URL="${OLD_URL:-https://agents-system-production.up.railway.app}"

say() { echo -e "\n\033[1;36m▶ $*\033[0m"; }
ok()  { echo -e "\033[1;32m✔ $*\033[0m"; }
die() { echo -e "\033[1;31m✘ $*\033[0m"; exit 1; }
[ "$(id -u)" = 0 ] || die "شغّل السكربت كـ root"

say "1/8 تحديث النظام وتثبيت الأدوات"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq ca-certificates curl git ufw python3 cron >/dev/null
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh >/dev/null; fi
systemctl enable --now docker >/dev/null
ok "Docker $(docker --version | awk '{print $3}' | tr -d ,)"

say "2/8 الجدار الناري (SSH + الويب فقط)"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null
ok "مفتوح: 22, 80, 443"

say "3/8 تنزيل الكود"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q "$REPO" "$DIR"; fi
cd "$DIR/deploy"
ok "$DIR"

IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
BASE="${BASE_DOMAIN:-${IP//./-}.sslip.io}"

if [ ! -f .env ]; then
  say "4/8 نقل بياناتك من السيرفر القديم"
  echo "افتح لوحة التحكم القديمة ← الإعدادات ← «إنشاء كود نقل»"
  read -rsp "كلمة سر لوحة التحكم: " OLDPASS </dev/tty; echo
  read -rp  "كود النقل: " CODE </dev/tty
  HTTP=$(curl -sS -X POST "$OLD_URL/api/admin/export" -u "admin:$OLDPASS" -H "x-migrate-code: $CODE" -o migrate.json -w '%{http_code}')
  [ "$HTTP" = "200" ] || { cat migrate.json 2>/dev/null; rm -f migrate.json; die "فشل سحب البيانات (HTTP $HTTP). تأكد من كلمة السر والكود."; }
  chmod 600 migrate.json
  ok "وصلت البيانات ($(du -h migrate.json | cut -f1))"

  if ! python3 -c "import json,sys; sys.exit(0 if json.load(open('migrate.json'))['env'].get('N8N_ENCRYPTION_KEY') else 1)"; then
    echo "مفتاح تشفير n8n ما انتقل تلقائياً. انسخه من Railway ← خدمة n8n ← Variables ← N8N_ENCRYPTION_KEY"
    read -rsp "N8N_ENCRYPTION_KEY (اتركه فاضي لو تبي تعيد ربط Google): " N8NKEY </dev/tty; echo
  else N8NKEY=""; fi

  say "5/8 إنشاء الإعدادات"
  N8NKEY="$N8NKEY" BASE="$BASE" python3 - <<'PY'
import json, os, secrets
d = json.load(open('migrate.json'))
env = dict(d.get('env', {}))
base = os.environ['BASE']
gen = lambda n=32: secrets.token_hex(n)
env.setdefault('N8N_ENCRYPTION_KEY', os.environ.get('N8NKEY') or gen(16))
env.setdefault('N8N_SECRET', gen(24))
env.update({
  'POSTGRES_PASSWORD': gen(16), 'REDIS_PASSWORD': gen(16), 'EVOLUTION_API_KEY': gen(24), 'EVOLUTION_INSTANCE': 'secretary',
  'APP_DOMAIN': 'app.' + base, 'N8N_DOMAIN': 'n8n.' + base, 'KUMA_DOMAIN': 'kuma.' + base,
})
with open('.env', 'w') as f:
    for k, v in env.items():
        v = str(v).replace('\n', ' ')
        if "'" in v: raise SystemExit(f'القيمة {k} فيها علامة اقتباس مفردة، غيّرها وأعد المحاولة')
        f.write(f"{k}='{v}'\n")
os.chmod('.env', 0o600)
print('keys:', ', '.join(sorted(env)))
PY
  ok ".env جاهز"
else
  ok "الإعدادات موجودة مسبقاً (.env) — تحديث فقط"
fi
set -a; . ./.env; set +a

say "6/8 تشغيل قاعدة البيانات وتجهيز n8n"
docker compose build -q agents
docker compose up -d postgres redis
docker compose up -d n8n
for i in $(seq 1 60); do
  if docker compose logs n8n 2>/dev/null | grep -q "Editor is now accessible"; then break; fi; sleep 5
done
ok "n8n جاهز"

if [ -f migrate.json ]; then
  say "7/8 استيراد بياناتك"
  docker compose stop n8n >/dev/null
  SKIP=""
  python3 -c "import json,sys; sys.exit(0 if json.load(open('migrate.json'))['env'].get('N8N_ENCRYPTION_KEY') else 1)" || [ -n "${N8NKEY:-}" ] || SKIP=1
  docker compose run --rm -e SKIP_N8N="$SKIP" -v "$PWD/migrate.json:/migrate.json:ro" agents node deploy/import.js /migrate.json
  [ -z "$SKIP" ] || echo "⚠️ ما انتقلت بيانات n8n لأن مفتاح التشفير ناقص: استورد n8n/agents-bridge.json وأعد ربط Google."
  shred -u migrate.json 2>/dev/null || rm -f migrate.json
  ok "انتقلت البيانات وانحذف ملف النقل"
fi

say "8/8 تشغيل كل الخدمات"
docker compose up -d
# نسخة احتياطية يومية لقاعدة البيانات (آخر 14 يوم)
mkdir -p /opt/sakrtir-backups
cat > /etc/cron.daily/sakrtir-backup <<CRON
#!/bin/sh
cd $DIR/deploy && docker compose exec -T postgres pg_dumpall -U postgres | gzip > /opt/sakrtir-backups/db-\$(date +%F).sql.gz
find /opt/sakrtir-backups -name 'db-*.sql.gz' -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/sakrtir-backup
sleep 20
docker compose ps --format 'table {{.Service}}\t{{.Status}}'

echo -e "\n\033[1;32m🎉 خلصنا!\033[0m"
echo "لوحة التحكم:   https://$APP_DOMAIN"
echo "n8n:           https://$N8N_DOMAIN"
echo "Uptime Kuma:   https://$KUMA_DOMAIN"
echo "الشهادات تطلع تلقائياً خلال دقيقة أو دقيقتين أول مرة."
echo "الحين افتح لوحة التحكم ← الإعدادات ← واتساب وامسح رمز QR من جوال رقم السكرتير."
