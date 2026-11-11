// Blucaro News — frontend sin dependencias.
// Las señales se cargan SIEMPRE con el reproductor oficial del medio (iframe de
// YouTube/Twitch/radio o el stream que publica la radio). Este sitio no las toca.
'use strict';

(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const STORE_KEY = 'bn.layout.v1';
  const MOBILE = window.matchMedia('(max-width: 820px)');
  const ART = 'America/Argentina/Buenos_Aires';
  // Modo TV: se activa solo en navegadores de tele / la app de Android TV, o con ?tv=1
  // (?tv=0 lo apaga). Se recuerda en el navegador.
  const TV_UA = /SmartTV|SMART-TV|Tizen|Web0S|WebOS|NetCast|HbbTV|BRAVIA|\bAFT[A-Z]|Android TV|GoogleTV|CrKey|Roku|VIDAA|TV Safari|AppleTV|Viera|PhilipsTV|Opera TV|BlucaroNewsTV/i;
  const APP_TV = /BlucaroNewsTV/.test(navigator.userAgent);
  // La app de TV (desde la versión con BNInject) corre un script dentro del reproductor de
  // YouTube que puede pedirle H.264 (lo más liviano para la tele) y medir cuadros perdidos.
  const INJECT = /BNInject\/1/.test(navigator.userAgent);

  const store = {
    get(k, def) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? def : JSON.parse(v);
      } catch { return def; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado / bloqueado */ }
    },
  };

  const TV = (() => {
    const q = new URLSearchParams(location.search).get('tv');
    if (APP_TV) return true;
    if (q != null) { store.set('bn.tv', q !== '0'); return q !== '0'; }
    const saved = store.get('bn.tv', null);
    return saved == null ? TV_UA.test(navigator.userAgent) : Boolean(saved);
  })();
  const singleColumn = () => MOBILE.matches && !TV;

  // Rendimiento en la tele: la idea es ver 4 canales EN MOVIMIENTO a la vez.
  // Muchas teles tienen UN solo decodificador de video por hardware. En el WebView de
  // Android, H.264 solo se decodifica por hardware (no hay H.264 por software), mientras
  // que VP9 sí tiene decodificador por software. Por eso, en modo "mixto":
  //   - el panel 1 pide H.264 y arranca primero: se queda con el decodificador de la tele;
  //   - los otros 3 piden el formato automático (VP9) en baja resolución: van por software.
  // Como en los sistemas de cámaras: el principal con buena calidad, los demás livianos.
  // Si igual se traba, se baja la calidad un escalón y se recuerda en esa tele.
  const QUALITY = [
    { main: 960, sound: 640, other: 430, label: 'normal (principal ≈480p, resto ≈240p)' },
    { main: 640, sound: 430, other: 256, label: 'baja (principal ≈360p, resto ≈144p)' },
    { main: 430, sound: 256, other: 256, label: 'mínima (≈240p / 144p)' },
  ];
  const CODECS = ['mixto', 'h264', 'auto'];
  const tvPerf = {
    level: Math.min(QUALITY.length - 1, Math.max(0, Number(store.get('bn.tv.quality', 0)) || 0)),
    struggles: [],
    lastChange: 0,
    codec: CODECS.includes(store.get('bn.tv.codec2', 'mixto')) ? store.get('bn.tv.codec2', 'mixto') : 'mixto',
  };
  // Formato que pide cada panel (lo lee el script de la app de TV dentro del reproductor).
  const isMain = (p) => tvPerf.codec === 'mixto' && p.index === 0 && panelCount() > 1;
  const codecFor = (p) => (tvPerf.codec === 'mixto' ? (p.index === 0 ? 'h264' : 'auto') : tvPerf.codec);

  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null));

  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) n.append(c);
    return n;
  };

  const fmtTime = (ts) => new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ART }).format(ts);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
  }

  async function api(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ======================================================================
  // Estado de la grilla (URL > localStorage > por defecto)
  // ======================================================================

  let catalog = { categories: {}, channels: [], youtube: null };
  let byId = new Map();
  const state = { g: 2, c: [] };

  function readState() {
    const p = new URLSearchParams(location.search);
    const saved = store.get(STORE_KEY, null);
    // App de TV: arranca con 2 canales lado a lado ('d'); 4 es opcional, con aviso.
    const raw = p.get('g') || (APP_TV ? store.get('bn.tv.g', 'd') : saved?.g) || (TV ? 1 : 2);
    state.g = raw === 'd' ? 'd' : [1, 2, 3].includes(Number(raw)) ? Number(raw) : 2;
    if (state.g === 'd' && !APP_TV) state.g = 2;
    // En la tele, más de 4 reproductores a la vez traban el equipo.
    if (TV && state.g === 3) state.g = 2;
    const fromUrl = p.get('c');
    state.c = fromUrl != null ? fromUrl.split(',').map((s) => s.trim().slice(0, 40)) : Array.isArray(saved?.c) ? saved.c : [];
  }

  // Cantidad de paneles y forma de la grilla ('d' = 2 lado a lado).
  function panelCount() { return singleColumn() ? 1 : state.g === 'd' ? 2 : state.g * state.g; }
  function gridShape() { return singleColumn() ? [1, 1] : state.g === 'd' ? [2, 1] : [state.g, state.g]; }

  function defaults() {
    // Completa los paneles sin asignar con canales que todavía no estén en la grilla.
    const free = catalog.channels.map((c) => c.id).filter((id) => !state.c.includes(id));
    for (let i = 0; i < 9; i++) if (state.c[i] == null) state.c[i] = free.shift() || '';
  }

  function shareUrl() {
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('g', String(state.g));
    u.searchParams.set('c', state.c.slice(0, panelCount()).join(','));
    return u.toString();
  }

  function persist() {
    if (APP_TV) store.set('bn.tv.g', state.g);
    else store.set(STORE_KEY, { g: state.g, c: state.c.slice(0, 9) });
    if (APP_TV) store.set(STORE_KEY, { ...(store.get(STORE_KEY, {}) || {}), c: state.c.slice(0, 9) });
    try { history.replaceState(null, '', shareUrl()); } catch { /* ignorar */ }
  }

  // ======================================================================
  // Reproductores (embeds oficiales)
  // ======================================================================

  let ytApi = null;
  function loadYouTubeApi() {
    if (ytApi) return ytApi;
    ytApi = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => { ytApi = null; reject(new Error('No se pudo cargar la API de YouTube')); };
      document.head.append(s);
    });
    return ytApi;
  }

  const YT_ERRORS = {
    2: 'Parámetros inválidos.',
    5: 'El navegador no puede reproducir este video.',
    100: 'El canal no está transmitiendo en vivo ahora o el video no existe.',
    101: 'No está en vivo ahora o el medio no permite verlo fuera de YouTube.',
    150: 'No está en vivo ahora o el medio no permite verlo fuera de YouTube.',
    152: 'YouTube rechazó el reproductor insertado.',
    153: 'YouTube rechazó el reproductor insertado (falta el referer).',
  };

  const panels = []; // { index, root, body, status, select, destroy }

  function setStatus(p, state, label) {
    const icons = { live: '●', ok: '▶', loading: '◌', error: '⚠', offline: '○', empty: '–', idle: '▶' };
    p.status.dataset.state = state;
    p.status.replaceChildren(el('span', { class: 'dot', 'aria-hidden': 'true', text: icons[state] || '' }), ` ${label}`);
  }

  function showFallback(p, title, detail) {
    teardown(p);
    setStatus(p, 'error', 'Sin señal');
    p.body.replaceChildren(
      el('div', { class: 'fallback', role: 'group', 'aria-label': `Panel ${p.index + 1}: ${title}` },
        el('div', { class: 'title' }, el('span', { 'aria-hidden': 'true', text: '⚠ ' }), title),
        detail ? el('div', { class: 'detail', text: detail }) : null,
        TV ? el('div', { class: 'detail', text: 'OK = reintentar · ▲ = cambiar de canal' }) : null,
        el('button', { type: 'button', class: 'btn', onclick: () => mount(p) }, el('span', { 'aria-hidden': 'true', text: '↻ ' }), 'Reintentar'),
      ),
    );
  }

  // Sonido por panel: todo arranca silenciado (los navegadores solo permiten autoplay así).
  // OK en la tele, o el botón 🔇/🔊, lo activa o lo silencia. El volumen es el de la tele.
  function applyMute(p) {
    const muted = p.muted !== false;
    p.muteBtn.setAttribute('aria-pressed', String(!muted));
    p.muteBtn.setAttribute('aria-label', `${muted ? 'Activar' : 'Silenciar'} sonido del panel ${p.index + 1}`);
    p.muteBtn.title = muted ? 'Activar sonido' : 'Silenciar';
    p.muteBtn.firstChild.textContent = muted ? '🔇' : '🔊';
    p.root.classList.toggle('unmuted', !muted);
    if (TV) applyLite(p);
    try {
      if (p.player && p.player.unMute) {
        if (muted) p.player.mute();
        else { p.player.unMute(); p.player.setVolume(100); p.player.playVideo(); }
      }
      const a = $('audio', p.body);
      if (a) { a.muted = muted; if (!muted && a.paused) a.play().catch(() => {}); }
    } catch { /* el player todavía no está listo: se aplica en onReady */ }
  }

  function toggleMute(p) {
    p.muted = p.muted === false;
    applyMute(p);
    const ch = byId.get(state.c[p.index]);
    if (ch && (ch.type === 'twitch' || ch.type === 'iframe')) toast('Este reproductor maneja el sonido por su cuenta');
    else toast(p.muted ? `🔇 Panel ${p.index + 1} silenciado` : `🔊 Sonido: ${ch ? ch.name : `panel ${p.index + 1}`}`);
  }

  function teardown(p) {
    clearTimeout(p.timer);
    clearTimeout(p.retryTimer);
    p.mode = null;
    p.onFirstPlay = null;
    if (p.player && p.player.destroy) { try { p.player.destroy(); } catch { /* ignorar */ } }
    p.player = null;
    p.body.replaceChildren();
  }

  function frame(src, title, allow) {
    return el('iframe', {
      src,
      title,
      allow: allow || 'autoplay; encrypted-media; picture-in-picture; fullscreen',
      allowfullscreen: true,
      tabindex: '-1', // el foco queda en nuestro panel (control remoto)
      referrerpolicy: 'strict-origin-when-cross-origin',
      loading: 'lazy',
    });
  }

  // Calidad liviana en la tele: YouTube elige la resolución según el tamaño en píxeles
  // del reproductor (ya no deja forzarla). Dibujamos el iframe más chico y lo agrandamos
  // con CSS: YouTube ve un player chico y manda menos resolución (≈360p con 4 canales,
  // ≈720p con 1), que la tele decodifica mucho más fácil. En pantalla ocupa lo mismo.
  function liteScale(p) {
    if (!TV) return 1;
    const r = p.body.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Ancho en px reales que queremos que vea YouTube: 1 canal ≈720p; con 4, el principal
    // (hardware) más, el que suena un poco más y el resto lo mínimo razonable.
    const q = QUALITY[tvPerf.level];
    const n = panelCount();
    const target = n === 1 ? 1280 : isMain(p) ? q.main : n === 2 ? q.sound : p.muted === false && tvPerf.codec !== 'mixto' ? q.sound : q.other;
    return Math.max(1, Math.min(4, (r.width * dpr) / target));
  }

  function applyLite(p) {
    const f = $('iframe', p.body);
    if (!f) return;
    const k = liteScale(p);
    p.body.style.setProperty('--lite', String(k));
    f.classList.toggle('lite', k > 1.05);
  }

  // Se traba: pausas solas o cortes (vuelve a "cargando" después de haber arrancado).
  // 4 problemas en 30 s => calidad un escalón más baja (con 30 s de espera entre cambios,
  // porque al cambiar de calidad el reproductor recarga un momento).
  function struggle(p, kind) {
    const now = Date.now();
    if (kind === 'pause') p.pauseCount = (p.pauseCount || 0) + 1;
    else p.stallCount = (p.stallCount || 0) + 1;
    tvPerf.struggles = tvPerf.struggles.filter((t) => now - t < 30_000);
    tvPerf.struggles.push(now);
    // App de TV con más de un canal: si se traban seguido, esa tele no da para varios
    // videos juntos (bajar la calidad no lo arregla y entra en un ciclo). Pasamos a 1.
    if (APP_TV && panelCount() > 1) {
      if (tvPerf.struggles.length >= 4) { tvPerf.struggles = []; fallbackToOne(); }
      return;
    }
    if (tvPerf.struggles.length >= 4 && tvPerf.level < QUALITY.length - 1 && now - tvPerf.lastChange > 30_000) {
      tvPerf.struggles = [];
      tvPerf.lastChange = now;
      tvPerf.level++;
      store.set('bn.tv.quality', tvPerf.level);
      panels.forEach(applyLite);
      syncQualityBtn();
      toast(`La tele se estaba trabando: bajé la calidad a ${QUALITY[tvPerf.level].label}.`);
    }
    if (kind !== 'pause') return;
    // Reintento tranquilo y limitado: como mucho 1 cada 6 s por panel y 5 por minuto.
    p.retries = (p.retries || []).filter((t) => now - t < 60_000);
    if (p.retries.length >= 5) return;
    clearTimeout(p.retryTimer);
    p.retryTimer = setTimeout(() => {
      p.retries.push(Date.now());
      try { if (p.player && p.player.getPlayerState() === 2) p.player.playVideo(); } catch {}
    }, 6000);
  }

  function syncQualityBtn() {
    const b = $('#tv-quality');
    if (b) b.textContent = `⚙ Calidad: ${['normal', 'baja', 'mínima'][tvPerf.level]}`;
  }

  // Datos del script de la app de TV dentro de cada reproductor (códec, resolución, cuadros).
  window.addEventListener('message', (e) => {
    if (!/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.bn !== 'diag') return;
    const p = panels.find((q) => { const f = $('iframe', q.body); return f && f.contentWindow === e.source; });
    if (p) p.yt = d;
  });

  // Qué formatos puede decodificar la tele por hardware (powerEfficient) o solo por software.
  async function showDecoderCaps() {
    const box = el('div', { class: 'diag diag-caps', text: 'Probando decodificadores…' });
    document.body.append(box);
    const mc = navigator.mediaCapabilities;
    if (!mc || !mc.decodingInfo) { box.textContent = 'Este WebView no informa decodificadores.'; return; }
    const CODECS_TEST = [['H.264', 'video/mp4; codecs="avc1.4d401e"'], ['VP9', 'video/webm; codecs="vp09.00.21.08"'], ['AV1', 'video/mp4; codecs="av01.0.04M.08"']];
    const out = [];
    for (const [name, contentType] of CODECS_TEST) {
      try {
        const r = await mc.decodingInfo({ type: 'media-source', video: { contentType, width: 640, height: 360, bitrate: 800000, framerate: 30 } });
        out.push(`${name}: ${!r.supported ? 'no' : r.powerEfficient ? 'por HARDWARE' : 'por software'}${r.supported && !r.smooth ? ' (lento)' : ''}`);
      } catch { out.push(`${name}: ?`); }
    }
    box.textContent = `Decodificadores de la tele (360p) → ${out.join(' · ')}`;
  }

  // Diagnóstico en pantalla: qué calidad manda YouTube a cada panel y cuántas pausas tuvo.
  let diagTimer = null;
  function toggleDiag() {
    const on = !document.body.classList.contains('tv-diag');
    document.body.classList.toggle('tv-diag', on);
    clearInterval(diagTimer);
    document.querySelectorAll('.diag').forEach((n) => n.remove());
    if (!on) return;
    showDecoderCaps();
    const STATES = { '-1': 'sin iniciar', 0: 'terminó', 1: 'reproduciendo', 2: 'PAUSADO', 3: 'cargando', 5: 'en cola' };
    const tick = () => panels.forEach((p) => {
      let box = $('.diag', p.root);
      if (!box) { box = el('div', { class: 'diag' }); p.root.append(box); }
      let q = '—', st = '—', fr = '—';
      try { q = p.player.getPlaybackQuality(); st = STATES[p.player.getPlayerState()] || p.player.getPlayerState(); fr = (p.player.getVideoLoadedFraction() * 100).toFixed(0) + '%'; } catch {}
      const f = $('iframe', p.body);
      const px = f ? `${Math.round(f.offsetWidth * (window.devicePixelRatio || 1))}px` : '—';
      let extra = '';
      if (p.yt) {
        const y = p.yt;
        const lost = y.dTotal > 0 ? Math.round((100 * Math.max(0, y.dDropped)) / y.dTotal) : 0;
        extra = `\n${y.codec || '?'} ${y.w}x${y.h} · cuadros perdidos ${lost}% (total ${y.total > 0 ? Math.round((100 * y.dropped) / y.total) : 0}%)`;
      }
      const role = INJECT ? `${isMain(p) ? 'PRINCIPAL' : 'panel'} pide ${codecFor(p)} · ` : '';
      box.textContent = `${role}${st} · calidad ${q} · player ${px} · pausas ${p.pauseCount || 0} · cortes ${p.stallCount || 0}${extra}`;
    });
    tick();
    diagTimer = setInterval(tick, 2000);
    const chrome = (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1] || '?';
    toast(`Diagnóstico: WebView ${chrome} · ventana ${innerWidth}x${innerHeight} · densidad ${devicePixelRatio} · calidad ${['normal', 'baja', 'mínima'][tvPerf.level]}${INJECT ? ` · formato ${tvPerf.codec}` : ' · app vieja (sin medición de cuadros)'}`);
  }

  function mountYouTube(p, ch) {
    const live = catalog.youtube && catalog.youtube.status && catalog.youtube.status[ch.source];
    if (live && live.live === false) {
      setStatus(p, 'offline', 'Sin vivo ahora');
      fill(p.body,
        el('div', { class: 'fallback' },
          el('div', { class: 'title' }, el('span', { 'aria-hidden': 'true', text: '○ ' }), 'Sin transmisión en vivo ahora'),
          el('div', { class: 'detail', text: `${ch.name} no está transmitiendo en este momento.` }),
          el('button', { type: 'button', class: 'btn', onclick: () => mount(p, { force: true }) }, el('span', { 'aria-hidden': 'true', text: '↻ ' }), 'Reintentar'),
        ),
      );
      if (!p.force) return;
    }
    if (live && live.live && live.embeddable === false) {
      return showFallback(p, 'Señal no disponible', 'El medio no permite incrustar este vivo.');
    }
    const params = new URLSearchParams({
      autoplay: '1', mute: '1', playsinline: '1', rel: '0', enablejsapi: '1', origin: location.origin,
    });
    if (TV) { params.set('controls', '0'); params.set('disablekb', '1'); params.set('fs', '0'); params.set('iv_load_policy', '3'); }
    if (INJECT) params.set('bn_codec', codecFor(p)); // lo lee el script de la app de TV
    p.everPlayed = false;
    const src = live && live.videoId
      ? `https://www.youtube.com/embed/${encodeURIComponent(live.videoId)}?${params}`
      : `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(ch.source)}&${params}`;
    const f = frame(src, `${ch.name} — reproductor oficial de YouTube`);
    p.mode = 'video';
    f.removeAttribute('loading');
    p.body.replaceChildren(f);
    applyLite(p);
    setStatus(p, 'loading', 'Conectando…');

    p.timer = setTimeout(() => showFallback(p, 'Señal no disponible', 'El reproductor no respondió a tiempo.'), 25000);

    loadYouTubeApi().then((YT) => {
      if (!f.isConnected) return;
      p.player = new YT.Player(f, {
        events: {
          onReady: () => {
            clearTimeout(p.timer);
            setStatus(p, 'idle', 'Listo');
            if (p.muted === false) applyMute(p);
          },
          onStateChange: (e) => {
            clearTimeout(p.timer);
            if (e.data === YT.PlayerState.PLAYING) {
              setStatus(p, 'live', 'EN VIVO');
              p.everPlayed = true;
              if (p.onFirstPlay) { const go = p.onFirstPlay; p.onFirstPlay = null; go(); }
            } else if (e.data === YT.PlayerState.BUFFERING) {
              setStatus(p, 'loading', 'Cargando…');
              if (TV && p.everPlayed) struggle(p, 'stall');
            }
            else if (e.data === YT.PlayerState.PAUSED) {
              setStatus(p, 'idle', 'En pausa');
              // En la tele nadie pausa a propósito (no hay mouse): si pasa seguido es que la
              // tele no da para tantos videos juntos. NO se reanuda en loop (se pelearían).
              if (TV) struggle(p, 'pause');
            }
            else if (e.data === YT.PlayerState.ENDED) setStatus(p, 'offline', 'Transmisión terminada');
          },
          onError: (e) => showFallback(p, 'Señal no disponible', `${YT_ERRORS[e.data] || 'Error del reproductor.'} (código ${e.data})`),
        },
      });
    }).catch(() => {
      // Sin la API igual se ve el player oficial; solo perdemos el estado detallado.
      clearTimeout(p.timer);
      setStatus(p, 'idle', 'Player cargado');
    });
  }

  function mountIframe(p, src, title) {
    const f = frame(src, title);
    let loaded = false;
    f.addEventListener('load', () => {
      loaded = true;
      clearTimeout(p.timer);
      setStatus(p, 'ok', 'Player cargado');
    });
    p.body.replaceChildren(f);
    setStatus(p, 'loading', 'Conectando…');
    p.timer = setTimeout(() => { if (!loaded) showFallback(p, 'Señal no disponible', 'El reproductor no cargó.'); }, 25000);
  }

  function mountAudio(p, ch) {
    const a = el('audio', { controls: true, preload: 'none', src: ch.source, tabindex: '-1' });
    a.muted = p.muted !== false;
    a.addEventListener('playing', () => setStatus(p, 'live', 'Sonando'));
    a.addEventListener('pause', () => setStatus(p, 'idle', 'En pausa'));
    a.addEventListener('waiting', () => setStatus(p, 'loading', 'Cargando…'));
    a.addEventListener('error', () => showFallback(p, 'Señal no disponible', 'La radio no responde en este momento.'));
    p.body.replaceChildren(
      el('div', { class: 'audio-card' }, el('div', { class: 'big', 'aria-hidden': 'true', text: '📻' }), el('strong', { text: ch.name }), el('span', { class: 'muted', text: TV ? 'Apretá OK para escuchar' : 'Tocá ▶ o 🔇 para escuchar' })),
      a,
    );
    setStatus(p, 'idle', 'Listo');
  }

  function mount(p, opts = {}) {
    teardown(p);
    p.force = Boolean(opts.force);
    const id = state.c[p.index];
    const ch = byId.get(id);
    p.select.value = ch ? id : '';
    if (!ch) {
      setStatus(p, 'empty', 'Vacío');
      p.body.replaceChildren(el('div', { class: 'fallback' },
        el('div', { class: 'title', text: id ? 'Canal no disponible' : 'Elegí un canal' }),
        el('div', { class: 'detail', text: id ? 'Este canal ya no está en el catálogo.' : 'Usá el selector de arriba.' })));
      return;
    }
    try {
      if (ch.type === 'youtube') mountYouTube(p, ch);
      else if (ch.type === 'twitch') {
        const q = new URLSearchParams({ channel: ch.source, parent: location.hostname, muted: 'true', autoplay: 'true' });
        mountIframe(p, `https://player.twitch.tv/?${q}`, `${ch.name} — reproductor oficial de Twitch`);
      } else if (ch.type === 'iframe') mountIframe(p, ch.source, `${ch.name} — reproductor oficial`);
      else if (ch.type === 'audio') mountAudio(p, ch);
      else showFallback(p, 'Señal no disponible', 'Tipo de canal desconocido.');
    } catch (err) {
      showFallback(p, 'Señal no disponible', String(err.message || err));
    }
  }

  function channelSelect(index) {
    const s = el('select', { id: `sel-${index}`, 'aria-label': `Canal del panel ${index + 1}` });
    s.append(el('option', { value: '', text: '— Elegí un canal —' }));
    const groups = {};
    for (const ch of catalog.channels) (groups[ch.category] ||= []).push(ch);
    for (const [cat, label] of Object.entries(catalog.categories)) {
      if (!groups[cat]) continue;
      const og = el('optgroup', { label });
      for (const ch of groups[cat]) og.append(el('option', { value: ch.id, text: ch.name }));
      s.append(og);
    }
    return s;
  }

  function renderGrid() {
    const grid = $('#grid');
    for (const p of panels) teardown(p);
    panels.length = 0;
    const count = panelCount();
    const stagger = TV && INJECT && tvPerf.codec === 'mixto' && count > 1;
    const [cols, rows] = gridShape();
    grid.style.setProperty('--cols', String(cols));
    grid.style.setProperty('--rows', String(rows));
    grid.classList.toggle('dual', state.g === 'd' && !singleColumn());
    grid.replaceChildren();
    for (let i = 0; i < count; i++) {
      const select = channelSelect(i);
      const status = el('span', { class: 'status', 'data-state': 'empty' });
      const reload = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Recargar panel ${i + 1}`, title: 'Recargar' }, el('span', { 'aria-hidden': 'true', text: '↻' }));
      const muteBtn = el('button', { type: 'button', class: 'icon-btn mute-btn', 'aria-pressed': 'false' }, el('span', { 'aria-hidden': 'true', text: '🔇' }));
      // En la tele el panel entero es "apretable": OK = activar/silenciar sonido.
      const body = el('div', { class: 'panel-body', tabindex: TV ? '0' : null, 'aria-label': TV ? `Panel ${i + 1}: OK para activar o silenciar el sonido` : null });
      const hint = TV ? el('div', { class: 'tv-hint', 'aria-hidden': 'true' }) : null;
      const root = el('section', { class: 'panel', 'aria-label': `Panel ${i + 1}` }, el('div', { class: 'panel-bar' }, select, status, muteBtn, reload), body, hint);
      const p = { index: i, root, body, status, select, muteBtn, hint, timer: null, player: null, muted: true };
      muteBtn.addEventListener('click', () => toggleMute(p));
      body.addEventListener('keydown', (e) => {
        if (e.target !== body || !(e.key === 'Enter' || e.key === ' ' || e.keyCode === 23)) return;
        e.preventDefault();
        // Cartel (sin señal / sin vivo) -> reintentar; si no, activar/silenciar el sonido.
        if ($('.fallback', body)) mount(p, { force: true });
        else toggleMute(p);
      });
      select.addEventListener('change', () => { state.c[i] = select.value; persist(); mount(p); });
      reload.addEventListener('click', () => mount(p, { force: true }));
      panels.push(p);
      grid.append(root);
      if (stagger && i > 0) setStatus(p, 'loading', 'En espera…');
      else { mount(p); applyMute(p); }
    }
    if (stagger) {
      // El principal arranca solo y se queda con el decodificador de la tele; los demás
      // entran de a uno (1,5 s entre cada uno) cuando ya está reproduciendo, o a los 8 s.
      const rest = panels.slice(1);
      let started = false;
      const go = () => {
        if (started) return;
        started = true;
        rest.forEach((q, k) => setTimeout(() => { if (panels.includes(q)) { mount(q); applyMute(q); } }, k * 1500));
      };
      panels[0].onFirstPlay = go;
      setTimeout(go, 8000);
    }
    document.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.g === String(state.g))));
  }

  // ======================================================================
  // Titulares: columna filtrable + ticker
  // ======================================================================

  const news = {
    filter: store.get('bn.news.filter', ''),
    summaries: store.get('bn.news.summaries', false),
    seen: new Set(),
    first: true,
    pendingTicker: null,
  };

  function renderNewsFilter(sources) {
    const sel = $('#news-filter');
    const current = news.filter;
    sel.replaceChildren(el('option', { value: '', text: 'Todos los medios' }));
    for (const s of [...sources].sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
      const flag = s.ok === false ? ' — ⚠ feed con error' : '';
      sel.append(el('option', { value: s.id, text: `${s.name} (${s.count})${flag}` }));
    }
    sel.value = sources.some((s) => s.id === current) ? current : '';
  }

  function renderNewsList(items) {
    const list = $('#news-list');
    const shown = news.filter ? items.filter((i) => i.feed === news.filter) : items;
    list.replaceChildren(...shown.slice(0, 150).map((it) => {
      const isNew = !news.first && !news.seen.has(it.id);
      return el('li', { class: 'news-item' },
        el('div', { class: 'news-meta' },
          el('span', { class: 'news-src', text: it.source }),
          el('time', { datetime: new Date(it.ts).toISOString(), text: fmtTime(it.ts) }),
          isNew ? el('span', { class: 'news-new', text: 'NUEVO' }) : null),
        el('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer' }, it.title, el('span', { class: 'sr-only', text: ` (${it.source}, abre en otra pestaña)` })),
        it.summary ? el('p', { class: 'news-summary', text: it.summary }) : null);
    }));
    if (shown.length === 0) list.append(el('li', { class: 'news-item muted', text: 'No hay titulares para este filtro en las últimas 48 h.' }));
  }

  function buildTicker(items) {
    const track = $('#ticker-track');
    const top = items.slice(0, 40);
    if (top.length === 0) { track.replaceChildren(el('span', { class: 'ticker-item muted', text: 'Sin titulares todavía…' })); return; }
    const make = (hidden) => top.map((it) => el('span', { class: 'ticker-item', 'aria-hidden': hidden ? 'true' : null },
      el('b', { text: it.source }),
      el('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer', tabindex: hidden ? '-1' : null, text: it.title })));
    track.replaceChildren(...make(false), ...make(true)); // duplicado para el desplazamiento continuo
    requestAnimationFrame(() => {
      const half = track.scrollWidth / 2;
      track.style.setProperty('--ticker-dur', `${Math.max(40, Math.round(half / 70))}s`); // ~70 px/s
    });
  }

  function updateTicker(items) {
    const track = $('#ticker-track');
    if (!track.childElementCount) return buildTicker(items);
    news.pendingTicker = items; // se aplica al terminar la vuelta para que no salte
  }

  function setupTicker() {
    const track = $('#ticker-track');
    track.addEventListener('animationiteration', () => {
      if (news.pendingTicker) { buildTicker(news.pendingTicker); news.pendingTicker = null; }
    });
    const btn = $('#ticker-pause');
    const ticker = btn.closest('.ticker');
    const apply = (paused) => {
      ticker.classList.toggle('paused', paused);
      btn.setAttribute('aria-pressed', String(paused));
      $('.ticker-icon', btn).textContent = paused ? '▶' : '❚❚';
      $('.ticker-label', btn).textContent = paused ? 'Seguir' : 'Pausar';
      store.set('bn.ticker.paused', paused);
    };
    apply(store.get('bn.ticker.paused', false));
    btn.addEventListener('click', () => apply(btn.getAttribute('aria-pressed') !== 'true'));
    // Sin animación (reduced motion) aplicamos las actualizaciones directo.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInterval(() => { if (news.pendingTicker) { buildTicker(news.pendingTicker); news.pendingTicker = null; } }, 5000);
    }
  }

  let lastItems = [];
  // Titulares incrementales: la primera vez se piden todos y después solo los nuevos
  // (?after=maxId). En el celular baja el consumo de datos de ~3 MB/h a casi nada.
  const NEWS_MAX = 300;
  const NEWS_TTL = 48 * 3600 * 1000;
  let newsMaxId = 0;
  let newsFullAt = 0;
  async function refreshNews() {
    const status = $('#news-status');
    try {
      // Cada 30 min, o si algo no cierra, se vuelve a pedir la lista entera.
      const full = !newsMaxId || Date.now() - newsFullAt > 30 * 60_000;
      const data = await api(full ? `/api/news?limit=${NEWS_MAX}` : `/api/news?after=${newsMaxId}&limit=${NEWS_MAX}`);
      if (!full && (!data.incremental || data.maxId < newsMaxId)) { newsMaxId = 0; return refreshNews(); }
      if (full) newsFullAt = Date.now();
      const byIdNews = new Map((full ? [] : lastItems).map((it) => [it.id, it]));
      for (const it of data.items) byIdNews.set(it.id, it);
      const cutoff = Date.now() - NEWS_TTL;
      lastItems = [...byIdNews.values()].filter((it) => it.ts >= cutoff).sort((a, b) => b.ts - a.ts).slice(0, NEWS_MAX);
      newsMaxId = data.maxId || newsMaxId;
      const changed = full || data.items.length > 0;
      renderNewsFilter(data.sources);
      if (changed) {
        renderNewsList(lastItems);
        updateTicker(lastItems);
      }
      const w = data.worker;
      const ageMin = w ? (Date.now() - w.lastRss) / 60000 : Infinity;
      if (ageMin > 6) {
        status.className = 'news-status warn';
        status.textContent = w ? `⚠ Titulares sin actualizar desde las ${fmtTime(w.lastRss)}` : '⚠ El lector de titulares todavía no corrió';
      } else {
        status.className = 'news-status muted';
        status.textContent = `✓ Actualizado ${fmtTime(w.lastRss)} · ${lastItems.length} titulares de las últimas 48 h`;
      }
      for (const it of lastItems) news.seen.add(it.id);
      news.first = false;
    } catch {
      status.className = 'news-status warn';
      status.textContent = '⚠ No se pudieron cargar los titulares. Reintentando…';
    }
  }

  function setupNews() {
    const sel = $('#news-filter');
    sel.addEventListener('change', () => { news.filter = sel.value; store.set('bn.news.filter', news.filter); renderNewsList(lastItems); });
    const cb = $('#news-summaries');
    const applySum = () => $('#news').classList.toggle('show-summaries', cb.checked);
    cb.checked = Boolean(news.summaries);
    applySum();
    cb.addEventListener('change', () => { store.set('bn.news.summaries', cb.checked); applySum(); });

    const tg = $('#toggle-news');
    const applyHidden = (hidden) => {
      document.body.classList.toggle('news-hidden', hidden);
      if (TV) requestAnimationFrame(() => panels.forEach(applyLite));
      tg.setAttribute('aria-expanded', String(!hidden));
      store.set('bn.news.hidden', hidden);
    };
    applyHidden(store.get('bn.news.hidden', TV));
    tg.addEventListener('click', () => applyHidden(!document.body.classList.contains('news-hidden')));
  }

  // ======================================================================
  // Datos: dólar y clima (vienen cacheados de nuestro backend)
  // ======================================================================

  const money = (n) => n == null ? '—' : new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);
  const pct = (n) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 2, signDisplay: 'never' }).format(n);

  function trend(v) {
    if (v == null) return null;
    if (v > 0) return el('span', { class: 'trend up', title: 'Sube respecto del cierre del día anterior' }, el('span', { 'aria-hidden': 'true', text: '▲ ' }), `+${pct(v)}%`, el('span', { class: 'sr-only', text: ' (sube)' }));
    if (v < 0) return el('span', { class: 'trend down', title: 'Baja respecto del cierre del día anterior' }, el('span', { 'aria-hidden': 'true', text: '▼ ' }), `−${pct(v)}%`, el('span', { class: 'sr-only', text: ' (baja)' }));
    return el('span', { class: 'trend flat', title: 'Sin cambios respecto del cierre anterior' }, el('span', { 'aria-hidden': 'true', text: '= ' }), '0%', el('span', { class: 'sr-only', text: ' (sin cambios)' }));
  }

  const WIND = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  const WICON = { sol: '☀', 'sol-nube': '⛅', nube: '☁', niebla: '🌫', lluvia: '🌧', nieve: '❄', tormenta: '⛈' };
  const r0 = (n) => (n == null ? '—' : Math.round(n));

  function staleNote(updatedAt, maxMin) {
    if (!updatedAt || (Date.now() - updatedAt) / 60000 <= maxMin) return null;
    return el('span', { class: 'stale' }, el('span', { 'aria-hidden': 'true', text: '⚠ ' }), `dato de las ${fmtTime(updatedAt)}`);
  }

  async function refreshData() {
    let d;
    try { d = await api('/api/data'); } catch { return; }
    const dol = $('#dolar');
    if (d.dolar && d.dolar.casas) {
      const parts = ['oficial', 'blue', 'bolsa'].filter((k) => d.dolar.casas[k]).map((k) => {
        const c = d.dolar.casas[k];
        return el('span', { class: 'quote' },
          el('b', { text: c.nombre }),
          el('span', { class: 'muted', text: 'C' }), el('span', { class: 'num', text: money(c.compra) }),
          el('span', { class: 'muted', text: 'V' }), el('span', { class: 'num', text: money(c.venta) }),
          trend(c.variacion));
      });
      fill(dol, el('span', { class: 'data-title', text: 'Dólar' }), parts, staleNote(d.dolar.updatedAt, 30));
      dol.title = `Fuente: ${d.dolar.fuente}. C = compra, V = venta. Variación de la venta contra el último valor del día anterior.`;
    } else {
      dol.replaceChildren(el('span', { class: 'data-title', text: 'Dólar' }), el('span', { class: 'stale', text: '⚠ sin datos' }));
    }

    const cl = $('#clima');
    const c = d.clima;
    if (c) {
      const dir = c.vientoDir == null ? '' : ` ${WIND[Math.round(c.vientoDir / 22.5) % 16]}`;
      fill(cl,
        el('span', { class: 'data-title', text: `Clima · ${c.lugar}` }),
        el('span', { class: 'quote' }, el('span', { 'aria-hidden': 'true', text: WICON[c.icono] || '' }), el('b', { text: `${r0(c.temp)}°C` }), el('span', { text: c.descripcion })),
        el('span', { class: 'quote' }, el('span', { class: 'muted', text: 'Sensación' }), el('span', { text: `${r0(c.sensacion)}°` })),
        el('span', { class: 'quote' }, el('span', { class: 'muted', text: 'Viento' }), el('span', { text: `${r0(c.viento)} km/h${dir}` }), el('span', { class: 'muted', text: 'ráfagas' }), el('span', { text: `${r0(c.rafagas)} km/h` })),
        el('span', { class: 'quote' }, el('span', { class: 'muted', text: 'Máx/mín' }), el('span', { text: `${r0(c.max)}° / ${r0(c.min)}°` })),
        staleNote(c.updatedAt, 60));
      cl.title = `Fuente: ${c.fuente}`;
    }
  }

  // ======================================================================
  // Varios: reloj, tema, compartir, layout
  // ======================================================================

  function tickClock() {
    $('#clock').textContent = new Intl.DateTimeFormat('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ART }).format(new Date());
  }

  function setupTheme() {
    const btn = $('#theme');
    const sync = () => {
      const light = document.documentElement.getAttribute('data-theme') === 'light';
      btn.setAttribute('aria-pressed', String(light));
      $('.theme-label', btn).textContent = 'Claro';
      btn.title = light ? 'Tema claro activado' : 'Tema oscuro activado';
    };
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('bn.theme', next); } catch { /* ignorar */ }
      sync();
    });
    sync();
  }

  function setupShare() {
    $('#share').addEventListener('click', async () => {
      const url = shareUrl();
      try {
        if (navigator.share && singleColumn()) { await navigator.share({ title: document.title, url }); return; }
        await navigator.clipboard.writeText(url);
        // Respuesta bien visible en el propio botón (el aviso solo pasaba desapercibido).
        const b = $('#share');
        clearTimeout(b.resetTimer);
        if (!b.dataset.html) b.dataset.html = b.innerHTML;
        b.classList.add('done');
        b.textContent = '✓ ¡Link copiado!';
        b.resetTimer = setTimeout(() => { b.innerHTML = b.dataset.html; b.classList.remove('done'); }, 2500);
        toast('Link copiado. Pegalo en WhatsApp o donde quieras: abre esta misma grilla de canales.');
      } catch {
        window.prompt('Copiá este enlace:', url);
      }
    });
  }

  // Aviso antes de pasar a 4 canales en la app de TV.
  // Ventana de aviso manejable con el control (flechas + OK; Atrás la cierra).
  function modal(title, paragraphs, buttons) {
    const close = () => { dlg.remove(); document.body.classList.remove('modal-open'); };
    const btns = buttons.map((b, i) => el('button', {
      type: 'button', class: i === 0 ? 'btn primary' : 'btn',
      onclick: () => { close(); if (b.action) b.action(); else panels[0]?.body.focus(); },
    }, b.label));
    const dlg = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-t' },
      el('div', { class: 'modal-box' },
        el('h2', { id: 'modal-t', text: title }),
        paragraphs.map((t) => el('p', { text: t })),
        el('div', { class: 'modal-actions' }, btns)));
    dlg.close = close;
    document.body.append(dlg);
    document.body.classList.add('modal-open');
    btns[0].focus();
  }

  const DEVICE_TIP = 'Con un Chromecast con Google TV o un Fire TV Stick 4K Max se pueden ver más canales a la vez.';

  function warnFour(onYes) {
    modal('¿Ver 4 canales a la vez?', [
      'Ver 4 videos juntos necesita mucha potencia. Muchas teles tienen un solo decodificador de video, así que con 4 canales los videos se pueden trabar, cortar o quedar congelados.',
      `Si pasa, la app vuelve sola a 1 canal. ${DEVICE_TIP}`,
    ], [{ label: 'Probar con 4', action: onYes }, { label: 'Cancelar' }]);
  }

  function warnOnlyOne(n, onYes) {
    modal(`¿Probar con ${n} canales?`, [
      'En esta tele, con más de un canal los videos se trabaron y la app pasó a 1.',
      `Podés probar de nuevo; si se vuelve a trabar, regresa sola a 1. ${DEVICE_TIP}`,
    ], [{ label: 'Probar igual', action: onYes }, { label: 'Quedarme con 1' }]);
  }

  // Esta tele no pudo con varios videos juntos: 1 canal y aviso (se recuerda).
  function fallbackToOne() {
    store.set('bn.tv.onlyOne', true);
    state.g = 1;
    persist();
    renderGrid();
    modal('Tu tele puede mostrar un canal a la vez', [
      'Con más de un canal los videos se trababan y se recargaban, así que pasamos a 1 canal, que en esta tele anda bien.',
      `Para cambiar de canal: ▲ y OK sobre el nombre. Podés volver a probar con más desde el menú (▲ arriba de todo). ${DEVICE_TIP}`,
    ], [{ label: 'Entendido' }]);
  }

  function setupLayout() {
    const apply = (g) => { state.g = g; persist(); renderGrid(); if (TV) panels[0]?.body.focus(); };
    document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => {
      const g = b.dataset.g === 'd' ? 'd' : Number(b.dataset.g);
      if (APP_TV && g !== 1 && g !== state.g && store.get('bn.tv.onlyOne', false)) {
        warnOnlyOne(g === 'd' ? 2 : 4, () => apply(g));
        return;
      }
      if (APP_TV && g === 2 && state.g !== 2) { warnFour(() => apply(2)); return; }
      apply(g);
    }));
    MOBILE.addEventListener('change', renderGrid);
    if (TV) {
      let t = null;
      window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => panels.forEach(applyLite), 300); });
    }
  }

  async function loadCatalog() {
    catalog = await api('/api/channels');
    byId = new Map(catalog.channels.map((c) => [c.id, c]));
  }

  // ======================================================================
  // Modo TV: navegación con las flechas del control remoto
  // ======================================================================

  // En la app de Android TV el "Atrás" lo maneja la app (llama a window.bnBack).
  const BACK_KEYS = new Set(['Escape', 'BrowserBack']);
  const BACK_CODES = new Set([27, 461, 10009]); // Esc, webOS (461), Tizen (10009)

  function navTargets() {
    const modal = $('.modal');
    if (modal) return [...modal.querySelectorAll('button')];
    const sel = [
      '.topbar button:not([hidden])', '.panel-bar select', '.panel-bar button', '.panel-body[tabindex]',
      '#news-filter', '#news-list', '#ticker-pause',
    ].join(',');
    return [...document.querySelectorAll(sel)].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden';
    });
  }

  // Navegación espacial simple: el elemento más cercano en la dirección de la flecha.
  function moveFocus(dir) {
    const cur = document.activeElement;
    const all = navTargets();
    if (!cur || !all.includes(cur)) { (panels[0]?.body || all[0])?.focus(); return; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const n of all) {
      if (n === cur) continue;
      const b = n.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let main, cross;
      if (dir === 'ArrowRight') { if (b.left < a.right - 4) continue; main = b.left - a.right; cross = Math.abs(by - ay); }
      else if (dir === 'ArrowLeft') { if (b.right > a.left + 4) continue; main = a.left - b.right; cross = Math.abs(by - ay); }
      else if (dir === 'ArrowDown') { if (b.top < a.bottom - 4) continue; main = b.top - a.bottom; cross = Math.abs(bx - ax); }
      else { if (b.bottom > a.top + 4) continue; main = a.top - b.bottom; cross = Math.abs(bx - ax); }
      const score = Math.max(0, main) + cross * 2;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (best) { best.focus(); best.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
  }

  // Volver: si el foco no está en un panel, vuelve al primero. Devuelve true si lo usó
  // (la app de Android TV lo consulta para decidir si cierra la app).
  function tvBack() {
    const modal = $('.modal');
    if (modal) { modal.close(); panels[0]?.body.focus(); return true; }
    const cur = document.activeElement;
    if (cur && cur.classList && cur.classList.contains('panel-body')) return false;
    (panels[0]?.body)?.focus();
    return true;
  }
  window.bnBack = tvBack;

  function setupTv() {
    if (!TV) return;
    document.documentElement.classList.add('tv');
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key.startsWith('Arrow')) {
        // En la lista de titulares, arriba/abajo desplazan la lista.
        if (t && t.id === 'news-list' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          const max = t.scrollHeight - t.clientHeight;
          if ((e.key === 'ArrowUp' && t.scrollTop > 0) || (e.key === 'ArrowDown' && t.scrollTop < max - 1)) {
            e.preventDefault();
            t.scrollBy({ top: e.key === 'ArrowDown' ? 160 : -160 });
            return;
          }
        }
        e.preventDefault(); // evita que la flecha cambie el canal del selector sin abrirlo
        moveFocus(e.key);
      } else if (!APP_TV && (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode))) {
        if (t && t.tagName === 'INPUT') return;
        if (tvBack()) e.preventDefault();
      }
    }, true);
    // Si el foco se pierde (por ejemplo al tocar un reproductor), vuelve a un panel.
    window.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement && document.activeElement.tagName === 'IFRAME') panels[0]?.body.focus();
    }, 0));
    for (const id of ['#tv-link', '#tv-btn']) { const n = $(id); if (n) n.hidden = true; }
    const nine = document.querySelector('.seg[data-g="3"]');
    if (nine) nine.hidden = true;
    const two = document.querySelector('.seg[data-g="d"]');
    if (two && APP_TV) two.hidden = false;
    const qb = $('#tv-quality');
    if (qb) {
      qb.hidden = false;
      syncQualityBtn();
      qb.addEventListener('click', () => {
        tvPerf.level = (tvPerf.level + 1) % QUALITY.length;
        store.set('bn.tv.quality', tvPerf.level);
        tvPerf.pauses = [];
        syncQualityBtn();
        panels.forEach(applyLite);
        toast(`Calidad ${QUALITY[tvPerf.level].label}`);
      });
    }
    const cb = $('#tv-codec');
    if (cb && INJECT) {
      cb.hidden = false;
      const NAMES = { mixto: 'mixto', h264: 'H.264', auto: 'automático' };
      const HELP = {
        mixto: 'Formato mixto: el panel 1 usa el decodificador de la tele (H.264) y los otros 3 van livianos por software.',
        h264: 'Formato H.264 en todos: ideal para 1 canal; con 4, en teles con un solo decodificador se congelan los demás.',
        auto: 'Formato automático: YouTube elige en cada panel.',
      };
      const sync = () => { cb.textContent = `🎛 Formato: ${NAMES[tvPerf.codec]}`; };
      sync();
      cb.addEventListener('click', () => {
        tvPerf.codec = CODECS[(CODECS.indexOf(tvPerf.codec) + 1) % CODECS.length];
        store.set('bn.tv.codec2', tvPerf.codec);
        sync();
        renderGrid();
        toast(HELP[tvPerf.codec]);
      });
    }
    const db = $('#tv-diag');
    if (db) {
      db.hidden = false;
      db.addEventListener('click', () => toggleDiag());
    }
    // El encabezado es un menú: se muestra mientras el foco está adentro.
    const top = $('.topbar');
    top.addEventListener('focusin', () => document.body.classList.add('tv-menu'));
    top.addEventListener('focusout', () => setTimeout(() => {
      if (!top.contains(document.activeElement)) document.body.classList.remove('tv-menu');
    }, 0));
    setTimeout(() => toast('Flechas: moverse · OK: sonido · ▲ arriba de todo: menú'), 1500);
  }

  // Pantalla siempre encendida en la tele o con la app instalada (si el navegador deja).
  async function keepAwake() {
    const standalone = window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
    if (!(TV || standalone) || !('wakeLock' in navigator)) return;
    const req = async () => { try { if (document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch { /* sin permiso */ } };
    await req();
    document.addEventListener('visibilitychange', req);
  }

  // PWA: instalable desde el navegador (celular / compu). Sin tiendas.
  function setupPwa() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const btn = $('#install');
    if (!btn || TV) return;
    let deferred = null;
    // Solo en el celular: en la compu "instalar" crea un acceso en el escritorio y confunde
    // (la gente lo toma por la app de la tele, que está en /tv).
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      btn.hidden = !singleColumn();
    });
    MOBILE.addEventListener('change', () => { btn.hidden = !deferred || !singleColumn(); });
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch { /* ignorar */ }
      deferred = null;
      btn.hidden = true;
    });
    window.addEventListener('appinstalled', () => { btn.hidden = true; toast('✓ App instalada'); });
  }

  async function init() {
    readState();
    setupTv();
    setupPwa();
    keepAwake();
    tickClock();
    setInterval(tickClock, 15000);
    setupTheme();
    setupShare();
    setupLayout();
    setupNews();
    setupTicker();
    try {
      await loadCatalog();
    } catch {
      $('#grid').replaceChildren(el('div', { class: 'fallback' }, el('div', { class: 'title', text: '⚠ No se pudo cargar el catálogo de canales' }),
        el('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, 'Reintentar')));
    }
    defaults();
    persist();
    renderGrid();
    if (TV) panels[0]?.body.focus();
    refreshNews();
    refreshData();
    setInterval(refreshNews, 60_000);
    setInterval(refreshData, 120_000);
    // Re-lee el catálogo cada 10 min (altas/bajas desde /admin y estado de vivos).
    setInterval(async () => {
      try {
        const before = JSON.stringify(catalog.channels);
        await loadCatalog();
        if (JSON.stringify(catalog.channels) !== before) renderGrid();
      } catch { /* ignorar */ }
    }, 600_000);
  }

  init();
})();
