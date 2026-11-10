// Picks the first paint's theme before any stylesheet loads, so light-theme users don't see a dark flash.
// Like Antigravity's own anti-flash script, it prefers a hostTheme URL hint, then the theme Antigravity last
// sent (core.js saves it), then the system setting. The real theme replaces this as soon as the host or the
// telemetry payload sends one.
(function () {
  var root = document.documentElement;
  var isTheme = function (t) {
    return t === 'light' || t === 'dark';
  };
  var theme = '';
  try {
    theme = new URLSearchParams(window.location.search).get('hostTheme') || '';
  } catch (e) {}
  if (!isTheme(theme)) {
    try {
      theme = window.localStorage.getItem('cm-theme') || '';
    } catch (e) {}
  }
  if (!isTheme(theme)) {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  if (theme === 'light') {
    // Antigravity's stylesheet defaults --background to its dark value, so hold the light pair (the same
    // fallbacks core.js uses) until a theme arrives and replaces them.
    root.style.setProperty('--background', '#f8f9fc');
    root.style.setProperty('--foreground', '#121317');
  }
})();
