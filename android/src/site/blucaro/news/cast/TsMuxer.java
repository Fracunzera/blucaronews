package site.blucaro.news.cast;

import java.io.ByteArrayOutputStream;

/**
 * Muxer MPEG-TS mínimo para HLS: un programa con video H.264 (PID 0x100, lleva el PCR)
 * y, si hay, audio AAC con encabezado ADTS (PID 0x101). Java puro (sin Android) para
 * poder probarlo en la PC/servidor con ffmpeg.
 *
 * Los tiempos (pts) van en unidades de 90 kHz. No hay B-frames: DTS = PTS.
 */
public final class TsMuxer {
    public static final int PID_PMT = 0x1000;
    public static final int PID_VIDEO = 0x100;
    public static final int PID_AUDIO = 0x101;
    private static final int TS = 188;

    private final boolean hasAudio;
    private final int[] cc = new int[0x2000];

    public TsMuxer(boolean hasAudio) {
        this.hasAudio = hasAudio;
    }

    public boolean hasAudio() {
        return hasAudio;
    }

    // ---------------------------------------------------------------- PSI

    public void writePatPmt(ByteArrayOutputStream out) {
        // PAT: programa 1 -> PMT en PID_PMT
        byte[] pat = new byte[] {
            0x00, // table_id
            (byte) 0xB0, 0x0D, // section_syntax=1, '0', reserved, section_length=13
            0x00, 0x01, // transport_stream_id
            (byte) 0xC1, // reserved, version 0, current_next 1
            0x00, 0x00, // section_number, last_section_number
            0x00, 0x01, // program_number 1
            (byte) (0xE0 | (PID_PMT >> 8)), (byte) (PID_PMT & 0xFF),
        };
        writeSection(out, 0, pat);

        int streams = hasAudio ? 2 : 1;
        int sectionLength = 9 + 5 * streams + 4; // desde después de section_length hasta el CRC inclusive
        byte[] pmt = new byte[3 + sectionLength - 4];
        int i = 0;
        pmt[i++] = 0x02; // table_id
        pmt[i++] = (byte) (0xB0 | ((sectionLength >> 8) & 0x0F));
        pmt[i++] = (byte) (sectionLength & 0xFF);
        pmt[i++] = 0x00; pmt[i++] = 0x01; // program_number
        pmt[i++] = (byte) 0xC1;
        pmt[i++] = 0x00; pmt[i++] = 0x00;
        pmt[i++] = (byte) (0xE0 | (PID_VIDEO >> 8)); pmt[i++] = (byte) (PID_VIDEO & 0xFF); // PCR_PID
        pmt[i++] = (byte) 0xF0; pmt[i++] = 0x00; // program_info_length 0
        pmt[i++] = 0x1B; // H.264
        pmt[i++] = (byte) (0xE0 | (PID_VIDEO >> 8)); pmt[i++] = (byte) (PID_VIDEO & 0xFF);
        pmt[i++] = (byte) 0xF0; pmt[i++] = 0x00;
        if (hasAudio) {
            pmt[i++] = 0x0F; // AAC ADTS
            pmt[i++] = (byte) (0xE0 | (PID_AUDIO >> 8)); pmt[i++] = (byte) (PID_AUDIO & 0xFF);
            pmt[i++] = (byte) 0xF0; pmt[i++] = 0x00;
        }
        writeSection(out, PID_PMT, pmt);
    }

    private void writeSection(ByteArrayOutputStream out, int pid, byte[] section) {
        int crc = crc32(section, 0, section.length);
        byte[] pkt = new byte[TS];
        java.util.Arrays.fill(pkt, (byte) 0xFF);
        pkt[0] = 0x47;
        pkt[1] = (byte) (0x40 | ((pid >> 8) & 0x1F)); // payload_unit_start
        pkt[2] = (byte) (pid & 0xFF);
        pkt[3] = (byte) (0x10 | nextCc(pid)); // solo payload
        pkt[4] = 0x00; // pointer_field
        System.arraycopy(section, 0, pkt, 5, section.length);
        int p = 5 + section.length;
        pkt[p] = (byte) (crc >>> 24);
        pkt[p + 1] = (byte) (crc >>> 16);
        pkt[p + 2] = (byte) (crc >>> 8);
        pkt[p + 3] = (byte) crc;
        out.write(pkt, 0, TS);
    }

    // ---------------------------------------------------------------- PES

    /** Una unidad de acceso H.264 en formato Annex-B (con start codes, AUD/SPS/PPS incluidos). */
    public void writeVideo(ByteArrayOutputStream out, byte[] annexB, long pts90k, boolean key) {
        byte[] pes = pes(0xE0, annexB, pts90k, true);
        long pcr = Math.max(0, pts90k - 9000); // el PCR va un poco antes que el PTS
        packetize(out, PID_VIDEO, pes, pcr, key);
    }

    /** Un frame AAC con su encabezado ADTS de 7 bytes. */
    public void writeAudio(ByteArrayOutputStream out, byte[] adtsFrame, long pts90k) {
        if (!hasAudio) return;
        byte[] pes = pes(0xC0, adtsFrame, pts90k, false);
        packetize(out, PID_AUDIO, pes, -1, false);
    }

    private static byte[] pes(int streamId, byte[] payload, long pts, boolean video) {
        int headerData = 5; // solo PTS
        int pesPacketLength = 3 + headerData + payload.length;
        if (video || pesPacketLength > 0xFFFF) pesPacketLength = 0; // 0 = sin límite (válido en video)
        byte[] pes = new byte[9 + headerData + payload.length];
        pes[0] = 0x00; pes[1] = 0x00; pes[2] = 0x01;
        pes[3] = (byte) streamId;
        pes[4] = (byte) (pesPacketLength >> 8);
        pes[5] = (byte) pesPacketLength;
        pes[6] = (byte) (video ? 0x84 : 0x80); // '10', data_alignment en video
        pes[7] = (byte) 0x80; // PTS_DTS_flags = '10'
        pes[8] = (byte) headerData;
        writePts(pes, 9, pts);
        System.arraycopy(payload, 0, pes, 14, payload.length);
        return pes;
    }

