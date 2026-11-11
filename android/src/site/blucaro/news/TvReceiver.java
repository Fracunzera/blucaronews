package site.blucaro.news;

import android.app.Activity;
import android.graphics.Color;
import android.media.MediaPlayer;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.VideoView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Collections;

/**
 * Modo "recibir del celu" de la app de TV. Se anuncia en el Wi-Fi (NSD/mDNS, tipo
 * _blucaronews._tcp) y escucha órdenes del celu en un puerto TCP:
 *   {"cmd":"play","url":"http://IP-del-celu:puerto/live.m3u8","from":"Pixel 7"}
 *   {"cmd":"stop"}   {"cmd":"ping"}
 * Para reproducir, libera el WebView (y con él el decodificador de la tele) y muestra
 * un VideoView con el HLS que arma el celu: la tele decodifica UN solo video.
 */
public class TvReceiver {
    public static final String SERVICE_TYPE = "_blucaronews._tcp";
    public static final int DEFAULT_PORT = 8765;

    private final Activity activity;
    private final FrameLayout root;
    private final WebView web;
    private final String home;
    private final Handler main = new Handler(Looper.getMainLooper());

    private ServerSocket server;
    private int port = -1;
    private volatile boolean running;
    private NsdManager nsd;
    private NsdManager.RegistrationListener registration;

    private VideoView video;
    private TextView banner;
    private boolean receiving;
    private String url;
    private int errors;
    private volatile OutputStream phone; // conexión del celu que está transmitiendo

    public TvReceiver(Activity activity, FrameLayout root, WebView web, String home) {
        this.activity = activity;
        this.root = root;
        this.web = web;
        this.home = home;
    }

