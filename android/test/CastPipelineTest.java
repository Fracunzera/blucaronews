import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import site.blucaro.news.cast.HlsSegmenter;
import site.blucaro.news.cast.HttpServer;
import site.blucaro.news.cast.TsMuxer;

/**
 * Prueba del muxer/segmentador/servidor HLS en la JVM (sin Android) con H.264 y AAC reales
 * generados por ffmpeg, armados igual que los entrega MediaCodec en el celu:
 *  - video: unidades de acceso Annex-B (AUD + SPS/PPS en los keyframes + slices)
 *  - audio: frames AAC "crudos" (sin ADTS); el muxer les agrega el ADTS.
 *
 *   java CastPipelineTest files <video.h264> <audio.aac> <dir>
 *   java CastPipelineTest live  <video.h264> <audio.aac> <puerto> <segundos>
 */
public class CastPipelineTest {
    static final class Frame { final byte[] data; final long pts; final boolean key; final boolean video;
        Frame(byte[] d, long p, boolean k, boolean v) { data = d; pts = p; key = k; video = v; } }

    public static void main(String[] a) throws Exception {
        List<Frame> frames = load(new File(a[1]), new File(a[2]));
        if (a[0].equals("files")) files(frames, new File(a[3]));
        else live(frames, Integer.parseInt(a[3]), Integer.parseInt(a[4]));
    }

    static List<Frame> load(File h264, File aac) throws Exception {
        byte[] v = Files.readAllBytes(h264.toPath());
        // Partir en NALs por start code y agrupar en unidades de acceso por AUD (tipo 9).
        List<int[]> nals = new ArrayList<int[]>();
        int i = 0, start = -1;
        while (i + 3 < v.length) {
            boolean sc3 = v[i] == 0 && v[i + 1] == 0 && v[i + 2] == 1;
            boolean sc4 = v[i] == 0 && v[i + 1] == 0 && v[i + 2] == 0 && v[i + 3] == 1;
            if (sc3 || sc4) { if (start >= 0) nals.add(new int[]{start, i}); start = i; i += sc4 ? 4 : 3; }
            else i++;
        }
        nals.add(new int[]{start, v.length});
        List<Frame> out = new ArrayList<Frame>();
        ByteArrayOutputStream au = null;
        boolean key = false;
        int n = 0;
        for (int[] r : nals) {
            int hdr = v[r[0] + 2] == 1 ? r[0] + 3 : r[0] + 4;
            int type = v[hdr] & 0x1F;
            if (type == 9 && au != null) { out.add(new Frame(au.toByteArray(), 90000 + n * 3000L, key, true)); n++; au = null; key = false; }
            if (au == null) au = new ByteArrayOutputStream();
            au.write(v, r[0], r[1] - r[0]);
            if (type == 5) key = true;
        }
        if (au != null) out.add(new Frame(au.toByteArray(), 90000 + n * 3000L, key, true));
        int videoFrames = out.size();

        byte[] s = Files.readAllBytes(aac.toPath());
        int p = 0, k = 0;
        while (p + 7 <= s.length) {
            int len = ((s[p + 3] & 0x03) << 11) | ((s[p + 4] & 0xFF) << 3) | ((s[p + 5] & 0xE0) >> 5);
            int hl = (s[p + 1] & 1) == 1 ? 7 : 9;
            byte[] raw = new byte[len - hl];
            System.arraycopy(s, p + hl, raw, 0, raw.length);
            out.add(new Frame(raw, 90000 + k * 1920L, false, false)); // 1024 muestras a 48 kHz
            k++;
            p += len;
        }
        out.sort((x, y) -> Long.compare(x.pts, y.pts));
        System.out.println("video " + videoFrames + " frames, audio " + k + " frames");
        return out;
    }

    static void feed(HlsSegmenter hls, Frame f, long offset) {
        if (f.video) hls.video(f.data, f.pts + offset, f.key);
        else hls.audio(TsMuxer.adts(f.data, 48000, 2), f.pts + offset);
    }

    static void files(List<Frame> frames, File dir) throws Exception {
        HlsSegmenter hls = new HlsSegmenter(true);
        for (Frame f : frames) feed(hls, f, 0);
        dir.mkdirs();
        String pl = hls.playlist();
        Files.write(new File(dir, "live.m3u8").toPath(), pl.getBytes("UTF-8"));
        new File(dir, "seg").mkdirs();
        for (String line : pl.split("\n")) {
            if (!line.startsWith("seg/")) continue;
            int seq = Integer.parseInt(line.substring(4, line.length() - 3));
            try (FileOutputStream o = new FileOutputStream(new File(dir, line))) { o.write(hls.segment(seq)); }
        }
        System.out.print(pl);
    }

    static void live(List<Frame> frames, int port, int seconds) throws Exception {
        HlsSegmenter hls = new HlsSegmenter(true);
        HttpServer http = new HttpServer(hls);
        int real = http.start(port);
        System.out.println("http://127.0.0.1:" + real + "/live.m3u8");
        long t0 = System.nanoTime();
        long loopLen = frames.get(frames.size() - 1).pts - 90000 + 3000;
        long offset = 0;
        outer:
        while (true) {
            for (Frame f : frames) {
                long due = (f.pts + offset - 90000) * 1_000_000_000L / 90000;
                long wait = due - (System.nanoTime() - t0);
                if (wait > 0) Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000));
                feed(hls, f, offset);
                if ((System.nanoTime() - t0) / 1_000_000_000L >= seconds) break outer;
            }
            offset += loopLen;
        }
        System.out.println("fin, pedidos HTTP: " + http.requests());
        http.stop();
    }
}
