// Aplica el tema guardado antes de pintar (oscuro por defecto). Sin script inline por la CSP.
(function () {
  try {
    var t = localStorage.getItem('bn.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
