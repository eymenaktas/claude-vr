package tr.akts.claudevoice;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Cihazın kendi konuşma tanıma (SpeechRecognizer) ve seslendirme (TextToSpeech) servisleri
 * ile bildirimler. Olaylar sayfaya Events.emit ile gider.
 */
class VoiceEngine {
    interface Events { void emit(String type, String json); }

    private final Activity act;
    private final Events ev;
    private SpeechRecognizer rec;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String ttsError = "";
    private boolean listening = false;
    private int notifId = 100;

    VoiceEngine(Activity act, Events ev) {
        this.act = act;
        this.ev = ev;
    }

    // Quest'in seslendirme servisi yalnızca İngilizce ve açılışı ağır (ANR'ye katkı): yalnızca istenince bağlan.
    private void ensureTts() {
        if (tts != null) return;
        tts = new TextToSpeech(act, status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (!ttsReady) ttsError = "init " + status;
            else {
                int r = tts.setLanguage(new Locale("tr", "TR"));
                if (r < 0) ttsError = "tr yok (" + r + ")";
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { ev.emit("tts-start", q(id)); }
                    @Override public void onDone(String id) { ev.emit("tts-done", q(id)); }
                    @Override public void onError(String id) { ev.emit("tts-error", q(id)); }
                    @Override public void onStop(String id, boolean interrupted) { ev.emit("tts-done", q(id)); }
                });
            }
            ev.emit("tts-ready", q(info()));
        });
    }

    static String q(String s) { return JSONObject.quote(s == null ? "" : s); }

    // ---------- Konuşma tanıma ----------

    boolean sttAvailable() { return SpeechRecognizer.isRecognitionAvailable(act); }

    void sttStart(String lang) {
        act.runOnUiThread(() -> {
            try {
                if (rec == null) {
                    rec = SpeechRecognizer.createSpeechRecognizer(act);
                    rec.setRecognitionListener(listener);
                }
                if (listening) rec.cancel();
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
                i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
                i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
                i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, act.getPackageName());
                listening = true;
                rec.startListening(i);
            } catch (Exception e) {
                listening = false;
                ev.emit("stt-error", q("start: " + e.getMessage()));
            }
        });
    }

    void sttStop() { act.runOnUiThread(() -> { if (rec != null && listening) rec.stopListening(); }); }

    void sttCancel() {
        act.runOnUiThread(() -> { if (rec != null) rec.cancel(); listening = false; });
    }

    private static String first(Bundle b) {
        if (b == null) return "";
        ArrayList<String> l = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return l == null || l.isEmpty() ? "" : l.get(0);
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override public void onReadyForSpeech(Bundle p) { ev.emit("stt-ready", "\"\""); }
        @Override public void onBeginningOfSpeech() { ev.emit("stt-begin", "\"\""); }
        @Override public void onRmsChanged(float db) { ev.emit("stt-rms", String.valueOf(db)); }
        @Override public void onBufferReceived(byte[] b) { }
        @Override public void onEndOfSpeech() { ev.emit("stt-end", "\"\""); }
        @Override public void onError(int code) { listening = false; ev.emit("stt-error", q("code " + code)); }
        @Override public void onResults(Bundle b) { listening = false; ev.emit("stt-final", q(first(b))); }
        @Override public void onPartialResults(Bundle b) { ev.emit("stt-partial", q(first(b))); }
        @Override public void onEvent(int t, Bundle p) { }
    };

    // ---------- Seslendirme ----------

    String info() {
        ensureTts();
        JSONObject o = new JSONObject();
        try {
            o.put("ready", ttsReady);
            o.put("error", ttsError);
            o.put("stt", sttAvailable());
            if (ttsReady) {
                o.put("engine", tts.getDefaultEngine());
                JSONArray langs = new JSONArray();
                try { for (Locale l : tts.getAvailableLanguages()) langs.put(l.toLanguageTag()); } catch (Exception ignored) { }
                o.put("langs", langs);
                JSONArray voices = new JSONArray();
                try { for (Voice v : tts.getVoices()) if (v.getLocale().getLanguage().equals("tr")) voices.put(v.getName()); } catch (Exception ignored) { }
                o.put("trVoices", voices);
            }
        } catch (Exception ignored) { }
        return o.toString();
    }

    boolean speak(String text, String id, boolean queue) {
        ensureTts();
        if (!ttsReady) return false;
        Bundle p = new Bundle();
        return tts.speak(text, queue ? TextToSpeech.QUEUE_ADD : TextToSpeech.QUEUE_FLUSH, p, id) == TextToSpeech.SUCCESS;
    }

    void stopSpeaking() { if (ttsReady) tts.stop(); }

    // ---------- Bildirim ----------

    void notifyUser(String title, String text) {
        NotificationManager nm = act.getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel("claude", "Claude yanıtları", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(ch);
        Intent open = new Intent(act, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(act, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(act, "claude")
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        nm.notify(notifId++, n);
    }

    void destroy() {
        if (rec != null) rec.destroy();
        if (tts != null) tts.shutdown();
    }
}
