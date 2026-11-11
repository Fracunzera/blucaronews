package site.blucaro.news.cast;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * Arma un HLS en vivo en memoria: corta un segmento nuevo en cada keyframe cuando el
 * actual ya dura al menos {@code SEGMENT_SECONDS}. Guarda los últimos segmentos y genera
 * la lista .m3u8. Java puro (sin Android) para poder probarlo con ffmpeg.
 */
public final class HlsSegmenter {
    private static final long SEGMENT_90K = 90_000; // ~1 s por segmento
    private static final int KEEP = 10;               // segmentos guardados
    private static final int LIST = 4;                // segmentos en la lista

    public static final class Segment {
        final int seq;
        final byte[] data;
        final double seconds;
        Segment(int seq, byte[] data, double seconds) { this.seq = seq; this.data = data; this.seconds = seconds; }
    }

    private final TsMuxer mux;
    private final ArrayDeque<Segment> done = new ArrayDeque<Segment>();
    private ByteArrayOutputStream cur;
    private long curStart = -1;
    private long lastVideoPts = -1;
    private int nextSeq = 0;
    private int targetDuration = 2;

    public HlsSegmenter(boolean hasAudio) {
        this.mux = new TsMuxer(hasAudio);
    }

    public synchronized void video(byte[] accessUnit, long pts90k, boolean key) {
        if (key && (cur == null || pts90k - curStart >= SEGMENT_90K)) cut(pts90k);
        if (cur == null) return; // esperamos el primer keyframe
        mux.writeVideo(cur, accessUnit, pts90k, key);
        lastVideoPts = pts90k;
    }

    public synchronized void audio(byte[] adtsFrame, long pts90k) {
        if (cur == null) return;
        mux.writeAudio(cur, adtsFrame, pts90k);
    }

    private void cut(long pts90k) {
        if (cur != null) {
            double secs = Math.max(0.1, (pts90k - curStart) / 90000.0);
            done.addLast(new Segment(nextSeq++, cur.toByteArray(), secs));
            targetDuration = Math.max(targetDuration, (int) Math.ceil(secs));
            while (done.size() > KEEP) done.removeFirst();
        }
        cur = new ByteArrayOutputStream(512 * 1024);
        mux.writePatPmt(cur);
        curStart = pts90k;
    }

    /** Cantidad de segmentos completos (para no avisarle a la tele antes de tiempo). */
    public synchronized int ready() {
        return done.size();
    }

    public synchronized String playlist() {
        StringBuilder sb = new StringBuilder();
        int skip = Math.max(0, done.size() - LIST);
        int first = -1;
        StringBuilder items = new StringBuilder();
        int i = 0;
        for (Iterator<Segment> it = done.iterator(); it.hasNext(); i++) {
            Segment s = it.next();
            if (i < skip) continue;
            if (first < 0) first = s.seq;
            items.append("#EXTINF:").append(String.format(java.util.Locale.US, "%.3f", s.seconds)).append(",\n");
            items.append("seg/").append(s.seq).append(".ts\n");
        }
        sb.append("#EXTM3U\n");
        sb.append("#EXT-X-VERSION:3\n");
        sb.append("#EXT-X-TARGETDURATION:").append(targetDuration).append('\n');
        sb.append("#EXT-X-MEDIA-SEQUENCE:").append(Math.max(first, 0)).append('\n');
        sb.append(items);
        return sb.toString();
    }

    public synchronized byte[] segment(int seq) {
        for (Segment s : done) if (s.seq == seq) return s.data;
        return null;
    }
}
