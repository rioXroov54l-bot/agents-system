#!/bin/sh
# تحديث تلقائي (cron كل دقيقة): يسحب أي تحديث من GitHub ويعيد البناء، ويتأكد إن كل الخدمات شغالة.
# - الفحص الكامل كل 10 دقايق، أو فوراً لو المالك ضغط «حدّث الآن» (ملف update-now في مجلد بيانات السكرتير).
# - النتيجة تنكتب في update-status.json عشان اللوحة والسكرتير يعرضونها.
cd /opt/sakrtir 2>/dev/null || exit 0
LOG=/var/log/sakrtir-update.log

# كل دقيقة (بدل كل 10) عشان «حدّث الآن» يكون فوري — الفحص الكامل يبقى كل 10 دقايق
CRON=/etc/cron.d/sakrtir-update
grep -q '^\* \* \* \* \* root sh /opt/sakrtir/deploy/update.sh' "$CRON" 2>/dev/null || echo '* * * * * root sh /opt/sakrtir/deploy/update.sh' > "$CRON"

# تشغيل واحد بس في نفس الوقت (البناء ممكن ياخذ أكثر من دقيقة)
exec 9>/tmp/sakrtir-update.lock
command -v flock >/dev/null 2>&1 && { flock -n 9 || exit 0; }

VOL=$(docker volume inspect -f '{{.Mountpoint}}' sakrtir_agents_data 2>/dev/null)
FORCE=""
if [ -n "$VOL" ] && [ -f "$VOL/update-now" ]; then rm -f "$VOL/update-now"; FORCE=1; fi
MIN=$(date +%M)
[ -z "$FORCE" ] && [ "$(expr "$MIN" % 10)" != "0" ] && exit 0

FJ=false; [ -n "$FORCE" ] && FJ=true
st() { [ -n "$VOL" ] && printf '{"state":"%s","at":"%s","sha":"%s","forced":%s}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$FJ" > "$VOL/update-status.json.tmp" && mv "$VOL/update-status.json.tmp" "$VOL/update-status.json"; }

st checking "$(git rev-parse --short HEAD 2>/dev/null)"
if ! git fetch -q origin main 2>/dev/null; then st failed "$(git rev-parse --short HEAD)"; exit 0; fi
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  st uptodate "$(git rev-parse --short HEAD)"
  cd deploy || exit 0
  want=$(docker compose config --services 2>/dev/null | wc -l)
  have=$(docker compose ps --services --status running 2>/dev/null | wc -l)
  if [ "$have" -lt "$want" ]; then
    echo "=== $(date '+%F %T') تشغيل الخدمات الناقصة ($have/$want)" >> $LOG
    docker compose up -d --remove-orphans >> $LOG 2>&1
  fi
  exit 0
fi
NEW=$(git rev-parse --short origin/main)
st updating "$NEW"
{
  echo "=== $(date '+%F %T') تحديث إلى $NEW${FORCE:+ (طلب المالك)}"
  git pull -q --ff-only && cd deploy && docker compose up -d --build --remove-orphans
} >> $LOG 2>&1 && st done "$NEW" || st failed "$NEW"
