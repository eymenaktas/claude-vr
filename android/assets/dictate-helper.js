// Claude Ses — görünmez dikte yardımcısı.
// Arka plandaki ikinci WebView'da claude.ai/code açık durur; Remote Control oturumlarında
// Dictate düğmesi olmadığı için dikte burada yapılır, metin ana sayfaya aktarılır. Burada asla gönderilmez.
(() => {
  if (window.__csHelper) return;
  const E = (t, d) => { try { ClaudeSesHelper.emit(t, typeof d === "string" ? d : JSON.stringify(d ?? "")); } catch (_) {} };
  const vis = (e) => !!e && e.getBoundingClientRect().width > 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Mikrofon seviyesi (ana sayfadaki logonun titremesi için).
  let analyser = null, buf = null, actx = null;
  const gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  if (gum) {
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c);
      try {
        if (s.getAudioTracks().length) {
          const ctx = actx = new AudioContext();
          ctx.resume().catch(() => {});
          analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          buf = new Float32Array(analyser.fftSize);
          ctx.createMediaStreamSource(s).connect(analyser);
          s.getAudioTracks()[0].addEventListener("ended", () => { analyser = null; });
        }
      } catch (_) {}
      return s;
    };
  }
  const level = () => {
    if (!analyser) return 0;
    if (actx && actx.state !== "running") actx.resume().catch(() => {});
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  };

  const H = {
    on: false,
    last: "",
    timer: 0,
    btn() {
      return [...document.querySelectorAll("button[aria-label]")].filter(vis)
        .find((b) => /dictat|dikte|voice input|stop recording|stop dictation/i.test(b.getAttribute("aria-label"))) || null;
    },
    comp() { return [...document.querySelectorAll("[data-cds=Editor], [contenteditable=true], textarea")].filter(vis)[0] || null; },
    text() {
      const c = H.comp();
      if (!c) return "";
      return (c.tagName === "TEXTAREA" ? c.value : c.innerText || "").replace(/​/g, "").trim();
    },
    // Dikte açık mı? claude.ai açıkken etiketi "Finish dictation" yapıyor; mikrofon akışı güvenilir değil
    // (dikte kapandıktan sonra da açık kalabiliyor), o yüzden yalnızca etikete bak.
    active() {
      const b = H.btn();
      if (!b) return false;
      const l = (b.getAttribute("aria-label") || "").toLowerCase();
      return b.getAttribute("aria-pressed") === "true" || /finish|stop|end|durdur|bitir/.test(l);
    },
    async waitActive(want, ms) {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) { if (H.active() === want) return true; await sleep(100); }
      return H.active() === want;
    },
    clear() {
      const c = H.comp();
      if (!c || !H.text()) return;
      c.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");
      c.blur();
    },
    click(el) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      el.click();
    },
    status() {
      const b = H.btn();
      E("status", {
        path: location.pathname,
        btn: b ? (b.getAttribute("aria-label") + "|" + b.getAttribute("aria-pressed")) : null,
        active: H.active(),
        text: H.text().slice(0, 200),
        mic: !!analyser,
        ctx: actx ? actx.state : null,
        level: level(),
      });
    },
    async start() {
      if (/login|signin/.test(location.pathname)) { E("error", "giriş gerekli"); return; }
      if (H.starting) return;
      H.starting = true;
      try {
        if (H.active()) { H.click(H.btn()); await H.waitActive(false, 1500); }
        H.clear();
        let b = H.btn();
        if (!b) { E("error", "no-button"); return; }
        H.click(b);
        // İlk açılışta mikrofon ısınırken ilk tıklama tutmayabiliyor: bir kez daha dene.
        if (!(await H.waitActive(true, 2500))) {
          b = H.btn();
          if (b && !H.active()) H.click(b);
          if (!(await H.waitActive(true, 2500))) { E("error", "dikte başlamadı"); return; }
        }
        H.on = true;
        H.last = "";
        clearInterval(H.timer);
        H.timer = setInterval(() => {
          const t = H.text();
          if (t !== H.last) { H.last = t; E("partial", t); }
          E("level", String(level().toFixed(4)));
        }, 100);
        E("started", "");
      } finally { H.starting = false; }
    },
    async stop() {
      if (!H.on) { E("final", ""); return; }
      H.on = false;
      const b = H.btn();
      if (b && H.active()) H.click(b);
      // Metnin oturmasını bekle (son kelimeler biraz geç düşebiliyor).
      const t0 = performance.now();
      let last = H.text(), since = performance.now();
      while (performance.now() - t0 < 4000) {
        await sleep(120);
        const cur = H.text();
        if (cur !== last) { last = cur; since = performance.now(); E("partial", cur); }
        if (performance.now() - since > 600 && !H.active()) break;
      }
      clearInterval(H.timer);
      const text = H.text();
      E("final", text);
      setTimeout(H.clear, 100);
    },
    cancel() {
      const wasOn = H.on;
      H.on = false;
      clearInterval(H.timer);
      const b = H.btn();
      if (wasOn && b && H.active()) H.click(b);
      setTimeout(H.clear, 700);
      E("cancelled", "");
    },
  };
  window.__csHelper = H;
  // Yardımcı sayfa burada hiçbir şey göndermesin: Enter'ı yut.
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); } }, true);
  E("loaded", location.pathname);
})();
