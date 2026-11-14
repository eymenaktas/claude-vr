// Claude Ses — claude.ai üzerine binen sesli mod.
// Akış: dinle (claude.ai "Dictate") → sessizlikte gönder ("Send") → Claude çalışırken bekle ("Stop" görünür)
// → bitince son yanıtın "Read aloud" düğmesine bas → okurken altyazı göster → bitince yeniden dinle.
// Not: innerHTML ve inline <style> kullanılmıyor (claude.ai'nin CSP / Trusted Types kuralları yüzünden);
// arayüz Shadow DOM + adoptedStyleSheets ile kuruluyor.
(() => {
  if (window.__claudeSes && window.__claudeSes.ready) return;
  const CS = (window.__claudeSes = window.__claudeSes || {});
  CS.ready = true;
  CS.version = "0.6.0";

  // ---------- Ayarlar ----------
  const CFG = {
    silenceMs: 1400,          // konuşma bittikten sonra bu kadar sessizlik → gönder
    minSpeechMs: 350,         // bundan kısa sesler konuşma sayılmaz
    composerSettleMs: 700,    // dikte metni bu kadar değişmeyince hazır say
    startTimeoutMs: 6000,     // gönderdikten sonra Claude'un başlamasını bekleme süresi
    charsPerSecond: 14,       // ses seviyesi/süresi okunamazsa altyazı hızı tahmini
    autoListen: true,
    narrate: true,
    bargeIn: true,
    wakeWord: true,           // "Hey Claude" modu: arkada sürekli dinle, yalnızca "Hey Claude" ile başlayanı gönder            // Claude okurken konuşmaya başlayınca okumayı kes
    dictEngine: "claude",    // dikte: "whisper" (Mac'teki Claude Ses Sunucu) | "claude" (claude.ai Dictate); Mac yoksa claude
    whisperUrl: "",                // Mac bulununca doldurulur            // Claude çalışırken ara mesajlarını da sesli oku
  };
  const LS_KEY = "claudeSes.settings";
  try { Object.assign(CFG, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); } catch (_) {}
  const saveCfg = () => { try { localStorage.setItem(LS_KEY, JSON.stringify({ autoListen: CFG.autoListen, narrate: CFG.narrate, wakeWord: CFG.wakeWord })); } catch (_) {} };

  CS.logs = CS.logs || [];
  const log = (...a) => {
    try {
      const line = new Date().toISOString().slice(11, 19) + " " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
      CS.logs.push(line);
      if (CS.logs.length > 200) CS.logs.shift();
      console.log("[ClaudeSes]", ...a);
    } catch (_) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Ses seviyeleri (mikrofon ve hoparlör) ----------
  // Sayfanın kendi sesini yeniden yönlendirmeden yalnızca dinliyoruz: mikrofon akışını kendi
  // AudioContext'imize bağlıyoruz, çalınan sesi captureStream / connect kancasıyla ölçüyoruz.
  const levels = { mic: 0, out: 0, micActive: false, outActive: false, outEl: null };
  let actx = null;
  const ensureCtx = () => {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
    }
    if (actx.state === "suspended") actx.resume().catch(() => {});
    return actx;
  };
  const makeMeter = (ctx) => {
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.6;
    const buf = new Float32Array(an.fftSize);
    return {
      node: an,
      read() {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        return Math.sqrt(s / buf.length);
      },
    };
  };

  const micMeters = new Set();
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia && !navigator.mediaDevices.__csHooked) {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await orig(constraints);
      try {
        if (constraints && constraints.audio) {
          const ctx = ensureCtx();
          if (ctx) {
            const src = ctx.createMediaStreamSource(stream);
            const m = makeMeter(ctx);
            src.connect(m.node);
            const entry = { m, stream };
            micMeters.add(entry);
            levels.micActive = true;
            stream.getAudioTracks().forEach((t) =>
              t.addEventListener("ended", () => {
                micMeters.delete(entry);
                levels.micActive = micMeters.size > 0;
              })
            );
            log("mikrofon akışı yakalandı");
          }
        }
      } catch (e) { log("mic meter hata", e); }
      return stream;
    };
    navigator.mediaDevices.__csHooked = true;
  }

  // Çalınan ses: <audio>/<video> elemanları
  const outMeters = new Map();
  const watchMedia = (el) => {
    if (!el || outMeters.has(el)) return;
    // claude.ai'nin kısa efekt sesleri (giriş/çıkış "ding"leri) okuma sayılmaz.
    if (/\/sfx\//.test(el.currentSrc || el.src || "")) return;
    const entry = { m: null, el };
    outMeters.set(el, entry);
    const tryMeter = () => {
      if (entry.m) return;
      try {
        const ctx = ensureCtx();
        const cs = el.captureStream ? el.captureStream() : el.mozCaptureStream ? el.mozCaptureStream() : null;
        if (ctx && cs && cs.getAudioTracks().length) {
          const src = ctx.createMediaStreamSource(cs);
          entry.m = makeMeter(ctx);
          src.connect(entry.m.node);
        }
      } catch (e) { /* çapraz kaynak vb. → yalnızca zamanlamayı kullanırız */ }
    };
    el.addEventListener("playing", () => { levels.outActive = true; levels.outEl = el; tryMeter(); bus.emit("audio-start", el); });
    el.addEventListener("pause", () => { if (levels.outEl === el) { levels.outActive = false; bus.emit("audio-end", el); } });
    el.addEventListener("ended", () => { if (levels.outEl === el) { levels.outActive = false; bus.emit("audio-end", el); } });
  };
  if (!HTMLMediaElement.prototype.__csHooked) {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) {
      try { watchMedia(this); } catch (_) {}
      return origPlay.apply(this, a);
    };
    HTMLMediaElement.prototype.__csHooked = true;
  }

  // Web Audio ile çalınan ses: hedefe bağlanan her düğümü kendi ölçerimize de bağla.
  const ctxMeters = new WeakMap();
  const ctxActivity = { lastLoud: 0 };
  if (window.AudioNode && !AudioNode.prototype.__csHooked) {
    const origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      const r = origConnect.call(this, dest, ...rest);
      try {
        if (dest && typeof AudioDestinationNode !== "undefined" && dest instanceof AudioDestinationNode && this.context !== actx) {
          let m = ctxMeters.get(this.context);
          if (!m) { m = makeMeter(this.context); ctxMeters.set(this.context, m); CS._ctxMeterList = (CS._ctxMeterList || []).concat([m]); }
          origConnect.call(this, m.node);
        }
      } catch (_) {}
      return r;
    };
    AudioNode.prototype.__csHooked = true;
  }

  const readLevels = () => {
    let mic = 0;
    micMeters.forEach((e) => { mic = Math.max(mic, e.m.read()); });
    let out = 0;
    outMeters.forEach((e) => { if (e.m && !e.el.paused) out = Math.max(out, e.m.read()); });
    (CS._ctxMeterList || []).forEach((m) => { out = Math.max(out, m.read()); });
    if (out > 0.01) ctxActivity.lastLoud = performance.now();
    levels.mic = mic;
    levels.out = out;
  };

  // ---------- Küçük olay yolu ----------
  const bus = {
    h: {},
    on(n, f) { (this.h[n] = this.h[n] || []).push(f); },
    emit(n, d) { (this.h[n] || []).forEach((f) => { try { f(d); } catch (e) { log(e); } }); },
  };

  // ---------- claude.ai sayfa bağlantıları ----------
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && !el.disabled;
  const byLabel = (re) =>
    [...document.querySelectorAll("button,[role=button]")].filter((b) => re.test(b.getAttribute("aria-label") || ""));
  const page = {
    composer() {
      const list = [...document.querySelectorAll("[contenteditable=true], textarea")].filter(visible);
      return list.find((e) => e.closest("form,fieldset,[data-testid*=prompt],[class*=composer],[class*=prompt]")) || list[list.length - 1] || null;
    },
    composerText() {
      const c = page.composer();
      if (!c) return "";
      return (c.value !== undefined && c.tagName === "TEXTAREA" ? c.value : c.innerText || "").replace(/​/g, "").trim();
    },
    dictateBtn() {
      return byLabel(/dictat|dikte|voice input|microphone|mikrofon/i).filter(visible)[0] || null;
    },
    dictating() {
      const b = page.dictateBtn();
      if (!b) return false;
      const l = (b.getAttribute("aria-label") || "").toLowerCase();
      // claude.ai dikte açıkken etiketi "Finish dictation" yapıyor. Mikrofon akışı dikte bittikten sonra da
      // açık kalabildiği için ona bakmak, "durdur" sanılan tıklamanın dikteyi yeniden açmasına yol açıyordu.
      return b.getAttribute("aria-pressed") === "true" || /finish|stop|durdur|bitir/.test(l);
    },
    sendBtn() {
      return byLabel(/^send$|^gönder|send message/i).filter(visible)[0] || null;
    },
    stopBtn() {
      const b = document.querySelector("[data-testid=code-prompt-stop]") || byLabel(/^stop$|stop response|durdur/i)[0];
      return visible(b) ? b : null;
    },
    busy() { return !!page.stopBtn(); },
    readAloudBtns() {
      return [...document.querySelectorAll("[data-testid=epitaxy-read-aloud], button[aria-label='Read aloud'], button[aria-label='Sesli oku']")];
    },
    messageTextFor(btn) {
      let el = btn;
      for (let i = 0; i < 12 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.querySelectorAll("[data-testid=epitaxy-read-aloud]").length > 1) break;
        const md = el.querySelector(".prose, [class*=markdown], [class*=message-content], [data-testid*=message]");
        if (md && (md.innerText || "").trim().length > 2) return md.innerText.trim();
        const t = (el.innerText || "").trim();
        if (t.length > 40) return t;
      }
      return "";
    },
    // Son kullanıcı mesajından sonraki yanıt metni (Read aloud'un okuduğu tur).
    // back=0: son kullanıcı mesajından sonrası; back=1: bir önceki tur (sıradaki mesaj henüz yanıtlanmadıysa).
    lastTurnText(back = 0) {
      const users = [...document.querySelectorAll("[data-testid=user-message]")];
      const from = users[users.length - 1 - back];
      const to = back ? users[users.length - back] : null;
      const F = Node.DOCUMENT_POSITION_FOLLOWING;
      return [...document.querySelectorAll(".prose")]
        .filter((p) => !p.closest("[data-testid=user-message]") && !p.parentElement.closest(".prose"))
        .filter((p) => (!from || (from.compareDocumentPosition(p) & F)) && (!to || (p.compareDocumentPosition(to) & F)))
        .map((p) => (p.innerText || "").trim()).filter(Boolean).join("\n\n");
    },
    // Read aloud'un okuyacağı metin: son tamamlanan tur.
    readableText() { return page.lastTurnText(0) || page.lastTurnText(1); },
    workingLine() {
      const w = document.querySelector("[data-testid=code-working-line]");
      return w ? (w.innerText || "").replace(/\s+/g, " ").trim() : "";
    },
    permissionButtons() {
      const btns = [...document.querySelectorAll("button")].filter(visible);
      const allow = btns.find((b) => /^(allow|approve|yes|izin ver|onayla|evet)\b/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()));
      const deny = btns.find((b) => /^(deny|reject|no|reddet|hayır)\b/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()));
      if (!allow) return null;
      let box = allow.parentElement;
      for (let i = 0; i < 6 && box && (box.innerText || "").length < 30; i++) box = box.parentElement;
      return { allow, deny, text: box ? box.innerText.split("\n").filter((l) => l.trim() && !/^(allow|deny|approve|reject)/i.test(l.trim())).slice(0, 4).join(" · ") : "" };
    },
    // Yalnızca açık bir oturumun içi: ana /code sayfasında göndermek yeni (bulut) oturum açıyor.
    onSessionPage() { return /\/(code\/session_|chat\/)/.test(location.pathname) && !!page.composer(); },
    pauseBtn() {
      return byLabel(/^(pause|stop reading|duraklat)$/i).filter(visible)[0] || null;
    },
  };
  CS.page = page;

  // Sanal klavye: sesli moddayken yazı kutusu odaklansa da klavye açılmasın.
  const kb = {
    suppress(on) {
      const c = page.composer();
      if (!c) return;
      if (on) {
        if (!c.hasAttribute("data-cs-im")) c.setAttribute("data-cs-im", c.getAttribute("inputmode") || "");
        c.setAttribute("inputmode", "none");
      } else if (c.hasAttribute("data-cs-im")) {
        const v = c.getAttribute("data-cs-im");
        if (v) c.setAttribute("inputmode", v); else c.removeAttribute("inputmode");
        c.removeAttribute("data-cs-im");
      }
    },
    hide() {
      try { if (window.ClaudeSesNative && window.ClaudeSesNative.hideKeyboard) window.ClaudeSesNative.hideKeyboard(); } catch (_) {}
    },
    hideSoon() { [60, 250, 600].forEach((ms) => setTimeout(() => kb.hide(), ms)); },
  };
  const voiceOpen = () => !!(ui.stage && ui.stage.classList.contains("open"));

  // ---------- Uygulama köprüsü: görünmez dikte sayfası, bildirim, odak ----------
  const native = window.ClaudeSesNative || null;
  const helper = {
    ok: !!(native && native.dict),
    partial: "", level: 0, changedAt: 0, started: false, err: "", waiters: [],
    start() { this.partial = ""; this.level = 0; this.started = false; this.err = ""; this.startedAt = performance.now(); native.dict("start"); },
    stop() {
      return new Promise((res) => {
        const to = setTimeout(() => res(this.partial), 5000);
        this.waiters.push((t) => { clearTimeout(to); res(t); });
        native.dict("stop");
      });
    },
    cancel() { native.dict("cancel"); this.level = 0; },
  };
  CS.helper = helper;
  let whisperOk = false;
  const useWhisper = () => CFG.dictEngine === "whisper" && whisperOk && native && native.wMode;
  const whisperSetup = () => {
    if (!native || !native.wConfig) return;
    native.wConfig(CFG.whisperUrl, "tr", Math.max(600, CFG.silenceMs - 300), "Claude, Quest, commit, build, deploy, oturum.");
    try { native.wWake(new URL(CFG.whisperUrl).hostname); } catch (_) { native.wPing(); }
  };
  CS.whisperSetup = whisperSetup;
  const appFocused = () => { try { return native && native.isFocused ? native.isFocused() : !document.hidden; } catch (_) { return true; } };
  const notifyUser = (title, text) => {
    try { if (native && native.notify) native.notify(title, (text || "").slice(0, 300)); } catch (_) {}
  };
  CS.onNative = (type, data) => {
    switch (type) {
      case "dict-partial": helper.partial = data || ""; helper.changedAt = performance.now(); break;
      case "dict-level": helper.level = Math.min(1, (+data || 0)); break;
      case "dict-started": helper.started = true; log("dikte başladı"); break;
      case "dict-final": { const w = helper.waiters.splice(0); w.forEach((f) => f(data || helper.partial)); break; }
      case "dict-error":
        helper.err = data; log("dikte hatası", data);
        if (machine.state === "listening") { toast(data === "giriş gerekli" ? "Dikte için claude.ai girişi gerekli." : "Dikte başlamadı: " + data); native.dict("reload"); machine.cancelListening(); }
        break;
      case "dict-loaded": log("dikte sayfası hazır", data); break;
      case "w-level": helper.level = Math.min(1, (+data || 0)); break;
      case "w-mic": log("mikrofon", data); break;
      case "w-ping": whisperOk = data === true || data === "true"; log("whisper", whisperOk ? "erişilebilir" : "yok"); renderPill(); break;
      case "mac-found": {
        log("Mac bulundu", data);
        CFG.whisperUrl = "http://" + data + ":8178"; saveCfg();
        break;
      }
      case "mac-error": log("Mac arama hatası", data); break;
      case "w-wake": {
        let st = "";
        try { st = JSON.parse(data).state; } catch (_) {}
        log("Mac sunucu", st);
        if (st === "ready") { whisperOk = true; renderPill(); }
        else if (st === "starting") { whisperOk = false; renderPill(); setTimeout(() => native.wWake(""), 1500); }
        else { whisperOk = false; renderPill(); }
        break;
      }
      case "w-barge":
        log("araya girildi");
        if (machine.state === "speaking") {
          machine.stopSpeaking(false, true);
          if (useWhisper()) { machine.beginListeningUi(); }
          else { native.wMode("off"); machine.listen(); }
        }
        break;
      case "w-partial":
        if (machine.state === "listening" && data) { helper.partial = data; setSub(data.length > 160 ? "…" + data.slice(-160) : data, "you"); }
        break;
      case "w-end": if (machine.state === "listening" && useWhisper()) machine.set("sending"); break;
      case "w-final":
        if ((machine.state === "sending" || machine.state === "listening") && useWhisper()) {
          machine.set("sending");
          if (data && data.trim()) machine.finishWithText(data.trim()); else machine.listen();
        }
        break;
      case "w-error":
        log("whisper hatası", data);
        if (useWhisper() && (machine.state === "listening" || machine.state === "sending")) {
          toast("Whisper'a ulaşılamadı, Claude diktesine geçiyorum.");
          whisperOk = false; machine.set("idle"); machine.listen();
        }
        break;
      default: if (CS.onNativeExtra) CS.onNativeExtra(type, data);
    }
  };

  const click = (el) => {
    if (!el) return false;
    const r = clickRaw(el);
    if (voiceOpen()) { kb.suppress(true); kb.hideSoon(); }
    return r;
  };
  const clickRaw = (el) => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  };

  // ---------- Metni sese uygun hâle getir (altyazı için) ----------
  const speakable = (t) =>
    t.replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[#*_>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const chunkText = (t) => {
    const sentences = t.match(/[^.!?…:]+[.!?…:]*\s*/g) || [t];
    const out = [];
    let cur = "";
    for (const s of sentences) {
      if ((cur + s).length > 140 && cur) { out.push(cur.trim()); cur = ""; }
      cur += s;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };

  // ---------- Arayüz ----------
  const ui = {};
  const h = (tag, attrs = {}, ...kids) => {
    const svgTags = ["svg", "g", "path", "circle", "rect", "defs", "filter", "feTurbulence", "feDisplacementMap"];
    const el = svgTags.includes(tag) ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "on") Object.entries(v).forEach(([e, f]) => el.addEventListener(e, f));
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v);
    }
    kids.flat().forEach((k) => k != null && el.append(k));
    return el;
  };

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --bg: #262624; --surface: #30302e; --surface-2: #3a3936; --line: rgba(255,255,255,.08);
  --text: #f5f4ee; --muted: #a6a39a; --accent: #d97757; --accent-soft: rgba(217,119,87,.16);
  --duration-quick: 150ms; --duration-fast: 250ms; --duration-medium: 350ms; --duration-slow: 400ms; --duration-very-slow: 500ms;
  --ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1); --ease-bounce: cubic-bezier(0.34, 1.36, 0.64, 1);
  --serif: "Tiempos Text", "Copernicus", ui-serif, Georgia, "Times New Roman", serif;
  --sans: "Styrene B", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-family: var(--sans); color: var(--text);
}
@media (prefers-color-scheme: light) {
  .root { --bg: #faf9f5; --surface: #f0eee6; --surface-2: #e8e6dc; --line: rgba(0,0,0,.08); --text: #1f1e1d; --muted: #73716a; --accent-soft: rgba(217,119,87,.14); }
}
.stage {
  position: fixed; inset: 0; z-index: 2147483000;
  display: grid; grid-template-rows: auto 1fr auto auto; justify-items: center;
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  padding: 22px 24px 28px;
  opacity: 0; transform: scale(var(--open-scale, .98)); pointer-events: none; visibility: hidden;
  transition: opacity var(--duration-quick) ease-out, transform var(--duration-quick) var(--ease-smooth-out), visibility 0s linear var(--duration-quick);
}
.stage.open { opacity: 1; transform: none; pointer-events: auto; visibility: visible;
  transition: opacity var(--duration-fast) ease-out, transform var(--duration-fast) var(--ease-smooth-out), visibility 0s; }
.stage:not(.open) { backdrop-filter: none; -webkit-backdrop-filter: none; }
.top { width: 100%; max-width: 980px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.title { font: 500 15px/1.2 var(--sans); color: var(--muted); letter-spacing: .01em; display: flex; align-items: center; gap: 8px; min-width: 0; }
.title b { color: var(--text); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 52vw; }
.pills { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.pill { font: 500 12px/1 var(--sans); padding: 7px 10px; border-radius: 999px; background: var(--surface); color: var(--muted); border: 1px solid var(--line); cursor: pointer; }
.pill.on { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.center { display: grid; place-items: center; align-content: center; gap: 26px; width: 100%; }
.orbWrap { position: relative; width: min(46vmin, 300px); aspect-ratio: 1; display: grid; place-items: center; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.halo { position: absolute; inset: -18%; border-radius: 50%;
  background: radial-gradient(circle, rgba(217,119,87,.30) 0%, rgba(217,119,87,.10) 38%, transparent 66%);
  opacity: .35; transform: scale(.9); transition: opacity var(--duration-medium) ease-out; }
.orb { width: 100%; height: 100%; overflow: visible; }
.status { font: 500 17px/1.2 var(--sans); letter-spacing: .01em; color: var(--muted); min-height: 22px; text-align: center; }
.status.shimmer {
  background: linear-gradient(90deg, var(--muted) 0%, var(--muted) 40%, var(--text) 50%, var(--muted) 60%, var(--muted) 100%);
  background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: shimmer 1.8s linear infinite; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.subs { width: 100%; max-width: 900px; min-height: 132px; display: grid; align-items: end; justify-items: center; padding: 0 8px 18px; }
.line { font: 400 clamp(20px, 2.6vw, 28px)/1.45 var(--serif); text-align: center; color: var(--text); text-wrap: balance;
  transition: opacity var(--duration-very-slow) ease-in-out, filter var(--duration-very-slow) ease-in-out, transform var(--duration-very-slow) ease-in-out; }
.line.you { color: var(--muted); font-style: italic; }
.line.enter { opacity: 0; filter: blur(3px); transform: translateY(12px); }
.line.leave { opacity: 0; transition-duration: var(--duration-quick); }
.controls { display: flex; gap: 14px; align-items: center; }
.btn { width: 58px; height: 58px; border-radius: 50%; border: 1px solid var(--line); background: var(--surface); color: var(--text);
  display: grid; place-items: center; cursor: pointer; -webkit-tap-highlight-color: transparent;
  transition: background var(--duration-quick) ease-out, transform var(--duration-quick) var(--ease-smooth-out); }
.btn:hover { background: var(--surface-2); }
.btn:active { transform: scale(.94); }
.btn.primary { width: 72px; height: 72px; background: var(--accent); color: #fff; border-color: transparent; }
.btn svg { width: 24px; height: 24px; }
.card { position: fixed; left: 50%; bottom: 120px; transform: translate(-50%, 16px); opacity: 0; pointer-events: none; visibility: hidden;
  width: min(560px, calc(100vw - 32px)); background: var(--surface); border: 1px solid var(--line); border-radius: 20px; padding: 18px 18px 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,.35);
  transition: opacity var(--duration-medium) ease-out, transform var(--duration-medium) var(--ease-smooth-out); }
.card.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; visibility: visible; transition-duration: var(--duration-slow); }
.card h3 { margin: 0 0 6px; font: 600 15px/1.3 var(--sans); color: var(--accent); }
.card p { margin: 0 0 14px; font: 400 15px/1.45 var(--sans); color: var(--text); max-height: 6.5em; overflow: auto; }
.card .row { display: flex; gap: 10px; justify-content: flex-end; }
.card button { font: 500 15px/1 var(--sans); padding: 12px 18px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface-2); color: var(--text); cursor: pointer; }
.card button.ok { background: var(--accent); color: #fff; border-color: transparent; }
.fab { position: fixed; right: 18px; bottom: 132px; z-index: 2147482999; width: 56px; height: 56px; border-radius: 50%;
  border: 1px solid var(--line); background: var(--bg); box-shadow: 0 10px 30px rgba(0,0,0,.35); display: grid; place-items: center; cursor: pointer;
  transition: transform var(--duration-fast) var(--ease-bounce), opacity var(--duration-quick) ease-out; }
.fab:active { transform: scale(.92); }
.fab.hidden { opacity: 0; transform: scale(.6); pointer-events: none; }
.fab svg { width: 30px; height: 30px; }
.toast { position: fixed; left: 50%; top: 18px; transform: translate(-50%, -8px); opacity: 0; z-index: 2147483001;
  background: var(--surface); color: var(--text); border: 1px solid var(--line); padding: 10px 14px; border-radius: 12px; font: 500 14px/1.3 var(--sans);
  transition: opacity var(--duration-medium) ease-out, transform var(--duration-medium) var(--ease-smooth-out); pointer-events: none; }
.toast.show { opacity: 1; transform: translate(-50%, 0); transition-duration: var(--duration-slow); }
@media (prefers-reduced-motion: reduce) {
  .stage, .line, .card, .fab, .toast, .btn { transition-duration: 1ms !important; }
  .status.shimmer { animation: none; color: var(--muted); }
}
`;

  // Claude Spark — claude.ai'deki data-cds="Spark" SVG yolunun birebir aynısı.
  const SPARK_D = "m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z";
  const CLAY = "#d97757";

  // Sesli moddaki logo: tek parça Spark. Büyüme = ölçek, titreme = dalgalanma (displacement) filtresi.
  const buildOrb = () => {
    const svg = h("svg", { class: "orb", viewBox: "-14 -14 128 128", "aria-hidden": "true" });
    const turb = h("feTurbulence", { type: "fractalNoise", baseFrequency: "0.045", numOctaves: "2", seed: "3", result: "n" });
    const disp = h("feDisplacementMap", { in: "SourceGraphic", in2: "n", scale: "0", xChannelSelector: "R", yChannelSelector: "G" });
    const filter = h("filter", { id: "cs-wobble", x: "-20%", y: "-20%", width: "140%", height: "140%" }, turb, disp);
    svg.append(h("defs", {}, filter));
    const g = h("g", { filter: "url(#cs-wobble)" }, h("path", { d: SPARK_D, fill: CLAY }));
    svg.append(g);
    return { svg, g, turb, disp };
  };

  const ICON = {
    close: () => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }, h("path", { d: "M6 6l12 12M18 6L6 18" })),
    pause: () => h("svg", { viewBox: "0 0 24 24", fill: "currentColor" }, h("rect", { x: "6", y: "5", width: "4", height: "14", rx: "1.5" }), h("rect", { x: "14", y: "5", width: "4", height: "14", rx: "1.5" })),
    mic: () => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }, h("rect", { x: "9", y: "3", width: "6", height: "12", rx: "3" }), h("path", { d: "M5 11a7 7 0 0 0 14 0M12 18v3" })),
    page: () => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }, h("rect", { x: "4", y: "4", width: "16", height: "16", rx: "3" }), h("path", { d: "M8 9h8M8 13h8M8 17h5" })),
    spark: () => h("svg", { viewBox: "0 0 100 100" }, h("path", { d: SPARK_D, fill: CLAY })),
  };

  const mount = () => {
    if (ui.host && ui.host.isConnected) return;
    const host = document.createElement("claude-ses");
    const shadow = host.attachShadow({ mode: "open" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) { log("stil yüklenemedi", e); }

    const root = h("div", { class: "root" });
    const orb = buildOrb();
    ui.orb = orb;
    ui.halo = h("div", { class: "halo" });
    ui.status = h("div", { class: "status", text: "" });
    ui.subs = h("div", { class: "subs", "aria-live": "polite" });
    ui.sessionName = h("b", { text: "" });
    ui.autoPill = h("button", { class: "pill", on: { click: () => { CFG.autoListen = !CFG.autoListen; saveCfg(); renderPill(); } } });
    ui.narratePill = h("button", { class: "pill", on: { click: () => { CFG.narrate = !CFG.narrate; saveCfg(); renderPill(); } } });
    ui.enginePill = h("button", { class: "pill", on: { click: () => { CFG.dictEngine = CFG.dictEngine === "whisper" ? "claude" : "whisper"; saveCfg(); if (CFG.dictEngine === "whisper") whisperSetup(); renderPill(); } } });
    ui.screenPill = h("button", { class: "pill", on: { click: () => screen.toggle() } });
    ui.wakePill = h("button", { class: "pill", on: { click: () => { CFG.wakeWord = !CFG.wakeWord; saveCfg(); if (!CFG.wakeWord) wake.stop(); renderPill(); } } });
    ui.mainBtn = h("button", { class: "btn primary", "aria-label": "Dinle / durdur", on: { click: () => machine.toggle() } }, ICON.mic());

    ui.stage = h("div", { class: "stage", role: "dialog", "aria-label": "Claude sesli mod" },
      h("div", { class: "top" },
        h("div", { class: "title" }, h("span", { text: "Claude" }), h("span", { text: "·" }), ui.sessionName),
        h("div", { class: "pills" }, ui.wakePill, ui.screenPill, ui.narratePill, ui.autoPill)),
      h("div", { class: "center" },
        h("div", { class: "orbWrap", on: { click: () => machine.toggle() } }, ui.halo, orb.svg),
        ui.status),
      ui.subs,
      h("div", { class: "controls" },
        h("button", { class: "btn", "aria-label": "Sayfayı göster", on: { click: () => hideStage() } }, ICON.page()),
        ui.mainBtn,
        h("button", { class: "btn", "aria-label": "Sesli modu kapat", on: { click: () => { machine.stop(); hideStage(); } } }, ICON.close()))
    );

    ui.cardTitle = h("h3", { text: "İzin gerekiyor" });
    ui.cardText = h("p", { text: "" });
    ui.cardOk = h("button", { class: "ok", text: "İzin ver", on: { click: () => machine.answerPermission(true) } });
    ui.cardNo = h("button", { text: "Reddet", on: { click: () => machine.answerPermission(false) } });
    ui.card = h("div", { class: "card", role: "alertdialog" }, ui.cardTitle, ui.cardText, h("div", { class: "row" }, ui.cardNo, ui.cardOk));

    ui.fab = h("button", { class: "fab", "aria-label": "Sesli modu aç", on: { click: () => showStage(true) } }, ICON.spark());
    ui.toast = h("div", { class: "toast", role: "status" });

    root.append(ui.stage, ui.card, ui.fab, ui.toast);
    shadow.append(root);
    (document.body || document.documentElement).append(host);
    ui.host = host;
    renderPill();
    setStatus("idle");
    startLoop();
  };

  const renderPill = () => {
    if (!ui.autoPill) return;
    ui.autoPill.textContent = CFG.autoListen ? "Eller serbest: açık" : "Eller serbest: kapalı";
    ui.autoPill.classList.toggle("on", CFG.autoListen);
    ui.narratePill.textContent = CFG.narrate ? "Ara mesajları oku: açık" : "Ara mesajları oku: kapalı";
    ui.narratePill.classList.toggle("on", CFG.narrate);
    ui.enginePill.textContent = CFG.dictEngine === "whisper" ? (whisperOk ? "Dikte: Whisper" : "Dikte: Whisper (Mac bekleniyor)") : "Dikte: Claude";
    ui.enginePill.classList.toggle("on", CFG.dictEngine === "whisper" && whisperOk);
    ui.wakePill.textContent = CFG.wakeWord ? "Dinleme: “Hey Claude” ile" : "Dinleme: her şeyi";
    ui.wakePill.classList.toggle("on", true);
    if (machine.state === "idle") setStatus("idle");
    const sOn = screen.on();
    ui.screenPill.textContent = sOn ? "Ekranı görüyor" : "Ekranı göster";
    ui.screenPill.classList.toggle("on", sOn);
  };

  // Ekran: uygulama saniyede bir kare yakalar; gönderirken son 5 kare mesaja eklenir.
  const screen = {
    on() { try { return !!(window.ClaudeSesNative && ClaudeSesNative.isScreenSharing && ClaudeSesNative.isScreenSharing()); } catch (_) { return false; } },
    toggle() {
      const n = window.ClaudeSesNative;
      if (!n || !n.startScreenShare) { toast("Bu sürümde ekran paylaşımı yok."); return; }
      if (screen.on()) { n.stopScreenShare(); setTimeout(renderPill, 300); toast("Ekran paylaşımı kapandı."); }
      else n.startScreenShare();
    },
    // Son kareleri dosya girişine ekle. Eklendiyse true.
    async attach() {
      if (!screen.on()) return false;
      let frames = [];
      try { frames = JSON.parse(ClaudeSesNative.getFrames(5)); } catch (_) { return false; }
      const input = document.querySelector("input[data-testid=file-upload]") || document.querySelector("input[type=file][multiple]") || document.querySelector("input[type=file]");
      if (!frames.length || !input) return false;
      const dt = new DataTransfer();
      const stamp = Date.now();
      frames.forEach((b64, i) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        dt.items.add(new File([bytes], `ekran-${stamp}-${i + 1}.jpg`, { type: "image/jpeg" }));
      });
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      log("ekran kareleri eklendi", frames.length);
      await sleep(1500);
      return true;
    },
  };
  CS.screen = screen;
  CS.onNativeExtra = (type, data) => {
    if (type === "screen-on") { toast("Claude artık son 5 saniyeyi görecek."); setTimeout(renderPill, 500); }
    else if (type === "screen-denied") toast("Ekran izni verilmedi.");
    else if (type === "screen-error") toast("Ekran paylaşımı başlamadı: " + data);
  };

  let toastTimer = 0;
  const toast = (msg, ms = 2600) => {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), ms);
  };

  const showStage = (startListening) => {
    mount();
    ensureCtx();
    ui.stage.classList.add("open");
    ui.fab.classList.add("hidden");
    ui.sessionName.textContent = (document.title || "").replace(/\s*[-–|]\s*Claude.*$/i, "") || "Oturum";
    kb.suppress(true);
    kb.hideSoon();
    if (startListening && machine.state === "idle" && !helper.ok) machine.listen();
  };
  const hideStage = () => {
    if (!ui.stage) return;
    ui.stage.classList.remove("open");
    ui.fab.classList.remove("hidden");
    kb.suppress(false);
  };

  // Altyazı: satırı bulanık yükselişle değiştir.
  let currentLine = null;
  const setSub = (text, who = "claude") => {
    if (!ui.subs) return;
    if (currentLine && currentLine.textContent === text) return;
    const old = currentLine;
    if (old) {
      old.classList.add("leave");
      setTimeout(() => old.remove(), 160);
    }
    if (!text) { currentLine = null; return; }
    const line = h("div", { class: `line enter ${who === "you" ? "you" : ""}`, text });
    line.style.gridArea = "1 / 1";
    ui.subs.style.display = "grid";
    ui.subs.append(line);
    currentLine = line;
    void line.offsetWidth;
    requestAnimationFrame(() => line.classList.remove("enter"));
  };

  const STATUS = {
    idle: ["Konuşmak için dokun", false],
    listening: ["Dinliyorum…", false],
    sending: ["Gönderiliyor…", true],
    thinking: ["Çalışıyor… konuşmak için dokun", true],
    speaking: ["", false],
    permission: ["İzin bekliyor", true],
    nosession: ["Önce bir oturum aç", false],
  };
  const setStatus = (s) => {
    if (!ui.status) return;
    let [txt, shimmer] = STATUS[s] || ["", false];
    if (helper.ok && CFG.autoListen && (s === "idle" || s === "thinking")) {
      const hint = CFG.wakeWord ? "“Hey Claude” de" : "konuşabilirsin";
      txt = s === "idle" ? (CFG.wakeWord ? "“Hey Claude” de ya da dokun" : "Dinliyorum, konuşabilirsin") : "Çalışıyor… " + hint;
    }
    ui.status.textContent = txt;
    ui.status.classList.toggle("shimmer", shimmer);
    if (ui.mainBtn) {
      ui.mainBtn.replaceChildren(s === "listening" || s === "speaking" ? ICON.pause() : ICON.mic());
    }
  };

  // ---------- Animasyon döngüsü ----------
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let smooth = 0, rot = 0, lastT = performance.now();
  const startLoop = () => {
    // Durum makinesi ayrı zamanlayıcıda: requestAnimationFrame pencere arkadayken duruyor.
    if (!CS.tickTimer) CS.tickTimer = setInterval(() => { readLevels(); const now = performance.now(); machine.tick(now); wake.tick(now); }, 50);
    const frame = (t) => {
      const dt = Math.min(64, t - lastT) / 1000;
      lastT = t;
      const st = machine.state;
      let target = 0;
      if (st === "listening") target = Math.min(1, Math.max(levels.mic, helper.level) * 9);
      else if (st === "speaking") target = Math.min(1, (levels.out || (levels.outActive ? 0.06 + 0.05 * Math.sin(t / 90) : 0)) * 8);
      smooth += (target - smooth) * Math.min(1, dt * (target > smooth ? 18 : 6));
      if (ui.orb && !reduced) {
        const breathing = 0.03 * Math.sin(t / 900);
        let scale = 1 + breathing;
        if (st === "listening") scale = 1 + smooth * 0.28;
        if (st === "speaking") scale = 1 + smooth * 0.18;
        if (st === "thinking" || st === "sending") rot += dt * 70;
        else if (st === "speaking") rot += dt * 8;
        else rot += dt * 4;
        if (st === "thinking" || st === "sending") scale = 0.94 + 0.05 * Math.sin(t / 260);
        ui.orb.g.setAttribute("transform", `translate(50 50) rotate(${rot.toFixed(2)}) scale(${scale.toFixed(3)}) translate(-50 -50)`);
        // Titreme: konuşurken güçlü, dinlerken hafif; boşta kapalı.
        let wobble = 0;
        if (st === "speaking") wobble = 1.2 + smooth * 7;
        else if (st === "listening") wobble = smooth * 4;
        ui.orb.disp.setAttribute("scale", wobble.toFixed(2));
        if (wobble > 0.05) {
          ui.orb.turb.setAttribute("baseFrequency", (0.035 + 0.015 * Math.sin(t / 180)).toFixed(4));
          ui.orb.turb.setAttribute("seed", String(Math.floor(t / 70) % 97));
        }
        ui.halo.style.opacity = String(0.25 + smooth * 0.75);
        ui.halo.style.transform = `scale(${(0.9 + smooth * 0.3).toFixed(3)})`;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  // ---------- Claude'un kendi sesi (Read aloud ile aynı TTS kanalı) ----------
  // Read aloud düğmesi yalnızca tur bitince çıkıyor; aynı WebSocket'i doğrudan kullanınca ara mesajlar da okunur.
  // Claude web 16 kHz istiyor; kanal 44,1 kHz de veriyor (çok daha net).
  const TTS_RATE = 44100;
  const ttsParams = { voice: "tr-parlak", speed: "1.20", language: "tr" };
  try {
    const NativeWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      try {
        const u = new URL(url, location.href);
        if (u.pathname.includes("/text_to_speech/")) {
          ["voice", "language"].forEach((k) => { if (u.searchParams.get(k)) ttsParams[k] = u.searchParams.get(k); });
          if (u.searchParams.get("tts_speed")) ttsParams.speed = u.searchParams.get("tts_speed");
        }
      } catch (_) {}
      return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    };
    window.WebSocket.prototype = NativeWS.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  } catch (_) {}

  const tts = {
    gen: 0, ws: null, ctx: null, sources: [], marks: [], firstAt: 0, endAt: 0,
    done: true, failed: false, active: false, gotAudio: false, leftover: null,
    url() {
      const org = (document.cookie.match(/lastActiveOrg=([^;]+)/) || [])[1] || "";
      const q = new URLSearchParams({ output_format: "pcm_" + TTS_RATE, voice: ttsParams.voice, tts_speed: ttsParams.speed,
        client_platform: "web_claude_ai", language: ttsParams.language, organization_uuid: org });
      return `wss://${location.host}/api/ws/text_to_speech/text_stream?${q}`;
    },
    speak(text) {
      this.stop();
      const gen = ++this.gen;
      if (!this.ctx) this.ctx = new AudioContext();
      try { this.ctx.resume(); } catch (_) {}
      Object.assign(this, { active: true, done: false, failed: false, gotAudio: false, leftover: null, marks: [], sources: [], firstAt: 0 });
      this.endAt = this.ctx.currentTime + 0.08;
      let ws;
      try { ws = new WebSocket(this.url()); } catch (e) { this.failed = true; this.done = true; return; }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        if (gen !== this.gen) return;
        ws.send(JSON.stringify({ type: "text_chunk", text }));
        ws.send(JSON.stringify({ type: "close_stream" }));
      };
      ws.onmessage = (e) => {
        if (gen !== this.gen) return;
        if (typeof e.data === "string") {
          try { if (/SpeechComplete/.test(e.data)) this.done = true; } catch (_) {}
          return;
        }
        this.play(e.data);
      };
      ws.onerror = () => { if (gen === this.gen) { this.failed = !this.gotAudio; this.done = true; } };
      ws.onclose = () => { if (gen === this.gen) this.done = true; };
    },
    play(buf) {
      let bytes = new Uint8Array(buf);
      if (this.leftover) { const m = new Uint8Array(bytes.length + 1); m[0] = this.leftover; m.set(bytes, 1); bytes = m; this.leftover = null; }
      if (bytes.length % 2) { this.leftover = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
      const n = bytes.length / 2;
      if (!n) return;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const ab = this.ctx.createBuffer(1, n, TTS_RATE);
      const ch = ab.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < n; i++) { const v = dv.getInt16(i * 2, true) / 32768; ch[i] = v; sum += v * v; }
      const src = this.ctx.createBufferSource();
      src.buffer = ab;
      src.connect(this.ctx.destination);
      const at = Math.max(this.endAt, this.ctx.currentTime + 0.03);
      src.start(at);
      if (!this.firstAt) this.firstAt = at;
      this.endAt = at + ab.duration;
      this.marks.push([at, this.endAt, Math.sqrt(sum / n)]);
      this.sources.push(src);
      this.gotAudio = true;
    },
    level() {
      if (!this.ctx) return 0;
      const t = this.ctx.currentTime;
      const m = this.marks.find((x) => t >= x[0] && t < x[1]);
      return m ? m[2] : 0;
    },
    playing() { return this.active && (!this.done || (this.ctx && this.ctx.currentTime < this.endAt)); },
    // Oynatılan oran (0-1); tüm ses gelmeden yaklaşık.
    progress(textLen) {
      if (!this.firstAt || !this.ctx) return 0;
      const played = Math.max(0, this.ctx.currentTime - this.firstAt);
      const total = this.done ? this.endAt - this.firstAt : Math.max(this.endAt - this.firstAt, textLen / 16);
      return total > 0 ? Math.min(1, played / total) : 0;
    },
    stop() {
      this.gen++;
      this.active = false;
      try { if (this.ws && this.ws.readyState <= 1) this.ws.close(); } catch (_) {}
      this.ws = null;
      this.sources.forEach((s) => { try { s.stop(); } catch (_) {} });
      this.sources = [];
    },
  };
  CS.tts = tts;

  // Dikte metnini ana oturumun yazı kutusuna yaz (klavye açılmadan).
  const insertIntoComposer = (text) => {
    const c = page.composer();
    if (!c) return false;
    kb.suppress(true);
    const before = page.composerText();
    c.focus();
    if (c.tagName === "TEXTAREA") {
      const v = c.value ? c.value.replace(/\s*$/, " ") + text : text;
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      set.call(c, v);
      c.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const sel = getSelection();
      sel.selectAllChildren(c);
      sel.collapseToEnd();
      document.execCommand("insertText", false, (before ? " " : "") + text);
      if (page.composerText() === before) {
        c.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
      }
    }
    kb.hideSoon();
    return page.composerText() !== before;
  };

  const returnToIsDone = (m) => !page.busy();

  // "Hey Claude" (dikte sık sık "hey cloud", "hey klod" vb. yazıyor).
  const WAKE_RE = /\b(?:hey|hei|hay|ey|hi|selam)[\s,.!-]*(?:claude|cloud|claud|clod|klod|klot|kloud|clawed|clode|klaud)\b[\s,.!:;-]*/i;
  const stripWake = (text) => {
    const m = text.match(WAKE_RE);
    return m ? text.slice(m.index + m[0].length).trim() : text;
  };
  const wake = {
    on: false, restartAt: 0, lastText: "", changedAt: 0,
    stop() { if (this.on) helper.cancel(); this.on = false; },
    tick(t) {
      const st = machine.state;
      const allowed = CFG.autoListen && helper.ok && voiceOpen() && page.onSessionPage() && (st === "idle" || st === "thinking");
      if (!allowed) { if (this.on && st !== "listening" && st !== "sending") this.stop(); else if (st === "listening" || st === "sending") this.on = false; return; }
      if (!this.on) {
        if (t < this.restartAt) return;
        this.on = true; this.lastText = ""; this.changedAt = t;
        helper.start();
        return;
      }
      const txt = helper.partial || "";
      if (txt !== this.lastText) { this.lastText = txt; this.changedAt = t; }
      // "Hey Claude" modu: yalnızca uyandırma ifadesiyle; "Her şeyi" modu: konuşma başlar başlamaz.
      if (CFG.wakeWord ? WAKE_RE.test(txt) : txt.trim().length > 0) {
        this.on = false; log(CFG.wakeWord ? "Hey Claude duyuldu" : "konuşma duyuldu"); machine.wakeListen(t); return;
      }
      // Uyandırma ifadesi olmadan biriken konuşmayı at, temiz başla (odadaki/oyundaki konuşmalar gitmesin).
      if ((txt && t - this.changedAt > 2500) || txt.length > 240 || (helper.err && t - this.changedAt > 3000)) {
        helper.cancel(); this.on = false; this.restartAt = t + 900;
      }
    },
  };
  CS.wake = wake;

  // ---------- Durum makinesi ----------
  const machine = {
    state: "idle",
    speechStart: 0,
    lastVoice: 0,
    heardSpeech: false,
    baselineText: "",
    lastComposer: "",
    composerChangedAt: 0,
    sentAt: 0,
    sawBusy: false,
    idleSince: 0,
    readSet: new Set(),
    speakText: "",
    speakChunks: [],
    speakStart: 0,
    speakBtn: null,
    noAudioDeadline: 0,
    permission: null,

    set(s) {
      if (this.state === s) return;
      log("durum", this.state, "→", s);
      this.state = s;
      setStatus(s);
    },

    toggle() {
      if (this.state === "idle" || this.state === "nosession") this.listen();
      else if (this.state === "listening") this.cancelListening();
      else if (this.state === "speaking") this.stopSpeaking(true);
      // Claude çalışırken dokununca da dinle: mesaj sıraya girer, Claude işini bitirince okur.
      else if (this.state === "thinking") this.listen(true);
    },

    stop() {
      if (this.state === "listening") this.cancelListening();
      if (this.state === "speaking") this.stopSpeaking(false);
      this.set("idle");
    },

    async listen(whileBusy = false) {
      if (!page.onSessionPage()) { this.set("nosession"); toast("Sesli mod için bir Claude oturumu aç."); hideStage(); return; }
      // Kendiliğinden (eller serbest) dinleme Claude çalışırken başlamaz; odadaki konuşmalar gitmesin.
      if (page.busy() && !whileBusy) { this.sawBusy = true; this.set("thinking"); return; }
      wake.on = false;
      this.busyListen = page.busy();
      this.heardSpeech = false;
      this.speechStart = 0;
      this.lastVoice = 0;
      if (useWhisper()) {
        native.wMode("listen");
        this.beginListeningUi();
        return;
      }
      if (helper.ok) {
        // Dikte görünmez yardımcı sayfada yapılır: Remote Control oturumlarında da çalışır,
        // yazı kutusuna dokunmadığı için klavye açılmaz ve Claude çalışırken de konuşulabilir.
        this.lastComposer = "";
        this.composerChangedAt = performance.now();
        this.set("listening");
        setSub("", "you");
        helper.start();
        return;
      }
      const btn = page.dictateBtn();
      if (!btn) { toast("Dikte düğmesi bulunamadı."); this.set("idle"); return; }
      this.baselineText = page.composerText();
      this.lastComposer = this.baselineText;
      this.composerChangedAt = performance.now();
      this.heardSpeech = false;
      this.speechStart = 0;
      this.lastVoice = 0;
      this.set("listening");
      setSub("", "you");
      if (!page.dictating()) click(btn);
      // Dikte başlamazsa haber ver.
      await sleep(2500);
      if (this.state === "listening" && !page.dictating() && !levels.micActive) toast("Dikte başlamadı; mikrofon iznini kontrol et.");
    },

    // Bekleme dinlemesinde "Hey Claude" duyuldu: aynı dikte sürüyor, buradan normal dinlemeye geç.
    wakeListen(t) {
      this.busyListen = page.busy();
      this.heardSpeech = !!stripWake(helper.partial || "");
      this.speechStart = 0;
      this.lastVoice = t;
      this.lastComposer = helper.partial || "";
      this.composerChangedAt = t;
      this.set("listening");
      const rest = stripWake(helper.partial || "");
      setSub(rest || "Dinliyorum…", "you");
      try { ensureCtx(); } catch (_) {}
    },

    beginListeningUi() {
      this.lastComposer = "";
      helper.partial = "";
      this.composerChangedAt = performance.now();
      this.set("listening");
      setSub("", "you");
    },

    cancelListening() {
      if (native && native.wMode) native.wMode("off");
      if (useWhisper()) { /* yerel mikrofon kapandı */ }
      else if (helper.ok) helper.cancel();
      else if (page.dictating()) click(page.dictateBtn());
      setSub("");
      if (page.busy()) { this.sawBusy = true; this.idleSince = 0; this.set("thinking"); }
      else this.set("idle");
    },

    async finishListening() {
      this.set("sending");
      if (useWhisper()) return; // yerel mikrofon sessizliği kendi algılıyor, w-final gelecek
      if (helper.ok) return this.finishWithHelper();
      if (page.dictating()) click(page.dictateBtn());
      // Dikte metninin oturmasını bekle.
      const t0 = performance.now();
      let last = page.composerText(), stableSince = performance.now();
      while (performance.now() - t0 < 4000) {
        await sleep(120);
        const cur = page.composerText();
        if (cur !== last) { last = cur; stableSince = performance.now(); }
        if (performance.now() - stableSince > CFG.composerSettleMs) break;
      }
      const text = page.composerText();
      if (!text || text === this.baselineText) {
        setSub("");
        if (page.busy()) { this.sawBusy = true; this.set("thinking"); } else this.listen();
        return;
      }
      setSub(text, "you");
      // Claude çalışırken gönderilen mesaj sıraya girer; o ana kadarki yanıtlar okunmuş sayılmasın diye
      // okunmuş kümesini yalnızca boşta gönderirken sıfırla.
      if (!page.busy()) this.readSet = new Set(page.readAloudBtns());
      const send = page.sendBtn();
      if (!send) { toast("Gönder düğmesi bulunamadı."); this.set("idle"); return; }
      click(send);
      this.sentAt = performance.now();
      this.sawBusy = false;
      this.idleSince = 0;
      this.set("thinking");
    },

    async finishWithHelper() {
      const text = ((await helper.stop()) || "").trim();
      return this.finishWithText(text);
    },

    async finishWithText(text) {
      if (this.state !== "sending") return;
      if (CFG.wakeWord) text = stripWake(text);
      if (!text) {
        setSub("");
        if (page.busy()) { this.sawBusy = true; this.set("thinking"); }
        else if (helper.ok && CFG.autoListen) this.set("idle");
        else this.listen();
        return;
      }
      setSub(text, "you");
      const withScreen = await screen.attach();
      // Claude, mesajın VR'dan sesle geldiğini bilsin (AGENTS.md'de bu işarete göre sesli cevap kuralı var).
      const tag = "\n\n— Quest'ten sesli" + (withScreen ? " · ekli görseller: gözlükteki ekranın son 5 saniyesi" : "");
      if (!insertIntoComposer(text + tag)) { toast("Yazı kutusuna yazılamadı."); this.set("idle"); return; }
      let send = null;
      for (let i = 0; i < 15 && !(send = page.sendBtn()); i++) await sleep(100);
      if (!send) { toast("Gönder düğmesi bulunamadı."); this.set("idle"); return; }
      this.turnBefore = page.lastTurnText();
      this.spoken = "";
      this.narrStable = { text: "", since: 0 };
      if (!page.busy()) this.readSet = new Set(page.readAloudBtns());
      click(send);
      this.sentAt = performance.now();
      this.sawBusy = false;
      this.idleSince = 0;
      this.set("thinking");
    },

    // Bu turda henüz okunmamış metin.
    unspokenText() {
      const turn = page.lastTurnText(0) || (returnToIsDone(this) ? page.lastTurnText(1) : "");
      if (!turn) return "";
      if (this.spoken && turn.startsWith(this.spoken)) return turn.slice(this.spoken.length).trim();
      return this.spoken === turn ? "" : turn;
    },

    speakWithTts(text, returnTo) {
      this.returnTo = returnTo;
      this.spoken = page.lastTurnText(0) || this.spoken;
      this.speakText = speakable(text);
      this.speakChunks = chunkText(this.speakText);
      this.useTts = true;
      this.set("speaking");
      this.speakStart = performance.now();
      this.audioStarted = false;
      this.noAudioDeadline = performance.now() + 6000;
      if (this.speakChunks[0]) setSub(this.speakChunks[0]);
      tts.speak(this.speakText);
      if (CFG.bargeIn && native && native.wMode) setTimeout(() => { if (this.state === "speaking") native.wMode("watch"); }, 600);
    },

    async speakLatest(returnTo = null) {
      if (!this.ttsBroken) {
        const text = this.unspokenText();
        if (!text) { this.returnTo = returnTo; this.afterSpeaking(); return; }
        this.speakWithTts(text, returnTo);
        return;
      }
      this.useTts = false;
      this.returnTo = returnTo;
      const btns = page.readAloudBtns();
      const fresh = btns.filter((b) => !this.readSet.has(b));
      const btn = (fresh.length ? fresh : btns)[ (fresh.length ? fresh : btns).length - 1 ];
      if (!btn) { log("okuma düğmesi yok"); this.afterSpeaking(); return; }
      this.readSet = new Set(btns);
      this.speakText = speakable(page.readableText());
      this.speakChunks = chunkText(this.speakText);
      this.speakBtn = btn;
      this.set("speaking");
      this.speakStart = performance.now();
      this.audioStarted = false;
      this.noAudioDeadline = performance.now() + 5000;
      if (this.speakChunks[0]) setSub(this.speakChunks[0]);
      click(btn);
      if (CFG.bargeIn && native && native.wMode) setTimeout(() => { if (this.state === "speaking") native.wMode("watch"); }, 600);
    },

    stopSpeaking(thenListen, keepMic = false) {
      if (!keepMic && native && native.wMode) native.wMode("off");
      if (this.useTts) tts.stop();
      // "Read aloud" düğmesi okuma sırasında durdurma işlevi görüyor varsayımı; ayrıca çalan sesi durdur.
      const pause = this.useTts ? null : page.pauseBtn();
      if (pause) click(pause);
      else if (!this.useTts && levels.outEl && !levels.outEl.paused) { try { levels.outEl.pause(); } catch (_) {} }
      setSub("");
      this.set("idle");
      if (thenListen) this.listen();
    },

    afterSpeaking() {
      setSub("");
      if (native && native.wMode) native.wMode("off");
      // Ara mesajı okuduysak ve Claude hâlâ çalışıyorsa beklemeye dön; bitince son yanıtı okuruz.
      if (this.returnTo === "thinking") {
        this.returnTo = null;
        this.sawBusy = true;
        this.idleSince = 0;
        this.set("thinking");
        return;
      }
      this.set("idle");
      // Eller serbest: arka plan dinlemesi (wake.tick) devralır; yardımcı yoksa eski yol.
      if (CFG.autoListen && !helper.ok && ui.stage && ui.stage.classList.contains("open")) setTimeout(() => this.listen(), 450);
    },

    answerPermission(ok) {
      const p = this.permission;
      ui.card.classList.remove("show");
      this.permission = null;
      if (p) click(ok ? p.allow : p.deny || p.allow);
      this.set("thinking");
    },

    tick(t) {
      // İzin kartı (her durumda kontrol et).
      if (this.state === "thinking" || this.state === "permission") {
        const p = page.permissionButtons();
        if (p && !this.permission) {
          this.permission = p;
          ui.cardText.textContent = p.text || "Claude bir işlem için izin istiyor.";
          ui.cardNo.style.display = p.deny ? "" : "none";
          ui.card.classList.add("show");
          this.set("permission");
          if (!appFocused()) notifyUser("Claude izin istiyor", p.text || "Onay bekliyor.");
          if (ui.stage && !ui.stage.classList.contains("open")) showStage(false);
        } else if (!p && this.permission) {
          this.permission = null;
          ui.card.classList.remove("show");
          this.set("thinking");
        }
      }

      if (this.state === "listening" && useWhisper()) {
        // whisper: yerel mikrofon sessizliği algılar; burada yalnızca logo seviyesi kullanılır.
      } else if (this.state === "listening" && helper.ok) {
        const loud = helper.level > 0.015;
        if (helper.level > 0.0005) this.levelWorks = true;
        if (loud) {
          if (!this.speechStart) this.speechStart = t;
          this.lastVoice = t;
        }
        const raw = helper.partial;
        const cur = CFG.wakeWord ? stripWake(raw) : raw;
        if (raw !== this.lastComposer) {
          this.lastComposer = raw;
          this.composerChangedAt = t;
          if (cur) { setSub(cur.length > 160 ? "…" + cur.slice(-160) : cur, "you"); this.heardSpeech = true; }
        }
        // Claude diktesi metni gecikmeli ve parça parça getiriyor: kısa duraksamada kesmemek için
        // hem yazının hem (okunabiliyorsa) sesin bir süre durmasını bekle.
        const textQuiet = t - this.composerChangedAt;
        const voiceQuiet = t - (this.lastVoice || 0);
        const done = this.levelWorks ? textQuiet > 1500 && voiceQuiet > CFG.silenceMs : textQuiet > 2200;
        if (this.heardSpeech && cur && done) this.finishListening();
        if (!helper.started && helper.startedAt && t - helper.startedAt > 8000 && !helper.err) {
          helper.startedAt = 0; toast("Dikte başlamadı; tekrar deniyorum."); native.dict("reload");
          this.cancelListening();
        }
      } else if (this.state === "listening") {
        const loud = levels.mic > 0.02;
        if (loud) {
          if (!this.speechStart) this.speechStart = t;
          this.lastVoice = t;
          if (t - this.speechStart > CFG.minSpeechMs) this.heardSpeech = true;
        } else if (this.speechStart && t - this.lastVoice > 300 && !this.heardSpeech) {
          this.speechStart = 0;
        }
        const cur = page.composerText();
        if (cur !== this.lastComposer) {
          this.lastComposer = cur;
          this.composerChangedAt = t;
          const fresh = cur.slice(this.baselineText.length).trim() || cur;
          if (fresh) setSub(fresh.length > 160 ? "…" + fresh.slice(-160) : fresh, "you");
          this.heardSpeech = true;
        }
        const quietFor = t - Math.max(this.lastVoice, this.composerChangedAt);
        if (this.heardSpeech && quietFor > CFG.silenceMs && cur && cur !== this.baselineText) {
          this.finishListening();
        }
      }

      if (this.state === "thinking") {
        const busy = page.busy();
        if (busy) {
          this.sawBusy = true;
          this.idleSince = 0;
          // Ne yaptığını anında göster: yeni yazılan yanıt metni ya da "çalışıyor" satırı.
          if (CFG.narrate && voiceOpen() && t - (this.progressAt || 0) > 400) {
            this.progressAt = t;
            const turn = page.lastTurnText();
            const fresh = turn && turn !== this.turnBefore ? turn.split("\n").filter((l) => l.trim()).pop() : "";
            const line = fresh || page.workingLine();
            if (line && line !== this.progressLine) { this.progressLine = line; setSub(line.length > 180 ? line.slice(0, 180) + "…" : line); }
          }
          // Çalışırken anlat: yeni bir ara mesaj (Read aloud düğmeli) 1,5 sn değişmeden durursa oku.
          if (CFG.narrate && voiceOpen() && !this.ttsBroken) {
            const turn = page.lastTurnText(0);
            const st = this.narrStable || (this.narrStable = { text: "", since: 0 });
            if (turn !== st.text) { st.text = turn; st.since = t; }
            const fresh = this.unspokenText();
            // Yeni metin 1,2 sn değişmeden durduysa (paragraf bitti) oku.
            if (fresh && fresh.length > 12 && turn !== this.turnBefore && t - st.since > 1200) { this.speakWithTts(fresh, "thinking"); return; }
          }
          if (false) {
            const fresh = page.readAloudBtns().filter((b) => !this.readSet.has(b));
            if (fresh.length) {
              if (!this.freshSince) this.freshSince = t;
              if (t - this.freshSince > 1500) { this.freshSince = 0; this.speakLatest("thinking"); return; }
            } else this.freshSince = 0;
          }
        } else {
          if (!this.idleSince) this.idleSince = t;
          // Araç çağrıları arasında Stop düğmesi bir an kaybolabiliyor: "bitti" demek için Read aloud
          // düğmesinin (yalnızca tur bitince çıkar) görünmesini bekle; çok uzun sürerse yine bitir.
          const hasReadBtn = page.readAloudBtns().length > 0 && !!page.readableText();
          const idleFor = t - this.idleSince;
          const doneAfterBusy = this.sawBusy && ((idleFor > 1500 && hasReadBtn) || idleFor > 25000);
          const neverStarted = !this.sawBusy && t - this.sentAt > CFG.startTimeoutMs;
          if (doneAfterBusy || neverStarted) {
            this.progressLine = "";
            if (doneAfterBusy && !appFocused()) notifyUser("Claude bitirdi", speakable(page.readableText()) || "Yanıt hazır.");
            if (ui.stage && ui.stage.classList.contains("open")) this.speakLatest();
            else this.set("idle");
          }
        }
      }

      if (this.state === "speaking" && this.useTts) {
        levels.out = tts.level();
        if (tts.gotAudio && !this.audioStarted) { this.audioStarted = true; this.speakStart = t; }
        if (this.speakChunks.length) {
          const idx = Math.min(this.speakChunks.length - 1, Math.floor(tts.progress(this.speakText.length) * this.speakChunks.length));
          setSub(this.speakChunks[idx]);
        }
        if (this.audioStarted && !tts.playing()) { tts.active = false; levels.out = 0; this.afterSpeaking(); }
        else if (!tts.gotAudio && (tts.failed || t > this.noAudioDeadline)) {
          log("TTS kanalı çalışmadı, Read aloud düğmesine dönülüyor");
          this.ttsBroken = true; tts.stop();
          if (this.returnTo === "thinking") this.afterSpeaking(); else this.speakLatest();
        }
      } else if (this.state === "speaking") {
        if (levels.outActive || levels.out > 0.01) {
          if (!this.audioStarted) { this.audioStarted = true; this.speakStart = t; }
        }
        // Altyazı ilerlemesi: ses elemanı varsa süresinden, yoksa tahmini hızdan.
        if (this.speakChunks.length) {
          let frac = 0;
          const el = levels.outEl;
          if (el && el.duration && isFinite(el.duration) && el.duration > 0) frac = el.currentTime / el.duration;
          else frac = ((t - this.speakStart) / 1000) * CFG.charsPerSecond / Math.max(1, this.speakText.length);
          const idx = Math.min(this.speakChunks.length - 1, Math.floor(frac * this.speakChunks.length));
          setSub(this.speakChunks[idx]);
        }
        const elPlaying = levels.outEl && !levels.outEl.paused && !levels.outEl.ended;
        const ctxPlaying = t - ctxActivity.lastLoud < 900;
        if (this.audioStarted && !elPlaying && !ctxPlaying) {
          if (!this.endSince) this.endSince = t;
          if (t - this.endSince > 700) { this.endSince = 0; this.afterSpeaking(); }
        } else this.endSince = 0;
        if (!this.audioStarted && t > this.noAudioDeadline) {
          toast("Sesli okuma başlamadı.");
          this.afterSpeaking();
        }
      }
    },
  };
  CS.machine = machine;
  CS.levels = levels;
  CS.show = () => showStage(false);

  bus.on("audio-start", () => { if (machine.state === "speaking") machine.audioStarted = true; });

  // ---------- Başlat ----------
  const LAST_KEY = "claudeSes.lastSession";
  const boot = () => {
    mount();
    // Uygulama ana sayfada açıldıysa (bu oturumda ilk kez) en son kullanılan oturuma geç.
    try {
      const last = localStorage.getItem(LAST_KEY);
      const firstLoad = !sessionStorage.getItem("claudeSes.booted");
      sessionStorage.setItem("claudeSes.booted", "1");
      if (firstLoad && last && /^\/code\/?$/.test(location.pathname) && last !== location.href) {
        log("son oturuma geçiliyor", last);
        location.assign(last);
        return;
      }
    } catch (_) {}
    // Uygulama açılınca bir oturum sayfasındaysak sesli modu aç ve dinlemeye başla.
    let tries = 0;
    const waitForSession = setInterval(() => {
      tries++;
      if (page.onSessionPage()) {
        clearInterval(waitForSession);
        if (CFG.autoListen && !CS.autoOpened) { CS.autoOpened = true; showStage(true); }
      } else if (tries > 40) clearInterval(waitForSession);
    }, 500);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
  // SPA içinde gövde yeniden kurulursa arayüzü geri tak.
  setInterval(() => { if (document.body && ui.host && !ui.host.isConnected) document.body.append(ui.host); }, 2000);
  // Sesli mod düğmesi yalnızca bir oturum sayfasında görünsün (giriş ekranında değil).
  setInterval(() => {
    if (!ui.fab || !ui.stage) return;
    const open = ui.stage.classList.contains("open");
    const onSession = page.onSessionPage();
    ui.fab.classList.toggle("hidden", open || !onSession);
    if (onSession) { try { localStorage.setItem(LAST_KEY, location.origin + location.pathname); } catch (_) {} }
  }, 800);
})();