    private static void writePts(byte[] b, int o, long pts) {
        pts &= 0x1FFFFFFFFL;
        b[o] = (byte) (0x21 | ((pts >> 29) & 0x0E));
        b[o + 1] = (byte) (pts >> 22);
        b[o + 2] = (byte) (0x01 | ((pts >> 14) & 0xFE));
        b[o + 3] = (byte) (pts >> 7);
        b[o + 4] = (byte) (0x01 | ((pts << 1) & 0xFE));
    }

    /**
     * Parte el PES en paquetes TS de 188 bytes. El primero lleva PCR (si pcr >= 0) y el
     * indicador de acceso aleatorio (keyframe). El último se completa con relleno en el
     * campo de adaptación (no se puede rellenar el payload).
     */
    private void packetize(ByteArrayOutputStream out, int pid, byte[] pes, long pcr, boolean randomAccess) {
        int pos = 0;
        boolean first = true;
        byte[] pkt = new byte[TS];
        while (pos < pes.length) {
            // Contenido del campo de adaptación (sin el byte de longitud): flags + PCR
            int afContent = 0;
            boolean wantAf = first && (pcr >= 0 || randomAccess);
            if (wantAf) afContent = 1 + (pcr >= 0 ? 6 : 0);
            int afTotal = wantAf ? 1 + afContent : 0; // + byte de longitud
            int space = TS - 4 - afTotal;
            int remaining = pes.length - pos;
            int stuffing = 0;
            if (remaining < space) {
                int need = space - remaining;
                if (!wantAf) {
                    // Hay que crear un campo de adaptación solo para rellenar.
                    wantAf = true;
                    if (need == 1) { afContent = 0; afTotal = 1; }
                    else { afContent = 1; stuffing = need - 2; afTotal = 1 + afContent + stuffing; }
                } else {
                    stuffing = need;
                    afTotal += stuffing;
                }
                space = TS - 4 - afTotal;
            }
            int payloadLen = Math.min(space, remaining);

            int i = 0;
            pkt[i++] = 0x47;
            pkt[i++] = (byte) ((first ? 0x40 : 0x00) | ((pid >> 8) & 0x1F));
            pkt[i++] = (byte) (pid & 0xFF);
            pkt[i++] = (byte) ((wantAf ? 0x30 : 0x10) | nextCc(pid));
            if (wantAf) {
                int afLen = afTotal - 1;
                pkt[i++] = (byte) afLen;
                if (afLen > 0) {
                    int flags = 0;
                    boolean withPcr = first && pcr >= 0;
                    if (first && randomAccess) flags |= 0x40;
                    if (withPcr) flags |= 0x10;
                    pkt[i++] = (byte) flags;
                    if (withPcr) {
                        long base = pcr & 0x1FFFFFFFFL;
                        pkt[i++] = (byte) (base >> 25);
                        pkt[i++] = (byte) (base >> 17);
                        pkt[i++] = (byte) (base >> 9);
                        pkt[i++] = (byte) (base >> 1);
                        pkt[i++] = (byte) (((base & 1) << 7) | 0x7E);
                        pkt[i++] = 0x00;
                    }
                    for (int s = 0; s < stuffing; s++) pkt[i++] = (byte) 0xFF;
                }
            }
            System.arraycopy(pes, pos, pkt, i, payloadLen);
            i += payloadLen;
            if (i != TS) throw new IllegalStateException("paquete TS de " + i + " bytes");
            out.write(pkt, 0, TS);
            pos += payloadLen;
            first = false;
        }
    }

    private int nextCc(int pid) {
        int v = cc[pid];
        cc[pid] = (v + 1) & 0x0F;
        return v;
    }

    // CRC-32/MPEG-2 (polinomio 0x04C11DB7, sin reflejar, inicial 0xFFFFFFFF)
    static int crc32(byte[] data, int off, int len) {
        int crc = 0xFFFFFFFF;
        for (int i = off; i < off + len; i++) {
            crc ^= (data[i] & 0xFF) << 24;
            for (int b = 0; b < 8; b++) crc = (crc & 0x80000000) != 0 ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
        }
        return crc;
    }

    /** Encabezado ADTS de 7 bytes para un frame AAC-LC de {@code aacLen} bytes. */
    public static byte[] adts(byte[] aac, int sampleRate, int channels) {
        int freqIdx = sampleRateIndex(sampleRate);
        int len = aac.length + 7;
        byte[] out = new byte[len];
        out[0] = (byte) 0xFF;
        out[1] = (byte) 0xF1; // MPEG-4, sin CRC
        out[2] = (byte) ((1 << 6) | (freqIdx << 2) | ((channels >> 2) & 1)); // perfil LC (2-1=1)
        out[3] = (byte) (((channels & 3) << 6) | ((len >> 11) & 0x03));
        out[4] = (byte) ((len >> 3) & 0xFF);
        out[5] = (byte) (((len & 7) << 5) | 0x1F);
        out[6] = (byte) 0xFC;
        System.arraycopy(aac, 0, out, 7, aac.length);
        return out;
    }

    static int sampleRateIndex(int rate) {
        int[] rates = {96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350};
        for (int i = 0; i < rates.length; i++) if (rates[i] == rate) return i;
        return 3;
    }
}
