package tr.akts.claudevoice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

/**
 * Oyun öndeyken (Claude Ses arka plandayken) Android mikrofonu susturmasın diye
 * "microphone" türünde ön plan servisi. Kendisi kayıt yapmaz; sürecin mikrofon hakkını korur.
 */
public class MicService extends Service {
    private static volatile boolean running = false;

    static boolean isRunning() { return running; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("dinleme", "Sesli mod", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 1,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, "dinleme")
                .setContentTitle("Claude VR dinliyor")
                .setContentText("Oyundayken de seni duyar.")
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        try {
            startForeground(43, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            running = true;
        } catch (Exception e) {
            stopSelf();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
