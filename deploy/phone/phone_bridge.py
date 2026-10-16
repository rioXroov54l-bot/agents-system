#!/usr/bin/env python3
"""جسر جوال السكرتير — يشتغل على ماك المالك.

يتصل بسيرفر السكرتير (اتصال خارج فقط، ما يفتح أي منفذ على الماك)، يستلم أوامر محددة
(قراءة الشاشة، لقطة، ضغط، كتابة، فتح تطبيق...) وينفذها على الآيفون عبر phone-harness
(نافذة iPhone Mirroring). ما ينفذ أي كود يجيه من السيرفر — بس قائمة أوامر ثابتة هنا.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request

VERSION = "1.0"
SERVER = os.environ.get("SAKRTIR_URL", "").rstrip("/")
TOKEN = os.environ.get("SAKRTIR_PHONE_TOKEN", "")
if not SERVER or not TOKEN:
    sys.exit("❌ ناقص SAKRTIR_URL أو SAKRTIR_PHONE_TOKEN")

try:
    from phone_harness import helpers as H
except Exception as e:  # noqa: BLE001
    sys.exit(f"❌ phone-harness مو مثبت: {e}")

# تطبيقات ممنوعة: البنوك والمحافظ وكلمات السر والاستثمار
DENY_APPS = re.compile(
    r"bank|بنك|مصرف|rajhi|راجحي|ahli|الأهلي|snb|alinma|الإنماء|riyad|albilad|البلاد|aljazira|الجزيرة|\bsab\b|ساب|"
    r"stc ?pay|urpay|wallet|محفظ|apple ?pay|password|كلمات ?(ال)?سر|keychain|authenticator|binance|crypto|"
    r"tadawul|تداول|derayah|دراية|sahm|سهم|mubasher|مباشر|tabby|تابي|tamara|تمارا|paypal|western ?union",
    re.I,
)


def _boxes(min_confidence=0.3):
    out = []
    for b in H.screen(min_confidence=min_confidence) or []:
        t = str(b.get("text", "")).strip()
        if t:
            out.append({"t": t, "x": round(float(b.get("x", 0))), "y": round(float(b.get("y", 0)))})
    return out


def _shot(width=600):
    p = H.screenshot()
    fd, jpg = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    try:
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "60", "--resampleWidth", str(int(width)), p, "--out", jpg],
                       check=True, capture_output=True, timeout=30)
        dims = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", jpg], capture_output=True, text=True, timeout=15).stdout
        w = int(re.search(r"pixelWidth: (\d+)", dims).group(1))
        h = int(re.search(r"pixelHeight: (\d+)", dims).group(1))
        with open(jpg, "rb") as f:
            data = base64.b64encode(f.read()).decode()
        return {"jpeg_b64": data, "width": w, "height": h}
    finally:
        for f in (jpg, p):
            try:
                os.remove(f)
            except OSError:
                pass


def op_status(a):
    state = H.connection_state()
    detail = ""
    if state != "ready":
        try:
            H.ensure_device()
            state = H.connection_state()
        except Exception as e:  # noqa: BLE001
            detail = str(e)[:300]
    return {"state": state, "detail": detail, "bridge": VERSION}


def op_screen(a):
    res = {"boxes": _boxes(a.get("min_confidence", 0.3))}
    if a.get("screenshot"):
        res["image"] = _shot(a.get("width", 600))
    return res


def op_open_app(a):
    name = str(a.get("name", ""))
    if DENY_APPS.search(name):
        raise PermissionError("ممنوع: تطبيقات البنوك والمحافظ وكلمات السر والاستثمار")
    app = H.open_app(name)
    return {"app": app, "boxes": _boxes()}


def _after():
    try:
        H.wait_stable(timeout=4)
    except Exception:  # noqa: BLE001
        time.sleep(1)
    return {"boxes": _boxes()}


OPS = {
    "status": op_status,
    "screen": op_screen,
    "screenshot": lambda a: _shot(a.get("width", 600)),
    "open_app": op_open_app,
    "tap": lambda a: (H.tap(float(a["x"]), float(a["y"])), _after())[1],
    "tap_text": lambda a: (H.tap_text(str(a["text"]), index=int(a.get("index", 0)), exact=bool(a.get("exact", False))), _after())[1],
    "tap_image": lambda a: (H.tap_image_point(float(a["x"]), float(a["y"]), image_size=(int(a["width"]), int(a["height"]))), _after())[1],
    "long_press": lambda a: (H.long_press(float(a["x"]), float(a["y"])), _after())[1],
    "type": lambda a: (H.type_text(str(a["text"])), {"boxes": _boxes()})[1],
    "press": lambda a: (H.press(str(a["key"])), _after())[1],
    "home": lambda a: (H.home(), _after())[1],
    "app_switcher": lambda a: (H.app_switcher(), _after())[1],
    "swipe": lambda a: (H.swipe(str(a.get("direction", "up")), distance=float(a.get("distance", 0.4))), _after())[1],
    "scroll": lambda a: (H.scroll(str(a.get("direction", "down")), amount=float(a.get("amount", 0.5))), _after())[1],
}


def http(method, path, body=None, timeout=40):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SERVER + path, data=data, method=method, headers={
        "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", "User-Agent": "sakrtir-phone-bridge/" + VERSION})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return r.status, (json.loads(raw) if raw else None)


def main():
    print("📱 جسر جوال السكرتير شغال — خلّ هالنافذة مفتوحة، وخلّ الآيفون مقفول وقريب من الماك.")
    print(f"   السيرفر: {SERVER}")
    backoff = 2
    while True:
        try:
            st, cmd = http("GET", "/phone-bridge/poll?v=" + VERSION, timeout=40)
            backoff = 2
            if st == 204 or not cmd:
                continue
            op, args, cid = cmd.get("op"), cmd.get("args") or {}, cmd.get("id")
            print(time.strftime("%H:%M:%S"), "▶", op, {k: v for k, v in args.items() if k != "text"})
            try:
                fn = OPS.get(op)
                if not fn:
                    raise ValueError("أمر غير معروف: " + str(op))
                res = {"id": cid, "ok": True, "result": fn(args)}
            except Exception as e:  # noqa: BLE001
                res = {"id": cid, "ok": False, "error": f"{type(e).__name__}: {e}"[:500]}
                print("   ⚠️", res["error"])
            http("POST", "/phone-bridge/result", res, timeout=60)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print("❌ رمز الربط انلغى أو غلط. أنشئ رمز جديد من لوحة التحكم وشغّل أمر التثبيت مرة ثانية.")
                time.sleep(300)
            else:
                print("⚠️ السيرفر رد", e.code)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
        except KeyboardInterrupt:
            print("وقف الجسر.")
            return
        except Exception as e:  # noqa: BLE001
            print("⚠️ انقطع الاتصال:", str(e)[:120])
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(1)
