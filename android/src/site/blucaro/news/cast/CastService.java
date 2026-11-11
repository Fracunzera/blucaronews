package site.blucaro.news.cast;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Presentation;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Surface;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;

/**
 * Transmisión celu -> tele. El celu arma la grilla de canales en una pantalla INVISIBLE
 * (VirtualDisplay + Presentation con un WebView, la forma soportada por Chromium para
 * dibujar un WebView fuera de pantalla), la codifica en un solo video H.264 720p, captura
 * el sonido (si hay permiso) y lo publica como HLS en el Wi-Fi de la casa. A la tele (la
 * app Blucaro News en modo TV) le avisa que lo reproduzca. Como no usa la pantalla del
 * celu, se puede salir de la app y seguir usándolo.
 */
public class CastService extends Service {
    public static final String ACTION_START = "site.blucaro.news.CAST_START";
    public static final String ACTION_STOP = "site.blucaro.news.CAST_STOP";
    public static final String SENDER_URL = "https://news.blucaro.site/?tv=1&sender=1";

    private static final int W = 1280, H = 720, DPI = 213; // 213 dpi => 960x540 px CSS, como la app de TV
    private static final int SAMPLE_RATE = 48000, CHANNELS = 2;
    private static final int NOTIF_ID = 7;
    private static final byte[] AUD = {0, 0, 0, 1, 9, (byte) 0xF0};

    public static volatile CastService instance;
    private static volatile String lastError = "";

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean running;
    private volatile String phase = "iniciando";
    private volatile String error = "";
    private volatile String audioState = "apagado";
    private volatile String tvName = "";
    private volatile String pageState = "null";
    private volatile long frames, audioFrames;
    private volatile int audioLevel;

    private HlsSegmenter hls;
    private HttpServer http;
    private int httpPort;
    private MediaCodec venc, aenc;
    private Surface inputSurface;
    private VirtualDisplay display;
    private Presentation presentation;
    private WebView web;
    private MediaProjection projection;
    private volatile AudioRecord recorder;
    // Sonido: primero solo el de esta app (los canales), así WhatsApp, Spotify, etc. no
    // van a la tele. Si en este celu no llega nada así, se pasa a todo el sonido multimedia.
    private volatile boolean appOnly;
    private volatile boolean heardApp;
    private long soundLiveSince;
    private Socket tvSocket;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private long baseUs;

