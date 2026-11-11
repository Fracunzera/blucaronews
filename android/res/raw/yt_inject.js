// Corre al inicio de cada reproductor oficial de YouTube DENTRO de la app de TV
// (WebViewCompat.addDocumentStartJavaScript, solo en www.youtube.com / youtube-nocookie).
// No toca el video: (1) si el embed trae bn_codec=h264, le dice al reproductor que la tele
// no soporta VP8/VP9/AV1, así YouTube manda H.264, que es lo más liviano de decodificar
// (la misma técnica de la extensión "h264ify"); (2) cada 2 s le informa a la página qué
// códec y resolución recibe y cuántos cuadros se pierden, para el diagnóstico.
(function () {
  try {
    if (window.__bnInjected) return;
    window.__bnInjected = true;
    var mode = new URLSearchParams(location.search).get('bn_codec') || 'auto';
    var BLOCK = mode === 'h264' ? /vp0?8|vp0?9|vp09|av01|av1/i : null;
    var lastCodec = '';
    var MS = window.MediaSource;
    if (MS) {
      if (BLOCK && MS.isTypeSupported) {
        var its = MS.isTypeSupported.bind(MS);
        MS.isTypeSupported = function (t) { return BLOCK.test(String(t)) ? false : its(t); };
      }
      var asb = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (t) {
        if (/^video/i.test(String(t))) lastCodec = String(t);
        return asb.apply(this, arguments);
      };
    }
    if (BLOCK) {
      var cpt = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (t) { return BLOCK.test(String(t)) ? '' : cpt.apply(this, arguments); };
      var mc = navigator.mediaCapabilities;
      if (mc && mc.decodingInfo) {
        var di = mc.decodingInfo.bind(mc);
        mc.decodingInfo = function (c) {
          var ct = (c && c.video && c.video.contentType) || '';
          if (BLOCK.test(ct)) return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
          return di(c);
        };
      }
    }
    var prevDropped = 0, prevTotal = 0;
    setInterval(function () {
      var v = document.querySelector('video');
      if (!v || window.parent === window) return;
      var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      var dropped = q ? q.droppedVideoFrames : -1, total = q ? q.totalVideoFrames : -1;
      var m = /codecs="?([^",]+)/.exec(lastCodec);
      window.parent.postMessage({
        bn: 'diag', mode: mode, codec: m ? m[1] : '', w: v.videoWidth, h: v.videoHeight,
        dropped: dropped, total: total, dDropped: dropped - prevDropped, dTotal: total - prevTotal,
        paused: v.paused, ready: v.readyState,
      }, '*');
      prevDropped = dropped; prevTotal = total;
    }, 2000);
  } catch (e) { /* nunca romper el reproductor */ }
})();
