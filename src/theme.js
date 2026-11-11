// Theme preference: 'dark' (default), 'light' or 'system'. The <html> data-theme
// attribute always holds the resolved palette ('dark' or 'light'): public/theme-boot.js
// sets it before first paint, and this module keeps it in sync afterwards.
import { KEYS, getItem, setItem } from './lib/storage.js';

export const THEMES = ['system', 'dark', 'light'];

const lightQuery = () => globalThis.matchMedia?.('(prefers-color-scheme: light)');

export function readTheme() {
  const saved = getItem(KEYS.theme);
  return THEMES.includes(saved) ? saved : 'dark';
}

export function resolveTheme(theme) {
  if (theme !== 'system') return theme === 'light' ? 'light' : 'dark';
  return lightQuery()?.matches ? 'light' : 'dark';
}

// Meta tags cannot read CSS variables, so copy the resolved --bg-strong over.
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg-strong').trim();
  if (meta && color) meta.setAttribute('content', color);
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = resolveTheme(theme);
  syncThemeColor();
}

export function saveTheme(theme) {
  setItem(KEYS.theme, theme);
  applyTheme(theme);
}

if (typeof document !== 'undefined') {
  applyTheme(readTheme());
  lightQuery()?.addEventListener?.('change', () => applyTheme(readTheme()));
}
