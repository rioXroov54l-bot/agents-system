#!/bin/sh
# تحديث تلقائي: إذا فيه تحديث جديد على GitHub يسحبه ويعيد بناء السكرتير (يشتغل من cron كل 10 دقايق)
cd /opt/sakrtir 2>/dev/null || exit 0
git fetch -q origin main 2>/dev/null || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
{
  echo "=== $(date '+%F %T') تحديث إلى $(git rev-parse --short origin/main)"
  git pull -q --ff-only && cd deploy && docker compose up -d --build agents
} >> /var/log/sakrtir-update.log 2>&1
