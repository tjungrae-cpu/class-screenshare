package kr.hatban.screenshare;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final int REQ_CAPTURE = 11;
    private static final String LINK_CHANNEL = "link";

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (!CaptureService.running) return;
            web.evaluateJavascript("window.__hbTick&&window.__hbTick()", null);
            ui.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#F6F4EF"));

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " HatbanApp/1");
        // 다른 앱을 쓰는 동안에도 페이지가 계속 동작하도록
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        web.addJavascriptInterface(new Bridge(), "HatbanApp");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                request.grant(request.getResources());
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u.toString().startsWith(BuildConfig.BASE_URL)) return false;
                openExternal(u.toString());
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    view.loadDataWithBaseURL(null,
                        "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
                        "<div style='font-family:sans-serif;text-align:center;padding:60px 20px'>" +
                        "<h2>인터넷에 연결할 수 없어요</h2><p>와이파이를 확인한 뒤 다시 눌러 주세요.</p>" +
                        "<button style='font-size:18px;padding:12px 24px' onclick='HatbanApp.reload()'>다시 시도</button></div>",
                        "text/html", "utf-8", null);
                }
            }
        });

        CaptureService.onStopped = () -> ui.post(() -> {
            ui.removeCallbacks(ticker);
            web.evaluateJavascript("window.__hbCaptureStopped&&window.__hbCaptureStopped()", null);
        });

        loadStudentPage(getIntent());
    }

    private void loadStudentPage(Intent intent) {
        Uri.Builder b = Uri.parse(BuildConfig.BASE_URL + "student.html").buildUpon().appendQueryParameter("app", "1");
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && "hatbanshare".equals(data.getScheme())) {
            String code = data.getQueryParameter("code");
            String name = data.getQueryParameter("name");
            if (code != null) b.appendQueryParameter("code", code);
            if (name != null) b.appendQueryParameter("name", name);
        }
        web.loadUrl(b.build().toString());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // 공유 중이 아닐 때만 새 코드/이름으로 다시 연다
        if (intent.getData() != null && !CaptureService.running) loadStudentPage(intent);
    }

    private void requestCapture() {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 5);
        }
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_CAPTURE) return;
        if (resultCode == RESULT_OK && data != null) {
            Intent svc = new Intent(this, CaptureService.class)
                    .putExtra(CaptureService.EXTRA_CODE, resultCode)
                    .putExtra(CaptureService.EXTRA_DATA, data);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
            web.evaluateJavascript("window.__hbCapture&&window.__hbCapture(true)", null);
            ui.removeCallbacks(ticker);
            ui.postDelayed(ticker, 1500);
        } else {
            web.evaluateJavascript("window.__hbCapture&&window.__hbCapture(false)", null);
        }
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            Toast.makeText(this, "링크를 열 수 없어요", Toast.LENGTH_SHORT).show();
        }
    }

    private void showLinkNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(LINK_CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(LINK_CHANNEL, "선생님 링크", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, LINK_CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("선생님이 링크를 보냈어요")
                .setContentText(text)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        try { nm.notify(8, n); } catch (Exception ignored) {}
    }

    @Override
    public void onBackPressed() {
        if (CaptureService.running) { moveTaskToBack(true); return; }
        if (web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacks(ticker);
        CaptureService.onStopped = null;
        if (isFinishing()) stopService(new Intent(this, CaptureService.class));
        web.destroy();
        super.onDestroy();
    }

    /** 학생 페이지(student.html)에서 부르는 함수들 */
    private class Bridge {
        @JavascriptInterface public void startCapture() { ui.post(MainActivity.this::requestCapture); }
        @JavascriptInterface public void stopCapture() {
            ui.post(() -> {
                ui.removeCallbacks(ticker);
                stopService(new Intent(MainActivity.this, CaptureService.class));
            });
        }
        @JavascriptInterface public String getFrame() { return CaptureService.takeFrame(); }
        @JavascriptInterface public boolean isCapturing() { return CaptureService.running; }
        @JavascriptInterface public void openUrl(String url) {
            if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) ui.post(() -> openExternal(url));
        }
        @JavascriptInterface public void notify(String text) { ui.post(() -> showLinkNotification(text)); }
        @JavascriptInterface public void reload() { ui.post(() -> loadStudentPage(getIntent())); }
    }
}
