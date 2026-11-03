package kr.hatban.screenshare;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/** 화면을 1초마다 캡처해 JPEG(base64)로 보관하는 포그라운드 서비스 */
public class CaptureService extends Service {
    public static final String EXTRA_CODE = "resultCode";
    public static final String EXTRA_DATA = "resultData";
    public static final String ACTION_STOP = "kr.hatban.screenshare.STOP";
    private static final String CHANNEL = "capture";
    private static final int NOTI_ID = 7;
    private static final int MAX_SIDE = 1024;      // 긴 변 최대 픽셀
    private static final int JPEG_QUALITY = 55;
    private static final long INTERVAL_MS = 1000;
    private static final long RESEND_MS = 4000;    // 화면 변화가 없어도 이 간격마다 다시 보냄

    // ---- 액티비티와 공유하는 상태 ----
    public static volatile boolean running = false;
    private static volatile String latestFrame = null;
    private static volatile long frameSeq = 0;
    private static long lastTakenSeq = -1;
    private static long lastTakenAt = 0;
    public static volatile Runnable onStopped = null;

    /** 새 화면이 있거나 일정 시간이 지났으면 프레임을 돌려줌. 아니면 null */
    public static synchronized String takeFrame() {
        String f = latestFrame;
        if (f == null) return null;
        long now = System.currentTimeMillis();
        if (frameSeq != lastTakenSeq || now - lastTakenAt > RESEND_MS) {
            lastTakenSeq = frameSeq;
            lastTakenAt = now;
            return f;
        }
        return null;
    }

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private Handler handler;
    private int width, height, dpi;
    private Bitmap scratch;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        if (ACTION_STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }

        startForegroundCompat();

        int code = intent.getIntExtra(EXTRA_CODE, 0);
        Intent data = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(EXTRA_DATA, Intent.class)
                : intent.getParcelableExtra(EXTRA_DATA);
        if (data == null || projection != null) return START_NOT_STICKY;

        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = mpm.getMediaProjection(code, data);
        if (projection == null) { stopSelf(); return START_NOT_STICKY; }

        thread = new HandlerThread("capture");
        thread.start();
        handler = new Handler(thread.getLooper());

        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { stopSelf(); }
        }, handler);

        computeSize();
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        display = projection.createVirtualDisplay("hatban-share", width, height, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);

        running = true;
        latestFrame = null;
        handler.postDelayed(tick, 500);
        return START_NOT_STICKY;
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!running) return;
            grab();
            handler.postDelayed(this, INTERVAL_MS);
        }
    };

    private void grab() {
        Image img = null;
        try {
            img = reader.acquireLatestImage();
            if (img == null) return;              // 화면 변화 없음 → 이전 프레임 유지
            Image.Plane plane = img.getPlanes()[0];
            ByteBuffer buf = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            int w = img.getWidth(), h = img.getHeight();
            int bmpW = rowStride / pixelStride;
            if (scratch == null || scratch.getWidth() != bmpW || scratch.getHeight() != h) {
                if (scratch != null) scratch.recycle();
                scratch = Bitmap.createBitmap(bmpW, h, Bitmap.Config.ARGB_8888);
            }
            buf.rewind();
            scratch.copyPixelsFromBuffer(buf);
            Bitmap out = bmpW == w ? scratch : Bitmap.createBitmap(scratch, 0, 0, w, h);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(80 * 1024);
            out.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, bos);
            if (out != scratch) out.recycle();
            latestFrame = "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            frameSeq++;
        } catch (Throwable t) {
            // 회전 중 등 일시적 오류는 무시
        } finally {
            if (img != null) img.close();
        }
    }

    private void computeSize() {
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        int rw, rh;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Rect b = wm.getMaximumWindowMetrics().getBounds();
            rw = b.width(); rh = b.height();
        } else {
            DisplayMetrics m = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(m);
            rw = m.widthPixels; rh = m.heightPixels;
        }
        dpi = getResources().getDisplayMetrics().densityDpi;
        float scale = Math.min(1f, (float) MAX_SIDE / Math.max(rw, rh));
        width = Math.max(2, Math.round(rw * scale) & ~1);
        height = Math.max(2, Math.round(rh * scale) & ~1);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (display == null || handler == null) return;
        handler.post(() -> {
            int ow = width, oh = height;
            computeSize();
            if (ow == width && oh == height) return;
            ImageReader old = reader;
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            display.resize(width, height, dpi);
            display.setSurface(reader.getSurface());
            if (old != null) old.close();
        });
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "화면 공유", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent piOpen = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, CaptureService.class).setAction(ACTION_STOP);
        PendingIntent piStop = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("내 화면 공유 중")
                .setContentText("선생님이 보고 있습니다")
                .setOngoing(true)
                .setContentIntent(piOpen)
                .addAction(new Notification.Action.Builder(null, "공유 끝내기", piStop).build())
                .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTI_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTI_ID, n);
        }
    }

    @Override
    public void onDestroy() {
        boolean wasRunning = running;
        running = false;
        latestFrame = null;
        try { if (display != null) display.release(); } catch (Throwable ignored) {}
        try { if (reader != null) reader.close(); } catch (Throwable ignored) {}
        try { if (projection != null) projection.stop(); } catch (Throwable ignored) {}
        if (thread != null) thread.quitSafely();
        display = null; reader = null; projection = null;
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        Runnable r = onStopped;
        if (wasRunning && r != null) r.run();
        super.onDestroy();
    }
}