    // ------------------------------------------------------------------ ciclo de vida

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopCast("");
            return START_NOT_STICKY;
        }
        if (running) teardown();
        final boolean wantAudio = intent.getBooleanExtra("audio", false) && Build.VERSION.SDK_INT >= 29
            && intent.getParcelableExtra("projection") != null;
        startForegroundCompat(wantAudio);
        instance = this;
        running = true;
        error = "";
        lastError = "";
        tvName = intent.getStringExtra("tvName");
        try {
            begin(intent, wantAudio);
        } catch (Throwable t) {
            fail("No se pudo empezar a transmitir: " + t);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopCast("");
        super.onDestroy();
    }

    private void begin(Intent intent, boolean wantAudio) throws Exception {
        baseUs = System.nanoTime() / 1000;
        acquireLocks();

        // 1) Audio primero (decide si el HLS lleva pista de audio).
        boolean audioOk = false;
        if (wantAudio) {
            try {
                MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                projection = mpm.getMediaProjection(intent.getIntExtra("resultCode", 0), (Intent) intent.getParcelableExtra("projection"));
                projection.registerCallback(new MediaProjection.Callback() {
                    @Override public void onStop() { audioState = "cortado por Android"; }
                }, main);
                startAudio();
                audioOk = true;
            } catch (Throwable t) {
                audioState = "no disponible (" + t.getClass().getSimpleName() + ")";
            }
        } else {
            audioState = Build.VERSION.SDK_INT >= 29 ? "apagado (el sonido sale del celu)" : "no soportado en este Android";
        }

        // 2) HLS + servidor HTTP.
        hls = new HlsSegmenter(audioOk);
        http = new HttpServer(hls);
        httpPort = http.start(8766);

        // 3) Codificador de video + pantalla virtual + página.
        startVideo();
        phase = "preparando";

        // 4) Avisarle a la tele cuando ya hay video.
        final String host = intent.getStringExtra("tvHost");
        final int port = intent.getIntExtra("tvPort", 8765);
        Thread t = new Thread(new Runnable() {
            @Override public void run() { talkToTv(host, port); }
        }, "bn-tv");
        t.setDaemon(true);
        t.start();

        // 5) Leer el estado de la página (canales, sonido) para el control remoto.
        main.postDelayed(pollPage, 1500);
    }

    // ------------------------------------------------------------------ video

    private void startVideo() throws Exception {
        venc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        try {
            venc.configure(videoFormat(true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        } catch (Throwable t) {
            // Algunos codificadores no aceptan perfil/nivel explícito: sin eso.
            venc.release();
            venc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            venc.configure(videoFormat(false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        }
        inputSurface = venc.createInputSurface();
        venc.start();

        Thread drain = new Thread(new Runnable() {
            @Override public void run() { drainVideo(); }
        }, "bn-venc");
        drain.start();

        DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        display = dm.createVirtualDisplay("blucaronews-tele", W, H, DPI, inputSurface, 0);

        // Presentation en la pantalla virtual (privada, de esta app) desde el servicio:
        // así sigue dibujando aunque la app no esté en primer plano.
        presentation = new Presentation(this, display.getDisplay());
        web = new WebView(presentation.getContext());
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " BlucaroNewsSender/" + versionName());
        web.setWebViewClient(new WebViewClient());
        web.setBackgroundColor(0xFF000000);
        presentation.setContentView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        presentation.show();
        web.loadUrl(SENDER_URL);
    }

    private static MediaFormat videoFormat(boolean withProfile) {
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, W, H);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
        // Si la imagen no cambia, repetir el último cuadro: el HLS necesita cuadros continuos.
        f.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
        if (Build.VERSION.SDK_INT >= 23) f.setInteger(MediaFormat.KEY_PRIORITY, 0);
        if (withProfile) {
            // Baseline: sin B-frames (DTS = PTS) y lo decodifica cualquier tele.
            f.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
            f.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31);
        }
        return f;
    }

    private void drainVideo() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        byte[] config = null;
        while (running) {
            int idx;
            try { idx = venc.dequeueOutputBuffer(info, 100_000); } catch (Throwable t) { break; }
            if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat of = venc.getOutputFormat();
                ByteBuffer c0 = of.getByteBuffer("csd-0"), c1 = of.getByteBuffer("csd-1");
                if (c0 != null) {
                    ByteArrayOutputStream b = new ByteArrayOutputStream();
                    writeNal(b, c0);
                    if (c1 != null) writeNal(b, c1);
                    config = b.toByteArray();
                }
                continue;
            }
            if (idx < 0) continue;
            try {
                ByteBuffer buf = venc.getOutputBuffer(idx);
                byte[] data = new byte[info.size];
                if (buf != null && info.size > 0) {
                    buf.position(info.offset);
                    buf.limit(info.offset + info.size);
                    buf.get(data);
                }
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                    config = annexB(data);
                } else if (info.size > 0) {
                    boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                    ByteArrayOutputStream au = new ByteArrayOutputStream(data.length + 64);
                    au.write(AUD, 0, AUD.length);
                    if (key && config != null) au.write(config, 0, config.length);
                    byte[] d = annexB(data);
                    au.write(d, 0, d.length);
                    hls.video(au.toByteArray(), to90k(info.presentationTimeUs), key);
                    frames++;
                }
            } catch (Throwable t) {
                // un cuadro malo no corta la transmisión
            } finally {
                try { venc.releaseOutputBuffer(idx, false); } catch (Throwable ignored) { }
            }
        }
    }

    private static void writeNal(ByteArrayOutputStream b, ByteBuffer bb) {
        ByteBuffer d = bb.duplicate();
        byte[] x = new byte[d.remaining()];
        d.get(x);
        x = annexB(x);
        b.write(x, 0, x.length);
    }

    /** Asegura start code al principio (casi todos los codificadores ya lo traen). */
    private static byte[] annexB(byte[] d) {
        if (d.length >= 4 && d[0] == 0 && d[1] == 0 && (d[2] == 1 || (d[2] == 0 && d[3] == 1))) return d;
        byte[] o = new byte[d.length + 4];
        o[3] = 1;
        System.arraycopy(d, 0, o, 4, d.length);
        return o;
    }

    private long to90k(long us) {
        return Math.max(0, us - baseUs) * 9 / 100 + 90_000;
    }

    // ------------------------------------------------------------------ audio

    private void startAudio() throws Exception {
        if (Build.VERSION.SDK_INT < 29) throw new IllegalStateException("Android < 10");
        recorder = buildRecorder(true);
        appOnly = true;
        heardApp = false;

        MediaFormat af = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, CHANNELS);
        af.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        af.setInteger(MediaFormat.KEY_BIT_RATE, 128_000);
        af.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        aenc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        aenc.configure(af, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        aenc.start();
        recorder.startRecording();
        audioState = "capturando (solo los canales)";

        Thread t = new Thread(new Runnable() {
            @Override public void run() { audioLoop(); }
        }, "bn-audio");
        t.start();
    }

    /** {@code onlyThisApp}: solo el sonido de esta app; si no, todo el sonido multimedia del celu. */
    private AudioRecord buildRecorder(boolean onlyThisApp) {
        AudioPlaybackCaptureConfiguration.Builder b = new AudioPlaybackCaptureConfiguration.Builder(projection);
        if (onlyThisApp) {
            b.addMatchingUid(android.os.Process.myUid());
        } else {
            b.addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .addMatchingUsage(AudioAttributes.USAGE_GAME);
        }
        AudioFormat fmt = new AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build();
        int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        return new AudioRecord.Builder()
            .setAudioFormat(fmt)
            .setBufferSizeInBytes(Math.max(min * 4, 4096 * 8))
            .setAudioPlaybackCaptureConfig(b.build())
            .build();
    }

    /**
     * Red de seguridad: si hay un canal con sonido y EN VIVO hace 12 s pero de "solo esta
     * app" no llegó nada, este celu atribuye el sonido de los videos a otro proceso: pasamos
     * a capturar todo el sonido multimedia (como antes) para que la tele no quede muda.
     */
    private void checkAudioFallback() {
        if (!appOnly || heardApp || recorder == null) { soundLiveSince = 0; return; }
        boolean live = false;
        try {
            Object v = new org.json.JSONTokener(pageState).nextValue();
            if (v instanceof JSONObject) {
                org.json.JSONArray ps = ((JSONObject) v).optJSONArray("panels");
                for (int i = 0; ps != null && i < ps.length(); i++) {
                    JSONObject p = ps.getJSONObject(i);
                    if (p.optBoolean("sound") && p.optString("status").contains("EN VIVO")) live = true;
                }
            }
        } catch (Throwable ignored) { }
        long now = System.currentTimeMillis();
        if (!live) { soundLiveSince = 0; return; }
        if (soundLiveSince == 0) { soundLiveSince = now; return; }
        if (now - soundLiveSince < 12_000) return;
        appOnly = false;
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    AudioRecord next = buildRecorder(false);
                    next.startRecording();
                    AudioRecord old = recorder;
                    recorder = next;
                    try { old.stop(); old.release(); } catch (Throwable ignored) { }
                    audioState = "capturando todo el sonido del celu (este celu no deja separar el de los canales)";
                } catch (Throwable t) {
                    audioState = "no disponible (" + t.getClass().getSimpleName() + ")";
                }
            }
        }, "bn-audio-amplio").start();
    }

    private void audioLoop() {
        final int chunk = 1024 * CHANNELS * 2; // 1024 muestras estéreo de 16 bits = un frame AAC
        byte[] pcm = new byte[chunk];
        long samples = 0;
        long startUs = -1;
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (running) {
            int n;
            AudioRecord r = recorder;
            if (r == null) break;
            try { n = r.read(pcm, 0, chunk); } catch (Throwable t) { if (r != recorder) continue; break; }
            if (n <= 0) continue;
            if (startUs < 0) startUs = System.nanoTime() / 1000 - 20_000;
            long ptsUs = startUs + samples * 1_000_000L / SAMPLE_RATE;
            samples += n / (CHANNELS * 2);
            // Nivel aproximado (para saber si llega sonido).
            int peak = 0;
            for (int i = 0; i + 1 < n; i += 64) {
                int v = (short) ((pcm[i] & 0xFF) | (pcm[i + 1] << 8));
                peak = Math.max(peak, Math.abs(v));
            }
            audioLevel = peak * 100 / 32768;
            if (appOnly && peak > 0) heardApp = true;
            try {
                int in = aenc.dequeueInputBuffer(10_000);
                if (in >= 0) {
                    ByteBuffer ib = aenc.getInputBuffer(in);
                    ib.clear();
                    int len = Math.min(n, ib.remaining());
                    ib.put(pcm, 0, len);
                    aenc.queueInputBuffer(in, 0, len, ptsUs, 0);
                }
                int out;
                while ((out = aenc.dequeueOutputBuffer(info, 0)) >= 0) {
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                        ByteBuffer ob = aenc.getOutputBuffer(out);
                        byte[] raw = new byte[info.size];
                        ob.position(info.offset);
                        ob.limit(info.offset + info.size);
                        ob.get(raw);
                        hls.audio(TsMuxer.adts(raw, SAMPLE_RATE, CHANNELS), to90k(info.presentationTimeUs));
                        audioFrames++;
                    }
                    aenc.releaseOutputBuffer(out, false);
                }
            } catch (Throwable t) {
                // seguir con el próximo bloque
            }
        }
    }

    // ------------------------------------------------------------------ la tele

    private void talkToTv(String host, int port) {
        // Esperar a tener un par de segmentos para que la tele arranque sin error.
        long until = System.currentTimeMillis() + 20_000;
        while (running && hls.ready() < 2 && System.currentTimeMillis() < until) sleep(200);
        if (!running) return;
        if (hls.ready() < 2) {
            fail("El celu no pudo generar el video (" + frames + " cuadros). Probá cerrar y volver a abrir la app.");
            return;
        }
        phase = "conectando con la tele";
        try {
            Socket s = new Socket();
            s.connect(new InetSocketAddress(host, port), 6000);
            s.setSoTimeout(20_000);
            tvSocket = s;
            String ip = s.getLocalAddress().getHostAddress();
            if (ip.contains(":")) { // IPv6: usar la IPv4 del celu en el Wi-Fi
                String v4 = site.blucaro.news.TvReceiver.localIp();
                if (v4 != null) ip = v4;
            }
            String url = "http://" + ip + ":" + httpPort + "/live.m3u8";
            OutputStream out = s.getOutputStream();
            JSONObject play = new JSONObject();
            play.put("cmd", "play");
            play.put("url", url);
            play.put("from", deviceName());
            send(out, play.toString());
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), "UTF-8"));
            phase = "transmitiendo";
            // Aviso periódico (la tele corta si no oye nada en 30 s).
            final OutputStream pingOut = out;
            Thread pinger = new Thread(new Runnable() {
                @Override public void run() {
                    while (running && tvSocket != null) {
                        sleep(5000);
                        try { send(pingOut, "{\"cmd\":\"ping\"}"); } catch (Throwable t) { return; }
                    }
                }
            }, "bn-ping");
            pinger.setDaemon(true);
            pinger.start();
            while (running) {
                String line = in.readLine();
                if (line == null) {
                    if (running) fail("La tele dejó de recibir (se cerró la app de la tele o se cortó el Wi-Fi).");
                    return;
                }
                if (line.contains("\"stopped\"")) {
                    if (running) stopCast("La tele dejó de recibir (apretaron Atrás en la tele).");
                    return;
                }
            }
        } catch (Throwable t) {
            if (running) fail("No se pudo conectar con la tele (" + host + "). ¿Está abierta la app Blucaro News en la tele y en el mismo Wi-Fi?");
        }
    }

    private static void send(OutputStream out, String line) throws Exception {
        synchronized (out) {
            out.write((line + "\n").getBytes("UTF-8"));
            out.flush();
        }
    }

    // ------------------------------------------------------------------ control remoto

    private final Runnable pollPage = new Runnable() {
        @Override public void run() {
            if (!running || web == null) return;
            try {
                web.evaluateJavascript("JSON.stringify(window.bnRemote ? window.bnRemote.getState() : null)", new ValueCallback<String>() {
                    @Override public void onReceiveValue(String v) {
                        try { pageState = v == null ? "null" : new org.json.JSONTokener(v).nextValue().toString(); }
                        catch (Throwable t) { pageState = "null"; }
                        checkAudioFallback();
                    }
                });
            } catch (Throwable ignored) { }
            main.postDelayed(this, 1500);
        }
    };

    /** Orden del control remoto (JSON) para la página de la grilla. */
    public void command(final String json) {
        final String safe;
        try { safe = new JSONObject(json).toString(); } catch (Throwable t) { return; }
        main.post(new Runnable() {
            @Override public void run() {
                if (web != null) web.evaluateJavascript("window.bnRemote && window.bnRemote.apply(" + safe + ")", null);
                main.removeCallbacks(pollPage);
                main.postDelayed(pollPage, 400);
            }
        });
    }

    public String statusJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("casting", running);
            o.put("phase", phase);
            o.put("error", error);
            o.put("tv", tvName == null ? "" : tvName);
            o.put("audio", audioState);
            o.put("audioLevel", audioLevel);
            o.put("frames", frames);
            o.put("audioFrames", audioFrames);
            o.put("segments", hls == null ? 0 : hls.ready());
            o.put("requests", http == null ? 0 : http.requests());
            o.put("page", new org.json.JSONTokener(pageState).nextValue());
            return o.toString();
        } catch (Throwable t) {
            return "{\"casting\":" + running + "}";
        }
    }

    public static String idleStatusJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("casting", false);
            o.put("error", lastError);
            return o.toString();
        } catch (Throwable t) {
            return "{\"casting\":false}";
        }
    }

    // ------------------------------------------------------------------ cierre

    private void fail(String msg) {
        error = msg;
        lastError = msg;
        phase = "error";
        main.post(new Runnable() { @Override public void run() { stopCast(error); } });
    }

    /** Corta la transmisión y cierra el servicio. */
    public synchronized void stopCast(String reason) {
        if (reason != null && !reason.isEmpty()) lastError = reason;
        teardown();
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Throwable ignored) { }
        stopSelf();
    }

    /** Libera todo (pantalla virtual, codificadores, audio, servidor, conexión con la tele). */
    private synchronized void teardown() {
        running = false;
        main.removeCallbacks(pollPage);
        final Socket s = tvSocket;
        tvSocket = null;
        if (s != null) {
            new Thread(new Runnable() {
                @Override public void run() {
                    try { send(s.getOutputStream(), "{\"cmd\":\"stop\"}"); } catch (Throwable ignored) { }
                    try { s.close(); } catch (Throwable ignored) { }
                }
            }).start();
        }
        try { if (presentation != null) presentation.dismiss(); } catch (Throwable ignored) { }
        presentation = null;
        try { if (web != null) web.destroy(); } catch (Throwable ignored) { }
        web = null;
        try { if (display != null) display.release(); } catch (Throwable ignored) { }
        display = null;
        try { if (venc != null) { venc.stop(); venc.release(); } } catch (Throwable ignored) { }
        venc = null;
        try { if (inputSurface != null) inputSurface.release(); } catch (Throwable ignored) { }
        inputSurface = null;
        try { if (recorder != null) { recorder.stop(); recorder.release(); } } catch (Throwable ignored) { }
        recorder = null;
        try { if (aenc != null) { aenc.stop(); aenc.release(); } } catch (Throwable ignored) { }
        aenc = null;
        try { if (projection != null) projection.stop(); } catch (Throwable ignored) { }
        projection = null;
        if (http != null) http.stop();
        http = null;
        releaseLocks();
        if (instance == this) instance = null;
    }

    // ------------------------------------------------------------------ utilidades

    private void startForegroundCompat(boolean projectionType) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel("cast", "Transmisión a la tele", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
            b = new Notification.Builder(this, "cast");
        } else {
            b = new Notification.Builder(this);
        }
        Intent stop = new Intent(this, CastService.class).setAction(ACTION_STOP);
        int piFlags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);
        Intent open = new Intent(this, site.blucaro.news.RemoteActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent openPi = PendingIntent.getActivity(this, 2, open, piFlags);
        b.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Transmitiendo a la tele")
            .setContentText("Blucaro News · tocá para ver el control remoto")
            .setContentIntent(openPi)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_pause, "Detener", stopPi).build());
        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= 29) {
            int type = projectionType ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            startForeground(NOTIF_ID, n, type);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "blucaronews:cast");
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        } catch (Throwable ignored) { }
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "blucaronews:cast");
            wifiLock.acquire();
        } catch (Throwable ignored) { }
    }

    private void releaseLocks() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Throwable ignored) { }
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Throwable ignored) { }
        wakeLock = null;
        wifiLock = null;
    }

    private String deviceName() {
        try {
            String n = Settings.Global.getString(getContentResolver(), "device_name");
            if (n != null && !n.isEmpty()) return n;
        } catch (Throwable ignored) { }
        return Build.MODEL;
    }

    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "1"; }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

}
