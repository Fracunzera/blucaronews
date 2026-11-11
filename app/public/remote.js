// Control remoto de la app de Android (celu -> tele). La app le da el puente window.BNApp:
// buscar teles, empezar/detener la transmisión y mandar órdenes a la grilla que arma el
// celu en una pantalla invisible (canales, sonido, cuántos a la vez).
'use strict';

(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c);
    return n;
  };
  const app = window.BNApp;
  const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };

  if (!app) { $('#no-app').hidden = false; return; }

  let catalog = { channels: [], categories: {} };
  fetch('/api/channels').then((r) => r.json()).then((d) => { catalog = d; lastSig = ''; }).catch(() => {});

  // ---------------------------------------------------------------- elegir tele

  let tvSig = '';
  function renderTvs() {
    const list = parse(app.tvs(), []);
    const sig = JSON.stringify(list);
    if (sig === tvSig) return;
    tvSig = sig;
    const ul = $('#tvs');
    ul.replaceChildren(...list.map((tv) => el('li', {},
      el('button', { type: 'button', class: 'rm-tv', onclick: () => cast(tv) },
        el('span', { class: 'rm-tv-icon', 'aria-hidden': 'true', text: '📺' }),
        el('span', { class: 'rm-tv-name' }, el('strong', { text: tv.name }), el('span', { class: 'hint', text: `${tv.host}${tv.manual ? ' · agregada a mano' : ''}` })),
        el('span', { class: 'rm-tv-go', text: 'Mandar ›' })))));
    $('#searching').hidden = list.length > 0;
  }

  function cast(tv) {
    $('#idle-error').hidden = true;
    app.cast(tv.host, Number(tv.port), tv.name, $('#audio').checked);
  }

  $('#add-ip').addEventListener('click', () => {
    const ip = $('#ip').value.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { $('#ip').focus(); return; }
    app.addTv(ip);
    $('#ip').value = '';
    tvSig = '';
    renderTvs();
  });
  $('#rescan').addEventListener('click', () => { app.rescan(); tvSig = ''; $('#searching').hidden = false; });

  // ---------------------------------------------------------------- transmitiendo

  $('#stop').addEventListener('click', () => app.stop());
  $('#mute-all').addEventListener('click', () => app.send(JSON.stringify({ sound: -1 })));
  document.querySelectorAll('[data-layout]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.layout;
    app.send(JSON.stringify({ layout: v === 'd' ? 'd' : Number(v) }));
  }));

  function channelSelect(panel) {
    const s = el('select', { 'aria-label': `Canal ${panel.i + 1}` });
    const groups = {};
    for (const ch of catalog.channels || []) (groups[ch.category] ||= []).push(ch);
    for (const [cat, label] of Object.entries(catalog.categories || {})) {
      if (!groups[cat]) continue;
      const og = el('optgroup', { label });
      for (const ch of groups[cat]) og.append(el('option', { value: ch.id, text: ch.name }));
      s.append(og);
    }
    if (!s.querySelector(`option[value="${CSS.escape(panel.id)}"]`)) s.prepend(el('option', { value: panel.id, text: panel.name || panel.id || '—' }));
    s.value = panel.id;
    s.addEventListener('change', () => app.send(JSON.stringify({ channel: [panel.i, s.value] })));
    return s;
  }

  let lastSig = '';
  function renderPanels(page) {
    const panels = (page && page.panels) || [];
    document.querySelectorAll('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(page && String(page.g) === b.dataset.layout)));
    // No rehacer mientras eligen un canal (se cerraría la lista).
    if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
    const sig = JSON.stringify(panels.map((p) => [p.i, p.id, p.sound])) + (catalog.channels || []).length;
    if (sig !== lastSig) {
      lastSig = sig;
      $('#panels').replaceChildren(...panels.map((p) => el('div', { class: `rm-panel${p.sound ? ' on' : ''}` },
        el('span', { class: 'rm-n', text: String(p.i + 1) }),
        channelSelect(p),
        el('button', {
          type: 'button', class: `btn rm-sound${p.sound ? ' on' : ''}`, 'aria-pressed': String(!!p.sound),
          'aria-label': p.sound ? `Se escucha el canal ${p.i + 1}` : `Escuchar el canal ${p.i + 1}`,
          onclick: () => app.send(JSON.stringify({ sound: p.i })),
        }, p.sound ? '🔊' : '🔈'),
        el('div', { class: 'rm-pstatus hint', 'data-i': String(p.i) }))));
    }
    for (const p of panels) {
      const st = document.querySelector(`.rm-pstatus[data-i="${p.i}"]`);
      if (st) st.textContent = p.status || '';
    }
  }

  const PHASES = {
    iniciando: 'Preparando…', preparando: 'Preparando el video…',
    'conectando con la tele': 'Conectando con la tele…', transmitiendo: '● Transmitiendo a la tele', error: '⚠ Se cortó',
  };

  function render(st) {
    const casting = !!st.casting;
    $('#pick').hidden = casting;
    $('#live').hidden = !casting;
    if (!casting) {
      const err = $('#idle-error');
      err.hidden = !st.error;
      err.textContent = st.error || '';
      return;
    }
    $('#phase').textContent = PHASES[st.phase] || st.phase || '';
    $('#phase').classList.toggle('on', st.phase === 'transmitiendo');
    $('#tvname').textContent = st.tv ? `a ${st.tv}` : '';
    $('#live-error').hidden = !st.error;
    $('#live-error').textContent = st.error || '';
    renderPanels(st.page);
    $('#diag').textContent = `Video: ${st.frames || 0} cuadros · ${st.segments || 0} partes listas · la tele pidió ${st.requests || 0} · Sonido: ${st.audio || '—'}${st.audioLevel ? ` (nivel ${st.audioLevel}%)` : ''}`;
  }

  function tick() {
    render(parse(app.status(), { casting: false }));
    if ($('#live').hidden) renderTvs();
  }
  tick();
  setInterval(tick, 1000);
})();
