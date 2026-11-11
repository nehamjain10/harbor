// Small keyboard helpers for the composer.

export const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');

// "Press twice to confirm": the first press arms it, a second press within
// `windowMs` fires. Returns 'armed' or 'fire'.
export function createDoublePress({ windowMs = 1500, now = () => Date.now() } = {}) {
  let armedAt = null;
  return {
    press() {
      const t = now();
      if (armedAt != null && t - armedAt <= windowMs) {
        armedAt = null;
        return 'fire';
      }
      armedAt = t;
      return 'armed';
    },
    reset() {
      armedAt = null;
    },
    get armed() {
      return armedAt != null && now() - armedAt <= windowMs;
    },
  };
}

// True for elements where typed characters go into text (so single-key shortcuts
// must not fire).
export function isTextEntry(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes((el.type || 'text').toLowerCase());
}
