'use strict';

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  let cat = { categories: {}, types: [], channels: [], feeds: [], feedStatus: {} };

  async function call(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-bn-csrf': '1', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error(data.error || 'Sesión vencida.'); }
    if (!r.ok) throw new Error(data.error || `Error HTTP ${r.status}`);
    return data;
  }

  const td = (text, cls) => { const c = document.createElement('td'); if (cls) c.className = cls; c.textContent = text; return c; };
  const btn = (label, cls, onclick, aria) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls || ''}`;
    b.textContent = label;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onclick);
    return b;
  };
  const msg = (id, text, ok) => { const m = $(id); m.textContent = text; m.className = `msg ${ok ? 'ok' : 'err'}`; };
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

  function showLogin() { $('#admin-view').hidden = true; $('#login-view').hidden = false; $('#login-form input').focus(); }
  function showAdmin() { $('#login-view').hidden = true; $('#admin-view').hidden = false; }

  // ---------------- canales ----------------

  function renderChannels() {
    const rows = cat.channels.map((c, i) => {
      const tr = document.createElement('tr');
      const order = document.createElement('td');
      order.className = 'actions';
      order.append(
        btn('↑', '', () => move(c.id, 'up'), `Subir ${c.name}`),
        btn('↓', '', () => move(c.id, 'down'), `Bajar ${c.name}`),
      );
      if (i === 0) order.firstChild.disabled = true;
      if (i === cat.channels.length - 1) order.lastChild.disabled = true;
      const act = document.createElement('td');
      act.className = 'actions';
      act.append(btn('Editar', '', () => editChannel(c), `Editar ${c.name}`), ' ', btn('Borrar', 'danger', () => delChannel(c), `Borrar ${c.name}`));
      tr.append(order, td(c.name), td(cat.categories[c.category] || c.category), td(c.type), td(c.source, 'src'), td(c.verified || '—'), act);
      return tr;
    });
    $('#ch-rows').replaceChildren(...rows);
  }

  function fillSelects() {
    const cs = $('#ch-form [name=category]');
    cs.replaceChildren(...Object.entries(cat.categories).map(([k, v]) => new Option(v, k)));
    const ts = $('#ch-form [name=type]');
    ts.replaceChildren(...cat.types.map((t) => new Option(t, t)));
  }

  function formData(form) {
    const o = Object.fromEntries(new FormData(form));
    const en = form.querySelector('[name=enabled]');
    if (en) o.enabled = en.checked;
    return o;
  }

  function editChannel(c) {
    const f = $('#ch-form');
    f.elements.originalId.value = c.id;
    for (const k of ['id', 'name', 'category', 'type', 'source']) f.elements[k].value = c[k];
    $('#ch-form-title').textContent = `Editar canal: ${c.name}`;
    f.elements.name.focus();
  }

  async function delChannel(c) {
    if (!confirm(`¿Borrar el canal "${c.name}"?`)) return;
    try { await call('DELETE', `/api/admin/channels/${encodeURIComponent(c.id)}`); msg('#ch-msg', `✓ Canal "${c.name}" borrado.`, true); await load(); }
    catch (e) { msg('#ch-msg', `⚠ ${e.message}`); }
  }

  async function move(id, dir) {
    try { await call('POST', `/api/admin/channels/${encodeURIComponent(id)}/move`, { dir }); await load(); }
    catch (e) { msg('#ch-msg', `⚠ ${e.message}`); }
  }

  $('#ch-check').addEventListener('click', async () => {
    const d = formData($('#ch-form'));
    msg('#ch-msg', 'Verificando…', true);
    try {
      const r = await call('POST', '/api/admin/check/channel', { type: d.type, source: d.source });
      msg('#ch-msg', `${r.ok ? '✓' : '⚠'} ${r.detalle}`, r.ok);
    } catch (e) { msg('#ch-msg', `⚠ ${e.message}`); }
  });

  $('#ch-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const d = formData(f);
    const orig = d.originalId;
    delete d.originalId;
    msg('#ch-msg', 'Verificando y guardando…', true);
    try {
      if (orig) await call('PUT', `/api/admin/channels/${encodeURIComponent(orig)}`, d);
      else await call('POST', '/api/admin/channels', d);
      msg('#ch-msg', `✓ Canal "${d.name}" guardado.`, true);
      f.reset();
      await load();
    } catch (e) { msg('#ch-msg', `⚠ ${e.message}`); }
  });
  $('#ch-form').addEventListener('reset', () => { $('#ch-form').elements.originalId.value = ''; $('#ch-form-title').textContent = 'Agregar canal'; });

  // ---------------- feeds ----------------

  function renderFeeds() {
    const rows = cat.feeds.map((f) => {
      const st = cat.feedStatus[f.id];
      const tr = document.createElement('tr');
      const s = td(!st ? '◌ sin leer todavía' : st.ok ? `✓ OK ${fmt(st.lastOk)} (${st.lastItems ?? 0} ítems)` : `⚠ ${st.error || 'error'}`);
      s.className = !st ? '' : st.ok ? 'st-ok' : 'st-err';
      const act = document.createElement('td');
      act.className = 'actions';
      act.append(btn('Editar', '', () => editFeed(f), `Editar ${f.name}`), ' ', btn('Borrar', 'danger', () => delFeed(f), `Borrar ${f.name}`));
      tr.append(td(f.name), td(f.url, 'src'), s, td(f.enabled === false ? '✗ No' : '✓ Sí'), act);
      return tr;
    });
    $('#fd-rows').replaceChildren(...rows);
  }

  function editFeed(fd) {
    const f = $('#fd-form');
    f.elements.originalId.value = fd.id;
    f.elements.id.value = fd.id; f.elements.name.value = fd.name; f.elements.url.value = fd.url; f.elements.enabled.checked = fd.enabled !== false;
    $('#fd-form-title').textContent = `Editar feed: ${fd.name}`;
    f.elements.name.focus();
  }

  async function delFeed(fd) {
    if (!confirm(`¿Borrar el feed de "${fd.name}"? Sus titulares desaparecen solos en 48 h.`)) return;
    try { await call('DELETE', `/api/admin/feeds/${encodeURIComponent(fd.id)}`); msg('#fd-msg', `✓ Feed "${fd.name}" borrado.`, true); await load(); }
    catch (e) { msg('#fd-msg', `⚠ ${e.message}`); }
  }

  $('#fd-check').addEventListener('click', async () => {
    const d = formData($('#fd-form'));
    msg('#fd-msg', 'Probando feed…', true);
    try {
      const r = await call('POST', '/api/admin/check/feed', { url: d.url });
      msg('#fd-msg', `${r.ok ? '✓' : '⚠'} ${r.detalle}${r.ejemplos?.length ? ` Ej.: «${r.ejemplos[0]}»` : ''}`, r.ok);
    } catch (e) { msg('#fd-msg', `⚠ ${e.message}`); }
  });

  $('#fd-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const d = formData(f);
    const orig = d.originalId;
    delete d.originalId;
    try {
      if (orig) await call('PUT', `/api/admin/feeds/${encodeURIComponent(orig)}`, d);
      else await call('POST', '/api/admin/feeds', d);
      msg('#fd-msg', `✓ Feed "${d.name}" guardado. Se lee en la próxima pasada del worker (≤ 2 min).`, true);
      f.reset();
      await load();
    } catch (e) { msg('#fd-msg', `⚠ ${e.message}`); }
  });
  $('#fd-form').addEventListener('reset', () => { $('#fd-form').elements.originalId.value = ''; $('#fd-form-title').textContent = 'Agregar feed'; });

  // ---------------- sesión ----------------

  async function load() {
    cat = await call('GET', '/api/admin/catalog');
    fillSelectsOnce();
    renderChannels();
    renderFeeds();
  }
  let filled = false;
  function fillSelectsOnce() { if (!filled) { fillSelects(); filled = true; } }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = formData(ev.target);
    try {
      await call('POST', '/api/admin/login', { user: d.user, password: d.password });
      ev.target.reset();
      $('#login-msg').textContent = '';
      showAdmin();
      await load();
    } catch (e) { $('#login-msg').textContent = `⚠ ${e.message}`; }
  });

  $('#logout').addEventListener('click', async () => { await call('POST', '/api/admin/logout').catch(() => {}); showLogin(); });

  (async () => {
    try {
      const me = await call('GET', '/api/admin/me');
      if (me.loggedIn) { showAdmin(); await load(); } else showLogin();
    } catch { showLogin(); }
  })();
})();
