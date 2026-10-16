#!/bin/bash
# تثبيت «جسر جوال السكرتير» على الماك: يخلي السكرتير يتحكم في آيفونك عبر iPhone Mirroring.
# الاستخدام (من Terminal على الماك): الأمر الجاهز من لوحة التحكم ← الإعدادات ← «التحكم بجوالك»
set -e
URL="__SAKRTIR_URL__"
TOKEN="$1"
DIR="$HOME/.sakrtir"
say() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m✘ %s\033[0m\n" "$*"; exit 1; }

[ "$(uname)" = "Darwin" ] || die "هذا السكربت للماك فقط"
[ -n "$TOKEN" ] || die "ناقص رمز الربط — انسخ الأمر كامل من لوحة التحكم"
ver=$(sw_vers -productVersion | cut -d. -f1)
[ "$ver" -ge 15 ] || die "يحتاج macOS 15 (Sequoia) أو أحدث عشان iPhone Mirroring — نسختك $(sw_vers -productVersion)"

say "1/5 تثبيت أداة uv (مرة وحدة)"
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 || die "ما قدرت أثبت uv"
ok "uv جاهز"

say "2/5 تثبيت phone-harness"
uv tool install --quiet --python 3.12 --upgrade phone-harness
PY="$(uv tool dir)/phone-harness/bin/python"
[ -x "$PY" ] || die "ما لقيت بايثون phone-harness"
ok "phone-harness $("$PY" -c 'import importlib.metadata as m; print(m.version("phone-harness"))')"

say "3/5 تنزيل الجسر وربطه بسكرتيرك"
mkdir -p "$DIR"
curl -fsSL "$URL/phone-bridge/bridge.py" -o "$DIR/phone_bridge.py"
umask 077
printf 'SAKRTIR_URL=%s\nSAKRTIR_PHONE_TOKEN=%s\n' "$URL" "$TOKEN" > "$DIR/env"
cat > "$DIR/sakrtir-bridge.command" <<EOF
#!/bin/bash
# نافذة «جسر جوال السكرتير» — خلّها مفتوحة
set -a; source "$DIR/env"; set +a
while true; do
  "$PY" "$DIR/phone_bridge.py"
  echo "إعادة تشغيل الجسر بعد 5 ثواني..."; sleep 5
done
EOF
chmod 700 "$DIR/sakrtir-bridge.command"
ok "الجسر في $DIR"

say "4/5 يشتغل تلقائياً كل ما تشغّل الماك"
PL="$HOME/Library/LaunchAgents/com.sakrtir.phonebridge.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sakrtir.phonebridge</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>Terminal</string><string>$DIR/sakrtir-bridge.command</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
launchctl unload "$PL" 2>/dev/null || true
launchctl load "$PL" 2>/dev/null || true
ok "يفتح نافذة الجسر تلقائياً بعد كل تشغيل للماك"

say "5/5 الصلاحيات (مرة وحدة)"
echo "• في الإعدادات اللي بتنفتح: فعّل Terminal في «Accessibility» وفي «Screen & System Audio Recording»."
echo "• وافتح تطبيق iPhone Mirroring مرة وحدة وكمّل ربط جوالك (لازم الجوال بيدك)."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true
sleep 1
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" || true
open -a "iPhone Mirroring" 2>/dev/null || true

printf "\n\033[1;32m✅ خلصنا!\033[0m بعد ما تعطي الصلاحيات: سكّر Terminal وافتحه مرة ثانية،\nوبعدها افتح نافذة الجسر بهالأمر (أو أعد تشغيل الماك):\n  open \"%s/sakrtir-bridge.command\"\n\nوفي واتساب السكرتير اكتب: «حالة النظام» وتأكد إن سطر الجوال ✅\n" "$DIR"
