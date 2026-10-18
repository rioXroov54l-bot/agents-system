#!/usr/bin/env python3
"""جسر جوال السكرتير — يشتغل على ماك المالك.

يتصل بسيرفر السكرتير (اتصال خارج فقط، ما يفتح أي منفذ على الماك)، يستلم أوامر محددة
(قراءة الشاشة، لقطة، ضغط، كتابة، فتح تطبيق...) وينفذها على الآيفون عبر phone-harness
(نافذة iPhone Mirroring). ما ينفذ أي كود يجيه من السيرفر — بس قائمة أوامر ثابتة هنا.
"""
import base64
import ipaddress
import socket
import ssl
import struct
import urllib.parse
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request

VERSION = "1.3"
SERVER = os.environ.get("SAKRTIR_URL", "").rstrip("/")
TOKEN = os.environ.get("SAKRTIR_PHONE_TOKEN", "")
if not SERVER or not TOKEN:
    sys.exit("❌ ناقص SAKRTIR_URL أو SAKRTIR_PHONE_TOKEN")

try:
    from phone_harness import helpers as H
except Exception as e:  # noqa: BLE001
    # بدون phone-harness: التحكم بالجوال ما يشتغل، لكن «طريق الماك» للمواقع السعودية يشتغل عادي
    print(f"⚠️ phone-harness مو مثبت ({e}) — التحكم بالجوال متوقف، وطريق المواقع السعودية شغال.")
    H = None

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
    return {"state": state, "detail": detail, "bridge": VERSION, "hint": hint(state + " " + detail)}


def hint(text):
    t = str(text)
    if re.search(r"unlock|in use|using|locked", t, re.I):
        return "قفّل الآيفون وخلّه قريب من الماك (المراية توقف لما تستخدم الجوال)"
    if re.search(r"Accessibility|Screen Recording|permission|not permitted|TCC", t, re.I):
        return "Terminal يحتاج صلاحية «تسهيلات الاستخدام» و«تسجيل الشاشة» ثم أعد فتح نافذة الجسر"
    if re.search(r"auth|Touch ID|password|sign", t, re.I):
        return "iPhone Mirroring يطلب بصمة: افتحه ← الإعدادات (⌘,) ← اختر «المصادقة تلقائياً»"
    if re.search(r"not running|no window|not found|Connect", t, re.I):
        return "افتح تطبيق iPhone Mirroring على الماك وتأكد إنه يعرض جوالك"
    return ""


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


OP_TIMEOUT = {"open_app": 110, "type": 110, "status": 50, "screen": 80, "screenshot": 80}


def run_op(op, args):
    """ينفذ الأمر بمهلة: لو علق (بصمة، الجوال مفتوح...) نرجع خطأ واضح بدل ما يوقف الجسر."""
    box = {}

    def work():
        try:
            fn = OPS.get(op)
            if not fn:
                raise ValueError("أمر غير معروف: " + str(op))
            box["res"] = fn(args)
        except Exception as e:  # noqa: BLE001
            box["err"] = f"{type(e).__name__}: {e}"[:500]

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(float(os.environ.get("BRIDGE_OP_TIMEOUT") or OP_TIMEOUT.get(op, 70)))
    if t.is_alive():
        raise TimeoutError("الأمر علق على الماك — غالباً iPhone Mirroring ينتظر بصمة أو الجوال مفتوح. " + hint("auth"))
    if "err" in box:
        raise RuntimeError(box["err"] + (" — " + hint(box["err"]) if hint(box["err"]) else ""))
    return box.get("res")


def heartbeat():
    first = True
    while True:
        if not first:
            time.sleep(15)
        first = False
        try:
            _, r = http("POST", "/phone-bridge/ping", {"v": VERSION}, timeout=15)
            latest = (r or {}).get("version")
            if latest and latest != VERSION:
                self_update(latest, hard=True)
        except Exception:  # noqa: BLE001
            pass


def self_update(latest, hard=False):
    """السيرفر عنده نسخة أحدث من الجسر: ننزلها ونعيد التشغيل (نافذة الجسر تشغله من جديد تلقائياً)."""
    try:
        req = urllib.request.Request(SERVER + "/phone-bridge/bridge.py", headers={"User-Agent": "sakrtir-phone-bridge/" + VERSION})
        with urllib.request.urlopen(req, timeout=30) as r:
            code = r.read()
        if b"OPS = {" not in code:
            return
        me = os.path.abspath(__file__)
        with open(me + ".new", "wb") as f:
            f.write(code)
        os.replace(me + ".new", me)
        print(f"⬆️ تحديث الجسر إلى {latest} — إعادة تشغيل...", flush=True)
        if hard:
            os._exit(0)  # من خيط النبض: نطلع فوراً ونافذة الجسر تشغل النسخة الجديدة
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print("⚠️ ما قدرت أحدّث الجسر:", str(e)[:100])


