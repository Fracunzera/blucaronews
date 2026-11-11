// Corre al inicio de cada reproductor oficial de YouTube en la pantalla INVISIBLE del celu
// (transmisión celu -> tele; WebViewCompat.addDocumentStartJavaScript, solo youtube.com).
// Toma el sonido del <video> con Web Audio y se lo pasa a la app (objeto bnAudio, de
// WebViewCompat.addWebMessageListener) para mandarlo a la tele. Como el sonido se desvía
// al grafo de audio y no se conecta a los parlantes, el celu queda en silencio. Solo manda
// el canal que tiene el sonido activado (el resto está silenciado por el reproductor).
(function () {
  try {
    if (window.__bnTap) return;
    window.__bnTap = true;
    var bridge = window.bnAudio;
    if (!bridge || !window.AudioContext) return;
    var ctx = null;
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;

    function send(L, R) {
      var n = L.length;
      var pcm = new Int16Array(n * 2);
      for (var i = 0; i < n; i++) {
        var l = L[i], r = R[i];
        pcm[2 * i] = l <= -1 ? -32768 : l >= 1 ? 32767 : (l * 32767) | 0;
        pcm[2 * i + 1] = r <= -1 ? -32768 : r >= 1 ? 32767 : (r * 32767) | 0;
      }
      var bytes = new Uint8Array(pcm.buffer);
      var s = '';
      for (var j = 0; j < bytes.length; j += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
      bridge.postMessage(btoa(s));
    }

    function attach(v) {
      if (!seen || seen.has(v)) return;
      seen.add(v);
      try {
        if (!ctx) ctx = new AudioContext({ sampleRate: 48000 });
        var src = ctx.createMediaElementSource(v);
        var sp = ctx.createScriptProcessor(4096, 2, 2);
        sp.onaudioprocess = function (e) {
          // La salida queda en cero: el sonido no sale por el celu.
          if (v.paused || v.muted || v.volume === 0) return;
          var b = e.inputBuffer;
          var L = b.getChannelData(0);
          var R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
          send(L, R);
        };
        src.connect(sp);
        sp.connect(ctx.destination);
      } catch (err) {
        try { bridge.postMessage('error:' + (err && err.name)); } catch (e2) { /* nada */ }
      }
    }

    setInterval(function () {
      var vs = document.getElementsByTagName('video');
      for (var i = 0; i < vs.length; i++) attach(vs[i]);
      if (ctx && ctx.state !== 'running') ctx.resume();
    }, 1000);
  } catch (e) { /* nunca romper el reproductor */ }
})();
