package tr.akts.claudevoice;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Uygulamanın kendi mikrofonu + basit konuşma algılama + Mac'teki whisper-server.
 *
 * Kipler:
 *  LISTEN: konuşma başlayınca kaydeder, ~1 sn'de bir ara metin ister, sessizlikte son metni yollar.
 *  WATCH : Claude konuşurken dinler; kullanıcı araya girerse "w-barge" yollar ve LISTEN'e geçer
 *          (o ana kadarki ses kaybolmaz).
 */
class WhisperClient {
    private static final int RATE = 16000;
    private static final int FRAME = 320; // 20 ms
    private static final int PREROLL_FRAMES = 15; // 300 ms

    enum Mode { OFF, LISTEN, WATCH }

    private final VoiceEngine.Events ev;
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    // Son metin ara metnin arkasında beklemesin diye ayrı kuyruk.
    private final ExecutorService finals = Executors.newSingleThreadExecutor();
    private final AtomicBoolean partialBusy = new AtomicBoolean(false);
    private volatile Mode mode = Mode.OFF;
    private volatile String server = "http://127.0.0.1:8178";
    private volatile String language = "tr";
    private volatile String prompt = "";
    private volatile int silenceMs = 900;
    private Thread worker;
    private volatile boolean running = false;
    private int session = 0;

    private final java.io.File debugDir;

    WhisperClient(VoiceEngine.Events ev, java.io.File debugDir) { this.ev = ev; this.debugDir = debugDir; }

    /** Teşhis: son gönderilen konuşmayı WAV olarak sakla (adb pull ile alınır). */
    private void saveDebug(byte[] pcm) {
        if (debugDir == null) return;
        try (java.io.FileOutputStream f = new java.io.FileOutputStream(new java.io.File(debugDir, "son-konusma.wav"))) {
            f.write(wavHeader(pcm.length)); f.write(pcm);
        } catch (Exception ignored) { }
    }

    void configure(String url, String lang, int silence, String initialPrompt) {
        if (url != null && !url.isEmpty()) server = url.replaceAll("/+$", "");
        if (lang != null && !lang.isEmpty()) language = lang;
        if (silence >= 300) silenceMs = silence;
        prompt = initialPrompt == null ? "" : initialPrompt;
    }

    synchronized void setMode(Mode m) {
        mode = m;
        session++;
        if (m != Mode.OFF && !running) start();
    }

    synchronized void stop() { mode = Mode.OFF; running = false; session++; }

    String server() { return server; }

