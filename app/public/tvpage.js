// /tv: en iPhone/iPad, aclarar que la transmisión desde el celu es solo para Android.
'use strict';
(() => {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const note = document.getElementById('ios-note');
  if (ios && note) note.hidden = false;
})();
