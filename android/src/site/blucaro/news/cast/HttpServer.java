package site.blucaro.news.cast;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.Charset;

/**
 * Servidor HTTP mínimo que publica el HLS en la red de la casa:
 *   GET /live.m3u8        lista en vivo
 *   GET /seg/N.ts         segmento N
 *   GET /status           texto corto para diagnóstico
 * Java puro (sin Android). Un hilo por conexión; la tele pide poco y seguido.
 */
public final class HttpServer {
    private static final Charset UTF8 = Charset.forName("UTF-8");

    private final HlsSegmenter hls;
    private ServerSocket server;
    private volatile boolean running;
    private volatile int requests;

    public HttpServer(HlsSegmenter hls) {
        this.hls = hls;
    }

    /** Arranca en {@code preferredPort}; si está ocupado, en uno libre. Devuelve el puerto. */
    public int start(int preferredPort) throws IOException {
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(preferredPort));
        } catch (IOException e) {
            server = new ServerSocket(0);
        }
        running = true;
        Thread t = new Thread(new Runnable() {
            @Override public void run() { acceptLoop(); }
        }, "bn-http");
        t.setDaemon(true);
        t.start();
        return server.getLocalPort();
    }

    public int requests() {
        return requests;
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) { }
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket s = server.accept();
                Thread t = new Thread(new Runnable() {
                    @Override public void run() { handle(s); }
                }, "bn-http-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (!running) return;
            }
        }
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(15000);
            s.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            // Varias peticiones por conexión (keep-alive), que es lo que hacen los reproductores.
            while (running) {
                String requestLine = readLine(in);
                if (requestLine == null || requestLine.isEmpty()) break;
                boolean keepAlive = true;
                String line;
                while ((line = readLine(in)) != null && !line.isEmpty()) {
                    String l = line.toLowerCase(java.util.Locale.US);
                    if (l.startsWith("connection:") && l.contains("close")) keepAlive = false;
                }
                String[] parts = requestLine.split(" ");
                String method = parts.length > 0 ? parts[0] : "";
                String path = parts.length > 1 ? parts[1] : "/";
                int q = path.indexOf('?');
                if (q >= 0) path = path.substring(0, q);
                requests++;
                respond(out, method, path, keepAlive);
                if (!keepAlive) break;
            }
        } catch (IOException ignored) {
            // la tele cerró la conexión
        } finally {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    private void respond(OutputStream out, String method, String path, boolean keepAlive) throws IOException {
        byte[] body;
        String type;
        int status = 200;
        if (path.equals("/live.m3u8")) {
            body = hls.playlist().getBytes(UTF8);
            type = "application/vnd.apple.mpegurl";
        } else if (path.startsWith("/seg/") && path.endsWith(".ts")) {
            byte[] seg = null;
            try { seg = hls.segment(Integer.parseInt(path.substring(5, path.length() - 3))); } catch (NumberFormatException ignored) { }
            if (seg == null) { status = 404; body = "no existe".getBytes(UTF8); type = "text/plain"; }
            else { body = seg; type = "video/mp2t"; }
        } else if (path.equals("/status")) {
            body = ("ok segmentos=" + hls.ready() + " pedidos=" + requests + "\n").getBytes(UTF8);
            type = "text/plain; charset=utf-8";
        } else {
            status = 404;
            body = "no existe".getBytes(UTF8);
            type = "text/plain";
        }
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(status == 200 ? " OK" : " Not Found").append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Cache-Control: no-cache\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Connection: ").append(keepAlive ? "keep-alive" : "close").append("\r\n\r\n");
        out.write(h.toString().getBytes(UTF8));
        if (!"HEAD".equals(method)) out.write(body);
        out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 8192) throw new IOException("línea demasiado larga");
        }
        if (c == -1 && sb.length() == 0) return null;
        return sb.toString();
    }
}