    /** Mac'teki Claude Ses Sunucu'ya "Whisper'ı başlat" de (kontrol kapısı 8177). */
    void wake(String host) {
        net.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL("http://" + host + ":8177/wake").openConnection();
                c.setConnectTimeout(1500);
                c.setReadTimeout(2000);
                InputStream in = c.getInputStream();
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[1024]; int r;
                while ((r = in.read(buf)) > 0) b.write(buf, 0, r);
                c.disconnect();
                ev.emit("w-wake", VoiceEngine.q(b.toString(StandardCharsets.UTF_8.name())));
            } catch (Exception e) {
                ev.emit("w-wake", VoiceEngine.q("{\"state\":\"unreachable\"}"));
            }
        });
    }

    void ping() {
        net.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/").openConnection();
                c.setConnectTimeout(1500);
                c.setReadTimeout(2000);
                int code = c.getResponseCode();
                c.disconnect();
                ev.emit("w-ping", code < 500 ? "true" : "false");
            } catch (Exception e) {
                ev.emit("w-ping", "false");
            }
        });
    }

    private void start() {
        running = true;
        worker = new Thread(this::loop, "whisper-mic");
        worker.start();
    }

    private void loop() {
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, FRAME * 2 * 20));
        } catch (Exception e) {
            ev.emit("w-error", VoiceEngine.q("mikrofon: " + e.getMessage()));
            running = false;
            return;
        }
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            ev.emit("w-error", VoiceEngine.q("mikrofon açılamadı"));
            running = false;
            return;
        }
        AcousticEchoCanceler aec = null;
        NoiseSuppressor ns = null;
        try { if (AcousticEchoCanceler.isAvailable()) { aec = AcousticEchoCanceler.create(rec.getAudioSessionId()); aec.setEnabled(true); } } catch (Exception ignored) { }
        try { if (NoiseSuppressor.isAvailable()) { ns = NoiseSuppressor.create(rec.getAudioSessionId()); ns.setEnabled(true); } } catch (Exception ignored) { }
        ev.emit("w-mic", VoiceEngine.q("aec=" + (aec != null) + " ns=" + (ns != null)));
        rec.startRecording();

        short[] frame = new short[FRAME];
        short[][] preroll = new short[PREROLL_FRAMES][];
        int preIdx = 0;
        ByteArrayOutputStream utter = new ByteArrayOutputStream();
        double floor = 0.004;      // ortam gürültüsü tahmini
        double echo = 0.0;         // Claude konuşurken mikrofona sızan ses
        boolean inSpeech = false;
        int loudFrames = 0, quietMs = 0, speechMs = 0;
        long lastPartial = 0, lastLevel = 0;
        int mySession = -1;

        while (running) {
            int n = rec.read(frame, 0, FRAME);
            if (n <= 0) continue;
            Mode m = mode;
            if (m == Mode.OFF) { running = false; break; }
            if (mySession != session) {
                // Kip değişti: kayıt durumunu sıfırla (WATCH → LISTEN geçişinde araya girme sesi korunur).
                boolean keep = inSpeech && m == Mode.LISTEN;
                mySession = session;
                if (!keep) { utter.reset(); inSpeech = false; loudFrames = 0; speechMs = 0; }
                quietMs = 0;
            }
            double sum = 0;
            for (int i = 0; i < n; i++) { double v = frame[i] / 32768.0; sum += v * v; }
            double rms = Math.sqrt(sum / n);
            long now = System.currentTimeMillis();
            if (now - lastLevel > 80) { lastLevel = now; ev.emit("w-level", String.format(java.util.Locale.US, "%.4f", rms)); }

            if (!inSpeech) {
                if (m == Mode.LISTEN) floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.995 + rms * 0.005;
                else echo = echo * 0.97 + rms * 0.03;
            }
            double thr = m == Mode.WATCH ? Math.max(0.035, Math.max(echo * 2.8, floor * 6)) : Math.max(0.012, floor * 3.2);
            boolean loud = rms > thr;

            if (!inSpeech) {
                preroll[preIdx] = frame.clone();
                preIdx = (preIdx + 1) % PREROLL_FRAMES;
                loudFrames = loud ? loudFrames + 1 : Math.max(0, loudFrames - 1);
                int need = m == Mode.WATCH ? 14 : 5; // 280 ms / 100 ms
                if (loudFrames >= need) {
                    inSpeech = true;
                    speechMs = 0;
                    quietMs = 0;
                    utter.reset();
                    for (int k = 0; k < PREROLL_FRAMES; k++) {
                        short[] f = preroll[(preIdx + k) % PREROLL_FRAMES];
                        if (f != null) writePcm(utter, f, f.length);
                    }
                    if (m == Mode.WATCH) {
                        ev.emit("w-barge", "\"\"");
                        mode = Mode.LISTEN; // araya girdi: dinlemeye geç, sesi kaybetme
                    }
                    ev.emit("w-speech", "\"\"");
                }
                continue;
            }

            writePcm(utter, frame, n);
            speechMs += 20;
            quietMs = loud ? 0 : quietMs + 20;
            if (mode != Mode.LISTEN) continue;

            if (now - lastPartial > 900 && speechMs > 600 && partialBusy.compareAndSet(false, true)) {
                lastPartial = now;
                byte[] pcm = utter.toByteArray();
                int s = session;
                net.execute(() -> {
                    try {
                        String t = transcribe(pcm);
                        if (s == session && mode == Mode.LISTEN) ev.emit("w-partial", VoiceEngine.q(t));
                    } catch (Exception ignored) {
                    } finally { partialBusy.set(false); }
                });
            }

            boolean tooLong = speechMs > 45000;
            if (quietMs >= silenceMs || tooLong) {
                byte[] pcm = utter.toByteArray();
                inSpeech = false;
                loudFrames = 0;
                utter.reset();
                if (speechMs - quietMs < 350) continue; // çok kısa: öksürük, tık sesi
                mode = Mode.OFF; // tek seferlik: sonraki dinlemeyi sayfa başlatır
                ev.emit("w-end", "\"\"");
                finals.execute(() -> {
                    saveDebug(pcm);
                    try { ev.emit("w-final", VoiceEngine.q(transcribe(pcm))); }
                    catch (Exception e) { ev.emit("w-error", VoiceEngine.q("whisper: " + e.getMessage())); }
                });
            }
        }
        try { rec.stop(); } catch (Exception ignored) { }
        rec.release();
        if (aec != null) aec.release();
        if (ns != null) ns.release();
        running = false;
    }

    private static void writePcm(ByteArrayOutputStream out, short[] f, int n) {
        for (int i = 0; i < n; i++) { out.write(f[i] & 0xff); out.write((f[i] >> 8) & 0xff); }
    }

    private String transcribe(byte[] pcm) throws Exception {
        String boundary = "cs" + System.nanoTime();
        HttpURLConnection c = (HttpURLConnection) new URL(server + "/inference").openConnection();
        c.setConnectTimeout(2000);
        c.setReadTimeout(20000);
        c.setDoOutput(true);
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (DataOutputStream o = new DataOutputStream(c.getOutputStream())) {
            field(o, boundary, "response_format", "json");
            field(o, boundary, "language", language);
            field(o, boundary, "temperature", "0.0");
            if (!prompt.isEmpty()) field(o, boundary, "prompt", prompt);
            o.writeBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n");
            o.write(wavHeader(pcm.length));
            o.write(pcm);
            o.writeBytes("\r\n--" + boundary + "--\r\n");
        }
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int r;
        while ((r = in.read(buf)) > 0) b.write(buf, 0, r);
        c.disconnect();
        String body = b.toString(StandardCharsets.UTF_8.name());
        if (code >= 400) throw new Exception("HTTP " + code);
        return new JSONObject(body).optString("text", "").replaceAll("\\s+", " ").trim();
    }

    private static void field(DataOutputStream o, String b, String name, String val) throws Exception {
        o.writeBytes("--" + b + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
        o.write(val.getBytes(StandardCharsets.UTF_8));
        o.writeBytes("\r\n");
    }

    private static byte[] wavHeader(int dataLen) {
        int byteRate = RATE * 2;
        byte[] h = new byte[44];
        put(h, 0, "RIFF"); le32(h, 4, 36 + dataLen); put(h, 8, "WAVE"); put(h, 12, "fmt ");
        le32(h, 16, 16); le16(h, 20, 1); le16(h, 22, 1); le32(h, 24, RATE); le32(h, 28, byteRate);
        le16(h, 32, 2); le16(h, 34, 16); put(h, 36, "data"); le32(h, 40, dataLen);
        return h;
    }
    private static void put(byte[] h, int o, String s) { for (int i = 0; i < 4; i++) h[o + i] = (byte) s.charAt(i); }
    private static void le32(byte[] h, int o, int v) { h[o] = (byte) v; h[o + 1] = (byte) (v >> 8); h[o + 2] = (byte) (v >> 16); h[o + 3] = (byte) (v >> 24); }
    private static void le16(byte[] h, int o, int v) { h[o] = (byte) v; h[o + 1] = (byte) (v >> 8); }
}
