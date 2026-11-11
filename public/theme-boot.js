// Sets the saved theme before first paint. A classic script so it runs while the
// page is parsed (the CSP allows same-origin scripts but no inline ones). Mirrors
// readTheme/resolveTheme in src/theme.js, which takes over once the app loads.
(function () {
  var theme = 'dark';
  try {
    theme = localStorage.getItem('mesh-code-theme') || 'dark';
  } catch (error) {
    // Storage blocked: keep the default.
  }
  if (theme === 'system') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
})();
