package site.blucaro.news;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Arrays;
import java.util.HashSet;

/**
 * Blucaro News para Android TV: un WebView a pantalla completa con la página en modo TV.
 * Los videos los reproduce el player oficial de YouTube dentro de la página; la app no
 * toca audio ni video. Las flechas y el OK del control llegan a la página como teclas.
 */
public class MainActivity extends Activity {
    private static final String HOST = "news.blucaro.site";
    private static final String HOME = "https://" + HOST + "/?tv=1";

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private TvReceiver receiver;
    private final Chrome chrome = new Chrome();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // En un celu o tablet, la app es el control remoto que transmite a la tele.
        if (!isTv()) {
            startActivity(new Intent(this, RemoteActivity.class));
            finish();
            return;
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(13, 17, 23));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(13, 17, 23));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // En la tele el OK activa el sonido de un panel: no exigir un toque en pantalla.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        // Script dentro del reproductor oficial de YouTube: elegir H.264 (lo más liviano para
        // la tele) y medir cuadros perdidos. Si el WebView de la tele no lo soporta, sigue sin él.
        boolean inject = injectYoutubeScript();
        // Recibir del celu: la tele se anuncia en el Wi-Fi y le cuenta a la página su IP.
        receiver = new TvReceiver(this, root, web, HOME);
        int recvPort = receiver.start();
        String ip = TvReceiver.localIp();
        String recv = recvPort > 0 ? " BNRecv/" + (ip != null ? ip : "0.0.0.0") + ":" + recvPort : "";
        s.setUserAgentString(s.getUserAgentString() + " BlucaroNewsTV/" + versionName() + (inject ? " BNInject/1" : "") + recv);

        web.setWebViewClient(new Client());
        web.setWebChromeClient(chrome);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        if (state != null) web.restoreState(state);
        else web.loadUrl(HOME);
        web.requestFocus();
    }

    private boolean injectYoutubeScript() {
        try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return false;
            InputStream in = getResources().openRawResource(R.raw.yt_inject);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            WebViewCompat.addDocumentStartJavaScript(web, out.toString("UTF-8"),
                new HashSet<String>(Arrays.asList("https://www.youtube.com", "https://www.youtube-nocookie.com")));
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private boolean isTv() {
        try {
            android.app.UiModeManager um = (android.app.UiModeManager) getSystemService(UI_MODE_SERVICE);
            if (um != null && um.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION) return true;
        } catch (Throwable ignored) { }
        PackageManager pm = getPackageManager();
        return pm.hasSystemFeature("android.software.leanback") || pm.hasSystemFeature("android.hardware.type.television");
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1";
        }
    }

    /** Links de afuera (notas de los medios) se abren en otra app si hay; si no, se ignoran. */
    private boolean handleUrl(Uri uri) {
        if (uri != null && HOST.equals(uri.getHost())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // En muchas teles no hay navegador: no hacer nada.
        }
        return true;
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return request.isForMainFrame() && handleUrl(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(Uri.parse(url));
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int code, String description, String failingUrl) {
            if (failingUrl != null && failingUrl.startsWith("https://" + HOST)) showOffline();
        }
    }

    private void showOffline() {
        String html = "<!doctype html><meta name=viewport content='width=device-width'>"
            + "<body style='background:#0d1117;color:#e6edf3;font:22px system-ui,sans-serif;display:grid;place-content:center;height:100vh;margin:0;text-align:center'>"
            + "<p style='font-size:30px;font-weight:700'>Sin conexión</p>"
            + "<p>Revisá que la tele esté conectada a Internet.</p>"
            + "<p><button autofocus onclick=\"location.href='" + HOME + "'\" "
            + "style='font:inherit;padding:12px 28px;border-radius:10px;border:4px solid #f2cc60;background:#21262d;color:#fff'>Reintentar</button></p>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /** Pantalla completa del reproductor de YouTube (botón ⛶ del player). */
    private class Chrome extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            root.removeView(customView);
            customView = null;
            web.setVisibility(View.VISIBLE);
            if (customCallback != null) customCallback.onCustomViewHidden();
            customCallback = null;
            web.requestFocus();
        }
    }

    @Override
    public void onBackPressed() {
        if (receiver != null && receiver.isReceiving()) {
            receiver.stopReceiving(true);
            return;
        }
        if (customView != null) {
            chrome.onHideCustomView();
            return;
        }
        // La página decide: si el foco no está en un panel, lo vuelve ahí; si ya está, salimos.
        web.evaluateJavascript("(window.bnBack ? window.bnBack() : false)", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (!"true".equals(value)) finish();
            }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        web.onPause(); // corta el audio al salir de la app
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onStop() {
        // Si salen de la app mientras recibe, se corta (y se le avisa al celu).
        if (receiver != null && receiver.isReceiving()) receiver.stopReceiving(true);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (receiver != null) receiver.stop();
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
