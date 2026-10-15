#!/bin/sh
# تحديث تلقائي كل 10 دقايق (cron): يسحب أي تحديث من GitHub ويعيد البناء،
# ويتأكد إن كل الخدمات شغالة (يشغّل أي خدمة جديدة أو واقفة)
cd /opt/sakrtir 2>/dev/null || exit 0
LOG=/var/log/sakrtir-update.log
git fetch -q origin main 2>/dev/null || exit 0
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  cd deploy || exit 0
  want=$(docker compose config --services 2>/dev/null | wc -l)
  have=$(docker compose ps --services --status running 2>/dev/null | wc -l)
  if [ "$have" -lt "$want" ]; then
    echo "=== $(date '+%F %T') تشغيل الخدمات الناقصة ($have/$want)" >> $LOG
    docker compose up -d --remove-orphans >> $LOG 2>&1
  fi
  exit 0
fi
{
  echo "=== $(date '+%F %T') تحديث إلى $(git rev-parse --short origin/main)"
  git pull -q --ff-only && cd deploy && docker compose up -d --build --remove-orphans
} >> $LOG 2>&1
