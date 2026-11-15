package tr.akts.claudevoice;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.media.projection.MediaProjectionManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.FrameLayout;
import java.util.ArrayList;
import java.util.List;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final String HOME = "https://claude.ai/code";
    private static final int REQ_MIC = 7;
    private static final int REQ_SCREEN = 8;

    private FrameLayout root;
    private WebView web;
    private WebView dict;
    private String helperJs = "";
    private static final String DICT_URL = "https://claude.ai/new";
    private final List<WebView> popups = new ArrayList<>();
    private String overlayJs = "";
    private PermissionRequest pendingWebPermission;
    private VoiceEngine voice;
    private WhisperClient whisper;
    private boolean focused = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebView.setWebContentsDebuggingEnabled(true);

        overlayJs = readAsset("overlay.js");
        helperJs = readAsset("dictate-helper.js");

        root = new FrameLayout(this);
        setupDictationHelper();
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#262624"));
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        root.post(() -> handleMediaIntent(getIntent()));

        configure(web);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(), "ClaudeSesNative");
        voice = new VoiceEngine(this, this::emit);
        whisper = new WhisperClient(this::emit, getExternalFilesDir(null));
        // Whisper kullanılmıyor (Claude diktesi yeterli): Mac'i arama/uyandırma kapalı.

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                inject(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                inject(view);
                CookieManager.getInstance().flush();
            }
        });

        web.setWebChromeClient(new Chrome());

        List<String> need = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO);
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) need.add("android.permission.POST_NOTIFICATIONS");
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_MIC);
        else startMicService();

        Uri data = getIntent() != null ? getIntent().getData() : null;
        web.loadUrl(data != null ? data.toString() : HOME);
    }

    /** Ana pencerenin arkasında görünmez claude.ai/code: Dictate düğmesi orada her zaman var. */
    private void setupDictationHelper() {
        dict = new WebView(this);
        configure(dict);
        dict.addJavascriptInterface(new Object() {
            @JavascriptInterface public void emit(String type, String data) { MainActivity.this.emit("dict-" + type, VoiceEngine.q(data)); }
        }, "ClaudeSesHelper");
        dict.setWebChromeClient(new Chrome() {
            @Override public boolean onCreateWindow(WebView v, boolean d, boolean g, Message m) { return false; }
        });
        dict.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String sch = r.getUrl().getScheme();
                return !("http".equals(sch) || "https".equals(sch));
            }
            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap f) { v.evaluateJavascript(helperJs, null); }
            @Override public void onPageFinished(WebView v, String u) { v.evaluateJavascript(helperJs, null); }
        });
        root.addView(dict, new FrameLayout.LayoutParams(900, 1000));
        dict.loadUrl(DICT_URL);
    }

    private void dictCommand(String cmd) {
        runOnUiThread(() -> {
            if (dict == null) return;
            if ("reload".equals(cmd)) { dict.loadUrl(DICT_URL); return; }
            dict.evaluateJavascript("window.__csHelper ? (__csHelper." + cmd + "(), 1) : ClaudeSesHelper.emit('error','yüklenmedi')", null);
        });
    }

    private void configure(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // Google girişi açılır pencere + window.opener ile sonucu geri yolluyor; buna izin ver.
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // WebView'in "; wv" işaretini çıkar: bazı giriş sayfaları gömülü tarayıcıyı reddediyor.
        String ua = s.getUserAgentString().replace("; wv", "").replaceAll("Version/\\d+\\.\\d+ ", "");
        s.setUserAgentString(ua);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
    }

    /** Ana pencere ve açılır pencereler için ortak tarayıcı davranışı. */
    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(request.getResources());
                } else {
                    pendingWebPermission = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            });
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            WebView popup = new WebView(MainActivity.this);
            configure(popup);
            popup.setBackgroundColor(Color.WHITE);
            popup.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                    String scheme = req.getUrl().getScheme();
                    return !("http".equals(scheme) || "https".equals(scheme));
                }
            });
            popup.setWebChromeClient(new Chrome());
            root.addView(popup, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            popups.add(popup);
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onCloseWindow(WebView window) {
            closePopup(window);
        }
    }

    private void closePopup(WebView popup) {
        root.removeView(popup);
        popups.remove(popup);
        popup.destroy();
    }

    private void inject(WebView view) {
        if (!overlayJs.isEmpty()) view.evaluateJavascript(overlayJs, null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (handleMediaIntent(intent)) return;
        if (intent.getData() != null) web.loadUrl(intent.getData().toString());
    }

    // ---- Görsel / video gösterici --------------------------------------------------------
    // Mac'teki ajan adb ile tetikler:
    //   adb shell am start -n tr.akts.claudevoice/.MainActivity -a tr.akts.claudevoice.SHOW --es url <url|dosya> [--es title <başlık>]
    //   adb shell am start -n tr.akts.claudevoice/.MainActivity -a tr.akts.claudevoice.HIDE
    // Yerel dosyalar adb push ile getExternalFilesDir(null)/media/ altına konur; url olarak dosya adı verilebilir.
    static final String ACTION_SHOW = "tr.akts.claudevoice.SHOW";
    static final String ACTION_HIDE = "tr.akts.claudevoice.HIDE";
    private FrameLayout mediaLayer;
    private WebView mediaView;

    private boolean handleMediaIntent(Intent intent) {
        if (intent == null || intent.getAction() == null) return false;
        if (ACTION_HIDE.equals(intent.getAction())) { hideMedia(); return true; }
        if (!ACTION_SHOW.equals(intent.getAction())) return false;
        String url = intent.getStringExtra("url");
        if (url == null && intent.getData() != null) url = intent.getData().toString();
        if (url == null || url.isEmpty()) return true;
        showMedia(url, intent.getStringExtra("title"));
        return true;
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private void showMedia(String url, String title) {
        if (!url.matches("^(https?|file|content|data):.*")) {
            java.io.File f = url.startsWith("/") ? new java.io.File(url) : new java.io.File(new java.io.File(getExternalFilesDir(null), "media"), url);
            url = Uri.fromFile(f).toString();
        }
        String lower = url.toLowerCase(java.util.Locale.ROOT).replaceAll("[?#].*$", "");
        boolean video = lower.matches(".*\\.(mp4|webm|mov|m4v|mkv|3gp)$") || lower.contains("youtube.com/") || lower.contains("youtu.be/");
        boolean page = !video && !lower.matches(".*\\.(png|jpe?g|gif|webp|bmp|svg|avif)$") && !lower.startsWith("data:image");
        if (mediaLayer == null) {
            mediaLayer = new FrameLayout(this);
            mediaLayer.setBackgroundColor(Color.rgb(20, 20, 19));
            mediaView = new WebView(this);
            WebSettings ms = mediaView.getSettings();
            ms.setJavaScriptEnabled(true);
            ms.setDomStorageEnabled(true);
            ms.setAllowFileAccess(true);
            ms.setMediaPlaybackRequiresUserGesture(false);
            ms.setLoadWithOverviewMode(true);
            ms.setUseWideViewPort(true);
            mediaView.setBackgroundColor(Color.rgb(20, 20, 19));
            mediaView.setWebChromeClient(new WebChromeClient());
            mediaView.setWebViewClient(new WebViewClient());
            mediaLayer.addView(mediaView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            android.widget.TextView close = new android.widget.TextView(this);
            close.setText("\u2715");
            close.setTextSize(26);
            close.setTextColor(Color.WHITE);
            close.setGravity(android.view.Gravity.CENTER);
            android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
            bg.setShape(android.graphics.drawable.GradientDrawable.OVAL);
            bg.setColor(Color.argb(200, 217, 119, 87));
            close.setBackground(bg);
            close.setOnClickListener(v -> hideMedia());
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(96, 96, android.view.Gravity.TOP | android.view.Gravity.END);
            lp.setMargins(0, 24, 24, 0);
            mediaLayer.addView(close, lp);
        }
        if (mediaLayer.getParent() == null) root.addView(mediaLayer, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        mediaLayer.bringToFront();
        if (page) {
            mediaView.loadUrl(url);
        } else {
            String t = title == null ? "" : "<div class=t>" + esc(title) + "</div>";
            String el;
            String yt = null;
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?:youtube\\.com/(?:watch\\?v=|shorts/|embed/)|youtu\\.be/)([\\w-]{6,})").matcher(url);
            if (m.find()) yt = m.group(1);
            if (yt != null) el = "<iframe src=\"https://www.youtube.com/embed/" + yt + "?autoplay=1&playsinline=1\" allow=\"autoplay; encrypted-media; fullscreen\" allowfullscreen></iframe>";
            else if (video) el = "<video src=\"" + esc(url) + "\" controls autoplay playsinline></video>";
            else el = "<img src=\"" + esc(url) + "\">";
            String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><style>"
                    + "html,body{margin:0;height:100%;background:#141413;color:#faf9f5;font:20px system-ui}"
                    + "body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}"
                    + "img,video{max-width:100%;max-height:calc(100% - 64px);object-fit:contain;border-radius:12px}"
                    + "iframe{width:100%;height:calc(100% - 64px);border:0}"
                    + ".t{opacity:.85}</style>" + el + t;
            mediaView.loadDataWithBaseURL(url.startsWith("file:") ? "file:///" : "https://claude-ses.local/", html, "text/html", "utf-8", null);
        }
        emit("media-show", VoiceEngine.q(url));
    }

    private void hideMedia() {
        if (mediaLayer == null || mediaLayer.getParent() == null) return;
        mediaView.loadUrl("about:blank");
        root.removeView(mediaLayer);
        emit("media-hide", "\"\"");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SCREEN) return;
        if (resultCode == RESULT_OK && data != null) {
            Intent svc = new Intent(this, ScreenCaptureService.class)
                    .putExtra(ScreenCaptureService.EXTRA_CODE, resultCode)
                    .putExtra(ScreenCaptureService.EXTRA_DATA, data);
            try {
                startForegroundService(svc);
                notifyPage("screen-on", "");
            } catch (Exception e) {
                notifyPage("screen-error", e.getMessage());
            }
        } else {
            notifyPage("screen-denied", "");
        }
    }

    private void notifyPage(String type, String msg) { emit(type, VoiceEngine.q(msg)); }

    /** Sayfadaki scripte olay gönder: window.__claudeSes.onNative(tip, veri). json geçerli bir JS değeri olmalı. */
    private void emit(String type, String json) {
        String js = "window.__claudeSes && window.__claudeSes.onNative && window.__claudeSes.onNative(" + VoiceEngine.q(type) + "," + json + ")";
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    // ---- Mac'i ağda bul (Claude Ses Sunucu, _claudeses._tcp) ve Whisper'ı uyandır ----
    private android.net.nsd.NsdManager nsd;
    private volatile String macHost = null;

    private void discoverMac() {
        try {
            nsd = (android.net.nsd.NsdManager) getSystemService(NSD_SERVICE);
            nsd.discoverServices("_claudeses._tcp", android.net.nsd.NsdManager.PROTOCOL_DNS_SD, new android.net.nsd.NsdManager.DiscoveryListener() {
                @Override public void onStartDiscoveryFailed(String t, int e) { emit("mac-error", VoiceEngine.q("discovery " + e)); }
                @Override public void onStopDiscoveryFailed(String t, int e) { }
                @Override public void onDiscoveryStarted(String t) { }
                @Override public void onDiscoveryStopped(String t) { }
                @Override public void onServiceLost(android.net.nsd.NsdServiceInfo i) { }
                @Override public void onServiceFound(android.net.nsd.NsdServiceInfo info) {
                    nsd.resolveService(info, new android.net.nsd.NsdManager.ResolveListener() {
                        @Override public void onResolveFailed(android.net.nsd.NsdServiceInfo i, int e) { emit("mac-error", VoiceEngine.q("resolve " + e)); }
                        @Override public void onServiceResolved(android.net.nsd.NsdServiceInfo i) {
                            if (i.getHost() == null) return;
                            String h = i.getHost().getHostAddress();
                            if (h == null || h.contains(":")) return; // IPv4 yeterli
                            macHost = h;
                            whisper.configure("http://" + h + ":8178", null, 0, null);
                            whisper.wake(h);
                            emit("mac-found", VoiceEngine.q(h));
                        }
                    });
                }
            });
        } catch (Exception e) {
            emit("mac-error", VoiceEngine.q(String.valueOf(e.getMessage())));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (macHost != null && whisper != null) whisper.wake(macHost);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        focused = hasFocus;
        emit("focus", hasFocus ? "true" : "false");
    }

    @Override
    protected void onDestroy() {
        if (voice != null) voice.destroy();
        if (whisper != null) whisper.stop();
        stopService(new Intent(this, MicService.class));
        super.onDestroy();
    }

    private void startMicService() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        try { startForegroundService(new Intent(this, MicService.class)); } catch (Exception ignored) { }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_MIC) startMicService();
        if (code != REQ_MIC || pendingWebPermission == null) return;
        boolean ok = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (ok) pendingWebPermission.grant(pendingWebPermission.getResources());
        else pendingWebPermission.deny();
        pendingWebPermission = null;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && !popups.isEmpty()) {
            WebView top = popups.get(popups.size() - 1);
            if (top.canGoBack()) top.goBack(); else closePopup(top);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return "";
        }
    }

    /** Sayfadaki scriptin uygulamaya ulaşması için küçük köprü. */
    private class Bridge {
        @JavascriptInterface
        public String version() { return "0.6.0"; }

        @JavascriptInterface
        public void hideKeyboard() {
            runOnUiThread(() -> {
                InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm != null) imm.hideSoftInputFromWindow(web.getWindowToken(), 0);
            });
        }

        /** Sistem izin penceresini açar; onaylanınca ekran yakalama servisi başlar. */
        @JavascriptInterface
        public void startScreenShare() {
            runOnUiThread(() -> {
                if (ScreenCaptureService.isRunning()) return;
                MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
                try {
                    startActivityForResult(mpm.createScreenCaptureIntent(), REQ_SCREEN);
                } catch (Exception e) {
                    notifyPage("screen-error", e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void stopScreenShare() {
            runOnUiThread(() -> stopService(new Intent(MainActivity.this, ScreenCaptureService.class)));
        }

        @JavascriptInterface
        public boolean isScreenSharing() { return ScreenCaptureService.isRunning(); }

        /** Eskiden yeniye en fazla n kare, JSON dizisi (base64 JPEG). */
        @JavascriptInterface
        public String getFrames(int n) {
            String[] f = ScreenCaptureService.latest(n);
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < f.length; i++) {
                if (i > 0) sb.append(',');
                sb.append('"').append(f[i]).append('"');
            }
            return sb.append(']').toString();
        }

        @JavascriptInterface public void dict(String cmd) {
            if (cmd.matches("start|stop|cancel|status|reload")) dictCommand(cmd);
        }
        /** off | listen | watch */
        @JavascriptInterface public void wMode(String m) {
            if ("listen".equals(m)) whisper.setMode(WhisperClient.Mode.LISTEN);
            else if ("watch".equals(m)) whisper.setMode(WhisperClient.Mode.WATCH);
            else whisper.stop();
        }
        @JavascriptInterface public void wConfig(String url, String lang, int silenceMs, String prompt) { whisper.configure(url, lang, silenceMs, prompt); }
        @JavascriptInterface public void wPing() { whisper.ping(); }
        /** host boşsa bulunan Mac'i kullan. */
        @JavascriptInterface public void wWake(String host) {
            String h = host == null || host.isEmpty() ? macHost : host;
            if (h != null) whisper.wake(h);
        }
        @JavascriptInterface public String voiceInfo() { return voice.info(); }
        @JavascriptInterface public boolean sttAvailable() { return voice.sttAvailable(); }
        @JavascriptInterface public void sttStart(String lang) { voice.sttStart(lang); }
        @JavascriptInterface public void sttStop() { voice.sttStop(); }
        @JavascriptInterface public void sttCancel() { voice.sttCancel(); }
        @JavascriptInterface public boolean speak(String text, String id, boolean queue) { return voice.speak(text, id, queue); }
        @JavascriptInterface public void stopSpeaking() { voice.stopSpeaking(); }
        @JavascriptInterface public boolean isFocused() { return focused; }
        @JavascriptInterface public void notify(String title, String text) {
            runOnUiThread(() -> { try { voice.notifyUser(title, text); } catch (Exception ignored) { } });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
            });
        }
    }
}
