'use strict';

(() => {
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try {
    const saved = JSON.parse(localStorage.getItem('ft_theme'));
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {}

  function applyTheme() {
    const dark = (preference || (systemTheme.matches ? 'dark' : 'light')) === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
      toggle.setAttribute('aria-label', 'Dark mode');
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
    document.dispatchEvent(new Event('themechange'));
  }

  applyTheme();
  systemTheme.addEventListener('change', () => { if (!preference) applyTheme(); });
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('ft_theme', JSON.stringify(preference)); } catch {}
      applyTheme();
    });
  }, { once: true });
})();