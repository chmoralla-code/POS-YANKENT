'use strict';
/* Early startup progress — runs before app.js so the loader is visible immediately. */
(function () {
  const fill = document.querySelector('.startup-bar-fill');
  const status = document.getElementById('startupStatus');
  let pct = 10;
  window.__startupProgress = setInterval(() => {
    pct = Math.min(pct + 2, 36);
    if (fill) fill.style.width = pct + '%';
  }, 140);
  window.__startupSetStep = (p, msg) => {
    clearInterval(window.__startupProgress);
    window.__startupProgress = null;
    if (fill) fill.style.width = p + '%';
    if (status && msg) status.textContent = msg;
  };
})();
