package tr.akts.claudevoice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;

/**
 * Ekranı saniyede bir kare yakalar, son KEEP kareyi JPEG (base64) olarak bellekte tutar.
 * Android 14: MediaProjection yalnızca "mediaProjection" türünde ön plan servisinden alınabilir.
 */
public class ScreenCaptureService extends Service {
    public static final String EXTRA_CODE = "code";
    public static final String EXTRA_DATA = "data";
    private static final int KEEP = 5;
    private static final long INTERVAL_MS = 1000;
    private static final int TARGET_WIDTH = 1280;

    private static final ArrayDeque<String> frames = new ArrayDeque<>();
    private static volatile boolean running = false;

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private long lastSaved = 0;

    public static boolean isRunning() { return running; }

    /** Eskiden yeniye en fazla n kare. */
    public static synchronized String[] latest(int n) {
        String[] all = frames.toArray(new String[0]);
        int from = Math.max(0, all.length - n);
        String[] out = new String[all.length - from];
        System.arraycopy(all, from, out, 0, out.length);
        return out;
    }

    private static synchronized void push(String jpegB64) {
        frames.addLast(jpegB64);
        while (frames.size() > KEEP) frames.removeFirst();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundNow();
        if (intent == null || projection != null) return START_NOT_STICKY;
        int code = intent.getIntExtra(EXTRA_CODE, 0);
        Intent data = intent.getParcelableExtra(EXTRA_DATA);
        if (data == null) { stopSelf(); return START_NOT_STICKY; }

        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = mpm.getMediaProjection(code, data);
        if (projection == null) { stopSelf(); return START_NOT_STICKY; }

        thread = new HandlerThread("ekran");
        thread.start();
        Handler handler = new Handler(thread.getLooper());

        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { stopSelf(); }
        }, handler);

        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        int w = Math.min(TARGET_WIDTH, m.widthPixels);
        int h = Math.max(1, Math.round(m.heightPixels * (w / (float) m.widthPixels)));

        reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(r -> {
            Image img = null;
            try {
                img = r.acquireLatestImage();
                if (img == null) return;
                long now = System.currentTimeMillis();
                if (now - lastSaved < INTERVAL_MS) return;
                lastSaved = now;
                push(toJpegBase64(img));
            } catch (Exception ignored) {
            } finally {
                if (img != null) img.close();
            }
        }, handler);

        display = projection.createVirtualDisplay("claude-ses-ekran", w, h, m.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
        running = true;
        return START_NOT_STICKY;
    }

    private static String toJpegBase64(Image img) {
        Image.Plane p = img.getPlanes()[0];
        ByteBuffer buf = p.getBuffer();
        int pixelStride = p.getPixelStride();
        int rowStride = p.getRowStride();
        int width = img.getWidth(), height = img.getHeight();
        int paddedWidth = rowStride / pixelStride;
        Bitmap padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buf);
        Bitmap bmp = paddedWidth == width ? padded : Bitmap.createBitmap(padded, 0, 0, width, height);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 72, out);
        if (bmp != padded) bmp.recycle();
        padded.recycle();
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    private void startForegroundNow() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel("ekran", "Ekran paylaşımı", NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(ch);
        Notification n = new Notification.Builder(this, "ekran")
                .setContentTitle("Claude Ses ekranı görüyor")
                .setContentText("Son 5 saniye mesajlarına eklenebilir.")
                .setSmallIcon(R.drawable.ic_launcher)
                .setOngoing(true)
                .build();
        startForeground(42, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (display != null) display.release();
        if (reader != null) reader.close();
        if (projection != null) projection.stop();
        if (thread != null) thread.quitSafely();
        projection = null;
        synchronized (ScreenCaptureService.class) { frames.clear(); }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
