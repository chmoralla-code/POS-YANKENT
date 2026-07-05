'use strict';
/* Apply the saved (or system) theme before first paint to avoid a flash.
 * Runs before app.js; mirrors the logic in App._applyStoredTheme. */
(function () {
  let theme = null;
  try { theme = localStorage.getItem('yankent-theme'); } catch (e) {}
  if (!theme) {
    const prefersDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
    theme = prefersDark ? 'dark' : 'light';
  }
  if (theme === 'dark') {
    document.documentElement.classList.add('theme-dark');
  }
})();