def poll():
    req = urllib.request.Request(SERVER + "/phone-bridge/poll?v=" + VERSION, method="GET", headers={
        "Authorization": "Bearer " + TOKEN, "User-Agent": "sakrtir-phone-bridge/" + VERSION})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
        return r.status, (json.loads(raw) if raw else None), r.headers.get("X-Bridge-Version")


# ---------- «طريق الماك» للمواقع السعودية ----------
# بعض المواقع (التأمين والحكومية...) تحجب السيرفرات اللي برا السعودية. هنا نفتح اتصال خارج للسيرفر (WebSocket)،
# والسيرفر يمرر فيه طلبات متصفح وكيل المواقع، والماك يفتحها من إنترنت البيت.
# الأمان: نقبل المنافذ 80/443 فقط، ونرفض أي عنوان داخلي (الراوتر، شبكة البيت، الماك نفسه).
T_OPEN, T_OK, T_FAIL, T_DATA, T_CLOSE = 1, 2, 3, 4, 5
TUN_PORTS = {80, 443}


def _public_ip(ip):
    a = ipaddress.ip_address(ip)
    if getattr(a, "ipv4_mapped", None):
        a = a.ipv4_mapped
    return not (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved
                or a.is_unspecified or (a.version == 4 and a in ipaddress.ip_network("100.64.0.0/10")))


