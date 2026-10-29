// dunkles bulut sunucusu (Cloudflare Worker)
// Bilgisayar, sunucu ve kullanıcı anahtarı gerekmez. Model Cloudflare'de çalışır.
// Model adları zamanla değişebilir: hata alırsan aşağıdaki LEVELS listesini
// Cloudflare'in "Workers AI > Models" sayfasındaki güncel adlarla değiştir.

const LEVELS = [
  { model: "@cf/meta/llama-3.1-8b-instruct", tokens: 300, extra: "" },
  { model: "@cf/qwen/qwen3-30b-a3b-fp8", tokens: 500, extra: "" },
  { model: "@cf/qwen/qwen3-30b-a3b-fp8", tokens: 900, extra: " Önce adım adım düşün, sonra cevabı ver." },
  { model: "@cf/qwen/qwen3-30b-a3b-fp8", tokens: 1400, extra: " Derinlemesine ve adım adım düşün, cevabını kontrol et." },
];
const FALLBACK = "@cf/meta/llama-3.1-8b-instruct"; // ilk model çalışmazsa bu denenir
const SYSTEM =
  "Sen dunkles adlı bir yapay zekâ asistanısın. Türkçe, kısa ve anlaşılır cevap ver. Öğrencilere yardımcı ol.";
const DAILY_LIMIT = 30; // cihaz başına günlük mesaj (en iyi çaba, bellekte tutulur)
const TTS_DAILY_CHARS = 4000; // cihaz başına günlük doğal ses karakteri

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

const counters = { day: "", chat: new Map(), tts: new Map() };
function bump(map, who, n, limit) {
  const today = new Date().toISOString().slice(0, 10);
  if (counters.day !== today) {
    counters.day = today;
    counters.chat.clear();
    counters.tts.clear();
  }
  const total = (map.get(who) || 0) + n;
  map.set(who, total);
  return total <= limit;
}

function clean(r) {
  const t = r?.response ?? r?.choices?.[0]?.message?.content ?? "";
  return String(t).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health") return json({ ok: true });
    if (req.method !== "POST") return json({ error: "Bulunamadı" }, 404);

    let data;
    try {
      data = await req.json();
    } catch {
      return json({ error: "Geçersiz istek" }, 400);
    }
    const who = String(data.device || req.headers.get("CF-Connecting-IP") || "anon").slice(0, 64);

    if (url.pathname === "/chat") {
      const lv = LEVELS[Math.max(0, Math.min(3, Number(data.level) || 0))];
      const msgs = (data.messages || [])
        .slice(-12)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
      if (!msgs.length) return json({ error: "Geçersiz istek" }, 400);
      if (!bump(counters.chat, who, 1, DAILY_LIMIT))
        return json({ error: `Bugünlük ücretsiz mesaj hakkın (${DAILY_LIMIT}) doldu. Yarın devam edelim.` }, 429);

      const messages = [{ role: "system", content: SYSTEM + lv.extra }, ...msgs];
      for (const model of [lv.model, FALLBACK]) {
        try {
          const text = clean(await env.AI.run(model, { messages, max_tokens: lv.tokens }));
          if (text)
            return new Response(text, { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
        } catch (e) {}
      }
      return json({ error: "Yapay zekâ şu an hazır değil. Bugünlük ücretsiz hak dolmuş olabilir, birazdan tekrar dene." }, 503);
    }

    if (url.pathname === "/speak") {
      if (!env.ELEVEN_KEY) return json({ error: "Doğal ses kapalı" }, 404);
      const text = String(data.text || "").slice(0, 600);
      if (!text) return json({ error: "Geçersiz istek" }, 400);
      if (!bump(counters.tts, who, text.length, TTS_DAILY_CHARS))
        return json({ error: "Doğal ses hakkın bugünlük doldu." }, 429);
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVEN_VOICE || "JBFqnCBsd6RMkjVDRZzb"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": env.ELEVEN_KEY, Accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
        }
      );
      if (!r.ok) return json({ error: "Ses servisi yanıt vermedi." }, 502);
      return new Response(r.body, { headers: { ...cors, "Content-Type": "audio/mpeg" } });
    }

    return json({ error: "Bulunamadı" }, 404);
  },
};