    /** Abre el puerto y se anuncia en la red. Devuelve el puerto (o -1 si no pudo). */
    public int start() {
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            try { server.bind(new InetSocketAddress(DEFAULT_PORT)); }
            catch (Exception e) { server = new ServerSocket(0); }
            port = server.getLocalPort();
        } catch (Exception e) {
            return -1;
        }
        running = true;
        Thread t = new Thread(new Runnable() {
            @Override public void run() { acceptLoop(); }
        }, "bn-recv");
        t.setDaemon(true);
        t.start();
        register();
        return port;
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        try { if (nsd != null && registration != null) nsd.unregisterService(registration); } catch (Exception ignored) { }
        registration = null;
        if (receiving) stopReceiving(true);
    }

    public boolean isReceiving() {
        return receiving;
    }

    private void register() {
        try {
            nsd = (NsdManager) activity.getSystemService(Activity.NSD_SERVICE);
            NsdServiceInfo info = new NsdServiceInfo();
            info.setServiceName("Blucaro News · " + deviceName());
            info.setServiceType(SERVICE_TYPE);
            info.setPort(port);
            registration = new NsdManager.RegistrationListener() {
                @Override public void onRegistrationFailed(NsdServiceInfo s, int code) { }
                @Override public void onUnregistrationFailed(NsdServiceInfo s, int code) { }
                @Override public void onServiceRegistered(NsdServiceInfo s) { }
                @Override public void onServiceUnregistered(NsdServiceInfo s) { }
            };
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
        } catch (Throwable ignored) {
            // Sin mDNS igual se puede conectar escribiendo la IP en el celu.
        }
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket s = server.accept();
                Thread t = new Thread(new Runnable() {
                    @Override public void run() { handle(s); }
                }, "bn-recv-conn");
                t.setDaemon(true);
                t.start();
            } catch (Exception e) {
                if (!running) return;
            }
        }
    }

    private void handle(Socket s) {
        OutputStream out = null;
        try {
            s.setSoTimeout(30_000);
            out = s.getOutputStream();
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), "UTF-8"));
            String peer = s.getInetAddress().getHostAddress();
            String line;
            while (running && (line = in.readLine()) != null) {
                JSONObject cmd;
                try { cmd = new JSONObject(line); } catch (Exception e) { continue; }
                String c = cmd.optString("cmd");
                if ("play".equals(c)) {
                    final String u = cmd.optString("url");
                    final String from = cmd.optString("from", "el celu");
                    // Solo video de la red de la casa (el celu que manda la orden o una IP privada).
                    if (!isLanUrl(u, peer)) { reply(out, "{\"ok\":false,\"error\":\"url\"}"); continue; }
                    phone = out;
                    main.post(new Runnable() { @Override public void run() { startReceiving(u, from); } });
                    reply(out, "{\"ok\":true}");
                } else if ("stop".equals(c)) {
                    if (phone == out) {
                        phone = null;
                        main.post(new Runnable() { @Override public void run() { stopReceiving(false); } });
                    }
                    reply(out, "{\"ok\":true}");
                } else if ("ping".equals(c)) {
                    reply(out, "{\"pong\":true}");
                }
            }
        } catch (Exception ignored) {
            // se cortó la conexión
        } finally {
            if (out != null && phone == out) {
                phone = null;
                // El celu dejó de hablar: si el video también se corta, volvemos a la grilla.
                main.postDelayed(new Runnable() { @Override public void run() { if (receiving && errors > 0) stopReceiving(false); } }, 8000);
            }
            try { s.close(); } catch (Exception ignored) { }
        }
    }

    static boolean isLanUrl(String u, String peer) {
        if (u == null || !u.startsWith("http://")) return false;
        if (u.startsWith("http://" + peer + ":")) return true;
        String host = u.substring(7);
        int colon = host.indexOf(':');
        if (colon < 0) return false;
        host = host.substring(0, colon);
        if (!host.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) return false;
        String[] p = host.split("\\.");
        int a = Integer.parseInt(p[0]), b = Integer.parseInt(p[1]);
        return a == 10 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31);
    }

    private static void reply(OutputStream out, String line) throws Exception {
        synchronized (out) {
            out.write((line + "\n").getBytes("UTF-8"));
            out.flush();
        }
    }

    // ------------------------------------------------------------------ reproducción

    private void startReceiving(String u, String from) {
        url = u;
        errors = 0;
        if (!receiving) {
            receiving = true;
            // Libera los reproductores de YouTube (y el decodificador de la tele).
            web.loadUrl("about:blank");
            web.setVisibility(View.GONE);
            video = new VideoView(activity);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER);
            root.addView(video, lp);
            banner = new TextView(activity);
            banner.setTextColor(Color.WHITE);
            banner.setTextSize(20);
            banner.setBackgroundColor(0xCC000000);
            banner.setPadding(28, 16, 28, 16);
            FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
            bp.setMargins(32, 32, 32, 32);
            root.addView(banner, bp);
            video.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override public void onPrepared(MediaPlayer mp) {
                    errors = 0;
                    video.start();
                    hideBannerLater();
                }
            });
            video.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override public boolean onError(MediaPlayer mp, int what, int extra) {
                    retry("Reconectando con el celu…");
                    return true;
                }
            });
            video.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override public void onCompletion(MediaPlayer mp) { retry("Reconectando con el celu…"); }
            });
        }
        showBanner("📱 Recibiendo de " + from + " · Atrás para volver");
        video.setVideoURI(Uri.parse(url));
    }

    private void retry(String msg) {
        if (!receiving) return;
        errors++;
        if (errors > 6) {
            stopReceiving(true);
            return;
        }
        showBanner(msg);
        main.postDelayed(new Runnable() {
            @Override public void run() { if (receiving && video != null) video.setVideoURI(Uri.parse(url)); }
        }, 2000);
    }

    private void showBanner(String text) {
        if (banner == null) return;
        banner.setText(text);
        banner.setVisibility(View.VISIBLE);
    }

    private void hideBannerLater() {
        main.postDelayed(new Runnable() {
            @Override public void run() { if (banner != null) banner.setVisibility(View.GONE); }
        }, 6000);
    }

    /** Vuelve a la grilla normal de la app. {@code tellPhone}: avisarle al celu que corte. */
    public void stopReceiving(boolean tellPhone) {
        if (!receiving) return;
        receiving = false;
        main.removeCallbacksAndMessages(null);
        try { if (video != null) video.stopPlayback(); } catch (Exception ignored) { }
        if (video != null) root.removeView(video);
        if (banner != null) root.removeView(banner);
        video = null;
        banner = null;
        web.setVisibility(View.VISIBLE);
        web.loadUrl(home);
        web.requestFocus();
        final OutputStream out = phone;
        phone = null;
        if (tellPhone && out != null) {
            new Thread(new Runnable() {
                @Override public void run() { try { reply(out, "{\"event\":\"stopped\"}"); } catch (Exception ignored) { } }
            }).start();
        }
    }

    // ------------------------------------------------------------------ utilidades

    private String deviceName() {
        try {
            String n = Settings.Global.getString(activity.getContentResolver(), "device_name");
            if (n != null && !n.isEmpty()) return n;
        } catch (Throwable ignored) { }
        return Build.MODEL;
    }

    /** IPv4 de la tele en la red de la casa (para mostrarla si hay que escribirla a mano). */
    public static String localIp() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) return a.getHostAddress();
                }
            }
        } catch (Throwable ignored) { }
        return null;
    }
}