class Tunnel:
    def __init__(self):
        self.sock = None
        self.lock = threading.Lock()
        self.conns = {}
        self.online = False

    # --- WebSocket client (stdlib) ---
    def _connect(self):
        u = urllib.parse.urlparse(SERVER)
        host, port = u.hostname, u.port or (443 if u.scheme == "https" else 80)
        raw = socket.create_connection((host, port), timeout=20)
        s = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if u.scheme == "https" else raw
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path.rstrip("/") or "") + "/phone-bridge/tunnel"
        s.sendall((f"GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer {TOKEN}\r\n"
                   f"User-Agent: sakrtir-phone-bridge/{VERSION}\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            c = s.recv(1024)
            if not c:
                raise ConnectionError("السيرفر قفل الاتصال")
            head += c
        status = head.split(b"\r\n", 1)[0]
        if b" 101 " not in status + b" ":
            code = status.split(b" ")[1].decode() if len(status.split(b" ")) > 1 else "?"
            raise PermissionError(code)
        self._pending = head.split(b"\r\n\r\n", 1)[1]
        s.settimeout(None)
        return s

    def _send_frame(self, op, payload=b""):
        n = len(payload)
        hdr = bytes([0x80 | op])
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i & 3] for i, b in enumerate(payload)) if n < 4096 else _xor(payload, mask)
        with self.lock:
            if self.sock:
                self.sock.sendall(hdr + mask + body)

    def send(self, typ, cid, data=b""):
        try:
            self._send_frame(0x2, bytes([typ]) + struct.pack(">I", cid) + data)
        except Exception:  # noqa: BLE001
            pass

    def _recv_exact(self, n):
        out = b""
        if self._pending:
            out, self._pending = self._pending[:n], self._pending[n:]
        while len(out) < n:
            c = self.sock.recv(n - len(out))
            if not c:
                raise ConnectionError("انقطع")
            out += c
        return out

    def _read_frame(self):
        b0, b1 = self._recv_exact(2)
        op, n = b0 & 0x0F, b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._recv_exact(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._recv_exact(8))[0]
        if b1 & 0x80:
            mask = self._recv_exact(4)
            return op, _xor(self._recv_exact(n), mask)
        return op, self._recv_exact(n)

    # --- streams ---
    def _open(self, cid, data):
        try:
            req = json.loads(data.decode())
            host, port = str(req["h"]), int(req["p"])
            if port not in TUN_PORTS:
                raise PermissionError("منفذ غير مسموح")
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
            ips = [i[4][0] for i in infos]
            if not ips or not all(_public_ip(ip) for ip in ips):
                raise PermissionError("عنوان داخلي ممنوع")
            last = None
            for fam, _t, _p, _c, addr in infos:
                try:
                    c = socket.socket(fam, socket.SOCK_STREAM)
                    c.settimeout(15)
                    c.connect(addr)
                    break
                except OSError as e:
                    last = e
                    c = None
            if c is None:
                raise last or OSError("ما قدرت أتصل")
            c.settimeout(None)
            self.conns[cid] = c
            self.send(T_OK, cid)
            threading.Thread(target=self._pump, args=(cid, c), daemon=True).start()
        except Exception as e:  # noqa: BLE001
            self.send(T_FAIL, cid, str(e)[:200].encode())

    def _pump(self, cid, c):
        try:
            while True:
                d = c.recv(65536)
                if not d:
                    break
                self.send(T_DATA, cid, d)
        except OSError:
            pass
        if self.conns.pop(cid, None) is not None:
            self.send(T_CLOSE, cid)
        try:
            c.close()
        except OSError:
            pass

    def _close_all(self):
        for c in list(self.conns.values()):
            try:
                c.close()
            except OSError:
                pass
        self.conns.clear()

    def _pinger(self, s):
        while self.sock is s:
            time.sleep(20)
            try:
                self._send_frame(0x9)
            except Exception:  # noqa: BLE001
                return

    def run(self):
        backoff = 3
        while True:
            try:
                self._pending = b""
                self.sock = self._connect()
                self.online, backoff = True, 3
                print("🏠 طريق الماك للمواقع السعودية: متصل", flush=True)
                threading.Thread(target=self._pinger, args=(self.sock,), daemon=True).start()
                while True:
                    op, payload = self._read_frame()
                    if op == 0x8:
                        break
                    if op == 0x9:
                        self._send_frame(0xA, payload)
                        continue
                    if op != 0x2 or len(payload) < 5:
                        continue
                    typ, cid, data = payload[0], struct.unpack(">I", payload[1:5])[0], payload[5:]
                    if typ == T_OPEN:
                        threading.Thread(target=self._open, args=(cid, data), daemon=True).start()
                    elif typ == T_DATA:
                        c = self.conns.get(cid)
                        if c:
                            try:
                                c.sendall(data)
                            except OSError:
                                self.conns.pop(cid, None)
                                self.send(T_CLOSE, cid)
                        else:
                            self.send(T_CLOSE, cid)
                    elif typ == T_CLOSE:
                        c = self.conns.pop(cid, None)
                        if c:
                            try:
                                c.shutdown(socket.SHUT_RDWR)
                            except OSError:
                                pass
                            c.close()
            except PermissionError as e:
                if str(e) == "401":
                    time.sleep(300)
                    continue
                if str(e) == "404":  # السيرفر لسا ما تحدث
                    time.sleep(120)
                    continue
                print("⚠️ طريق الماك:", e, flush=True)
            except Exception as e:  # noqa: BLE001
                if self.online:
                    print("⚠️ طريق الماك انقطع:", str(e)[:100], flush=True)
            self.online = False
            s, self.sock = self.sock, None
            try:
                s and s.close()
            except OSError:
                pass
            self._close_all()
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


def _xor(data, mask):
    if not data:
        return b""
    m = int.from_bytes((mask * (len(data) // 4 + 1))[:len(data)], "big")
    return (int.from_bytes(data, "big") ^ m).to_bytes(len(data), "big")


def main():
    print(f"📱 جسر جوال السكرتير {VERSION} شغال — خلّ هالنافذة مفتوحة، وخلّ الآيفون مقفول وقريب من الماك.")
    print(f"   السيرفر: {SERVER}", flush=True)
    # النبض (والتحديث التلقائي) وطريق المواقع السعودية يبدون أول — ما ينتظرون فحص المراية لو علق
    threading.Thread(target=heartbeat, daemon=True).start()
    threading.Thread(target=Tunnel().run, daemon=True).start()
    try:
        st = run_op("status", {})
        print("   حالة المراية:", st["state"], ("— " + st["hint"]) if st.get("hint") else "")
    except Exception as e:  # noqa: BLE001
        print("   ⚠️ فحص المراية:", str(e)[:150], "—", hint(str(e)))
    backoff = 2
    while True:
        try:
            st, cmd, latest = poll()
            backoff = 2
            if latest and latest != VERSION:
                self_update(latest)
            if st == 204 or not cmd:
                continue
            op, args, cid = cmd.get("op"), cmd.get("args") or {}, cmd.get("id")
            print(time.strftime("%H:%M:%S"), "▶", op, {k: v for k, v in args.items() if k != "text"})
            try:
                res = {"id": cid, "ok": True, "result": run_op(op, args)}
                print("   ✓")
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
