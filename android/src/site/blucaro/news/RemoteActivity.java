package site.blucaro.news;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;

import site.blucaro.news.cast.CastService;

/**
 * App en el celu: control remoto para mandar los canales a la tele. La interfaz es la
 * página /remote del sitio (se actualiza sin reinstalar); esta actividad le da el puente
 * "BNApp": buscar teles en el Wi-Fi, pedir permisos y arrancar/parar la transmisión.
 */
public class RemoteActivity extends Activity {
    private static final String URL = "https://news.blucaro.site/remote";
    private static final int REQ_PERMS = 11, REQ_PROJECTION = 12;

    private WebView web;
    private NsdManager nsd;
    private NsdManager.DiscoveryListener discovery;
    private WifiManager.MulticastLock multicast;
    private final Map<String, JSONObject> tvs = new LinkedHashMap<String, JSONObject>();
    private final ArrayDeque<NsdServiceInfo> toResolve = new ArrayDeque<NsdServiceInfo>();
    private boolean resolving;

    // Transmisión pedida, a la espera de permisos.
    private String castHost, castName;
    private int castPort;
    private boolean castAudio;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " BlucaroNewsRemote/" + versionName());
        web.setWebViewClient(new WebViewClient());
        web.setBackgroundColor(0xFF0D1117);
        web.addJavascriptInterface(new Bridge(), "BNApp");
        setContentView(web);
        web.loadUrl(URL);
        startDiscovery();
    }

    @Override
    protected void onDestroy() {
        stopDiscovery();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed(); // la transmisión sigue (servicio en primer plano)
    }

    // ------------------------------------------------------------------ puente con la página

    private class Bridge {
        @JavascriptInterface public String version() { return versionName(); }
        @JavascriptInterface public int sdk() { return Build.VERSION.SDK_INT; }

        @JavascriptInterface public String tvs() {
            JSONArray a = new JSONArray();
            synchronized (tvs) { for (JSONObject o : tvs.values()) a.put(o); }
            return a.toString();
        }

        @JavascriptInterface public void rescan() {
            runOnUiThread(new Runnable() { @Override public void run() {
                stopDiscovery();
                synchronized (tvs) { tvs.clear(); }
                startDiscovery();
            } });
        }

        @JavascriptInterface public void addTv(String ip) {
            if (ip == null || !ip.trim().matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) return;
            try {
                JSONObject o = new JSONObject();
                o.put("name", "Tele " + ip.trim());
                o.put("host", ip.trim());
                o.put("port", TvReceiver.DEFAULT_PORT);
                o.put("manual", true);
                synchronized (tvs) { tvs.put("ip:" + ip.trim(), o); }
            } catch (Exception ignored) { }
        }

        @JavascriptInterface public void cast(final String host, final int port, final String name, final boolean audio) {
            runOnUiThread(new Runnable() { @Override public void run() { beginCast(host, port, name, audio); } });
        }

        @JavascriptInterface public void stop() {
            startService(new Intent(RemoteActivity.this, CastService.class).setAction(CastService.ACTION_STOP));
        }

        @JavascriptInterface public String status() {
            CastService c = CastService.instance;
            return c != null ? c.statusJson() : CastService.idleStatusJson();
        }

        @JavascriptInterface public void send(String json) {
            CastService c = CastService.instance;
            if (c != null) c.command(json);
        }
    }

    // ------------------------------------------------------------------ permisos y arranque

    private void beginCast(String host, int port, String name, boolean audio) {
        castHost = host;
        castPort = port;
        castName = name;
        castAudio = audio && Build.VERSION.SDK_INT >= 29;
        java.util.ArrayList<String> ask = new java.util.ArrayList<String>();
        if (castAudio && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ask.add(android.Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            ask.add("android.permission.POST_NOTIFICATIONS");
        }
        if (!ask.isEmpty()) requestPermissions(ask.toArray(new String[0]), REQ_PERMS);
        else afterPermissions();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_PERMS) return;
        afterPermissions();
    }

    private void afterPermissions() {
        boolean canAudio = castAudio && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (canAudio) {
            // Android pide confirmar la captura (es para el sonido; el video no sale de la pantalla).
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION);
        } else {
            startCast(0, null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_PROJECTION) return;
        if (resultCode == RESULT_OK && data != null) startCast(resultCode, data);
        else startCast(0, null); // sin sonido en la tele
    }

    private void startCast(int resultCode, Intent projection) {
        Intent i = new Intent(this, CastService.class).setAction(CastService.ACTION_START);
        i.putExtra("tvHost", castHost);
        i.putExtra("tvPort", castPort);
        i.putExtra("tvName", castName);
        i.putExtra("audio", projection != null);
        i.putExtra("resultCode", resultCode);
        if (projection != null) i.putExtra("projection", projection);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
    }

    // ------------------------------------------------------------------ buscar teles (mDNS)

    private void startDiscovery() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            multicast = wm.createMulticastLock("blucaronews");
            multicast.setReferenceCounted(false);
            multicast.acquire();
        } catch (Throwable ignored) { }
        try {
            nsd = (NsdManager) getSystemService(NSD_SERVICE);
            discovery = new NsdManager.DiscoveryListener() {
                @Override public void onStartDiscoveryFailed(String t, int code) { }
                @Override public void onStopDiscoveryFailed(String t, int code) { }
                @Override public void onDiscoveryStarted(String t) { }
                @Override public void onDiscoveryStopped(String t) { }
                @Override public void onServiceFound(NsdServiceInfo si) { queueResolve(si); }
                @Override public void onServiceLost(NsdServiceInfo si) {
                    synchronized (tvs) { tvs.remove("nsd:" + si.getServiceName()); }
                }
            };
            nsd.discoverServices(TvReceiver.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
        } catch (Throwable ignored) { }
    }

    private void stopDiscovery() {
        try { if (nsd != null && discovery != null) nsd.stopServiceDiscovery(discovery); } catch (Throwable ignored) { }
        discovery = null;
        try { if (multicast != null && multicast.isHeld()) multicast.release(); } catch (Throwable ignored) { }
    }

    // NsdManager resuelve de a uno por vez.
    private void queueResolve(NsdServiceInfo si) {
        synchronized (toResolve) {
            toResolve.add(si);
            if (resolving) return;
            resolving = true;
        }
        resolveNext();
    }

    @SuppressWarnings("deprecation")
    private void resolveNext() {
        final NsdServiceInfo next;
        synchronized (toResolve) {
            next = toResolve.poll();
            if (next == null) { resolving = false; return; }
        }
        try {
            nsd.resolveService(next, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo si, int code) { resolveNext(); }
                @Override public void onServiceResolved(NsdServiceInfo si) {
                    try {
                        JSONObject o = new JSONObject();
                        String n = si.getServiceName();
                        o.put("name", n.startsWith("Blucaro News · ") ? n.substring("Blucaro News · ".length()) : n);
                        o.put("host", ipv4Of(si));
                        o.put("port", si.getPort());
                        synchronized (tvs) { tvs.put("nsd:" + n, o); }
                    } catch (Exception ignored) { }
                    resolveNext();
                }
            });
        } catch (Throwable t) {
            resolveNext();
        }
    }

    /** La IPv4 de la tele si la hay (con IPv6 el link del video no anda en todas las teles). */
    @SuppressWarnings("deprecation")
    private static String ipv4Of(NsdServiceInfo si) {
        java.net.InetAddress h = si.getHost();
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                for (java.net.InetAddress a : si.getHostAddresses()) {
                    if (a instanceof java.net.Inet4Address) return a.getHostAddress();
                }
            } catch (Throwable ignored) { }
        }
        return h.getHostAddress();
    }

    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "1"; }
    }
}
