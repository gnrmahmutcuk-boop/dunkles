#!/usr/bin/env python3
"""dunkles sunucusu: uygulamayı ve sohbet API'sini tek yerden sunar.
Kullanıcı hiçbir anahtar girmez; model ayarı sadece burada durur.
Çalıştırma: python3 server.py   (önce Ollama kurulu ve çalışıyor olmalı)
"""
import json, os, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
PORT = int(os.environ.get("PORT", "8000"))
DAILY_LIMIT = int(os.environ.get("DAILY_LIMIT", "30"))  # cihaz başına günlük mesaj
HERE = Path(__file__).parent

SYSTEM = ("Sen dunkles adlı bir yapay zekâ asistanısın. Türkçe, kısa ve anlaşılır cevap ver. "
          "Öğrencilere yardımcı ol.")

# Çaba seviyeleri: (model, en fazla cevap uzunluğu, ek talimat)
# Daha güçlü bir sunucun olunca sadece buradaki model adlarını değiştirirsin.
LEVELS = [
    ("qwen2.5:1.5b", 300, ""),
    ("qwen2.5:3b", 500, ""),
    ("qwen2.5:3b", 900, " Önce adım adım düşün, sonra cevabı ver."),
    ("qwen2.5:3b", 1500, " Derinlemesine ve adım adım düşün, cevabını kontrol et."),
]

used, day = {}, [""]


def allow(who):
    today = time.strftime("%Y-%m-%d")
    if day[0] != today:
        used.clear()
        day[0] = today
    used[who] = used.get(who, 0) + 1
    return used[who] <= DAILY_LIMIT


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            b = (HERE / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        elif self.path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "Bulunamadı"})

    def do_POST(self):
        if self.path != "/chat":
            return self._json(404, {"error": "Bulunamadı"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n))
            level = max(0, min(3, int(data.get("level", 0))))
            msgs = [{"role": m["role"], "content": str(m["content"])[:4000]}
                    for m in data["messages"][-12:]
                    if m.get("role") in ("user", "assistant")]
        except Exception:
            return self._json(400, {"error": "Geçersiz istek"})

        who = str(data.get("device") or self.client_address[0])[:64]
        if not allow(who):
            return self._json(429, {"error": f"Bugünlük ücretsiz mesaj hakkın ({DAILY_LIMIT}) doldu. Yarın devam edelim."})

        model, num, extra = LEVELS[level]
        body = json.dumps({
            "model": model, "stream": True,
            "messages": [{"role": "system", "content": SYSTEM + extra}] + msgs,
            "options": {"num_predict": num},
        }).encode()
        req = urllib.request.Request(OLLAMA + "/api/chat", body, {"Content-Type": "application/json"})
        try:
            r = urllib.request.urlopen(req, timeout=300)
        except Exception:
            return self._json(503, {"error": "Yapay zekâ şu an hazır değil, birazdan tekrar dene."})

        with r:
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                for line in r:
                    line = line.strip()
                    if not line:
                        continue
                    piece = json.loads(line).get("message", {}).get("content", "")
                    if piece:
                        self.wfile.write(piece.encode("utf-8"))
                        self.wfile.flush()
            except (OSError, ValueError):
                pass


if __name__ == "__main__":
    print(f"dunkles hazır: http://localhost:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
