// Diagnostics for dictation apps (Wispr Flow) whose text sometimes never reaches the
// message box: a rolling record of focus, key, paste and input events around the
// composer, sent to the server (data/input-log.jsonl) every few seconds. Only shapes are
// kept — key names for non-printing keys, lengths and caret positions — never the text.
import { api } from './api.js';

const FLUSH_MS = 3000;
const MAX_BUFFER = 400;
const NAMED_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'Meta', 'Control', 'Alt', 'Shift', 'Fn', 'CapsLock', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Unidentified', 'Process', 'Dead']);

let buffer = [];
let flushing = false;
let stopped = false;

function describe(el) {
  if (!el || el === document) return 'document';
  if (el === window) return 'window';
  if (el === document.body) return 'body';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return (el.tagName || el.nodeName || '?').toLowerCase() + (cls ? '.' + cls : '');
}

function boxState() {
  const box = document.querySelector('.composer-input');
  if (!box) return {};
  return { len: box.value.length, caret: box.selectionStart, end: box.selectionEnd, lines: box.value.split('\n').length, endsNl: box.value.endsWith('\n') };
}

function record(event) {
  const entry = { t: Date.now(), type: event.type, target: describe(event.target), active: describe(document.activeElement), focus: document.hasFocus(), ...boxState() };
  if (event.type === 'keydown' || event.type === 'keyup') {
    // Printable keys are logged only as "char" (with V kept: ⌘V is the paste).
    const key = event.key || '';
    entry.key = NAMED_KEYS.has(key) || key.toLowerCase() === 'v' ? key : key.length === 1 ? 'char' : key;
    entry.mods = [event.metaKey && 'meta', event.ctrlKey && 'ctrl', event.altKey && 'alt', event.shiftKey && 'shift'].filter(Boolean).join('+');
    if (event.isComposing) entry.composing = true;
    if (event.repeat) entry.repeat = true;
  }
  if (event.inputType) entry.inputType = event.inputType;
  if (typeof event.data === 'string') entry.dataLen = event.data.length;
  if (event.clipboardData) {
    entry.types = [...event.clipboardData.types].join(',');
    entry.pasteLen = event.clipboardData.getData('text/plain').length;
  }
  if (event.type === 'visibilitychange') entry.visibility = document.visibilityState;
  if (event.defaultPrevented) entry.prevented = true;
  // Whether the default action was cancelled is only known after the handlers ran.
  if (['keydown', 'paste', 'beforeinput'].includes(event.type)) {
    queueMicrotask(() => {
      if (event.defaultPrevented) entry.prevented = true;
    });
    // What the box holds once the event has done its work.
    setTimeout(() => {
      entry.after = boxState();
    }, 0);
  }
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
}

async function flush() {
  if (stopped) buffer = [];
  if (stopped || flushing || !buffer.length) return;
  flushing = true;
  const events = buffer;
  buffer = [];
  try {
    await api.post('debug/input-log', { events, ua: navigator.userAgent });
  } catch (error) {
    // Diagnostics only; dropped when the server is away. A server without the route
    // (deployed without a restart) gets none until the page is reloaded after one.
    if (error?.status === 404) stopped = true;
  } finally {
    flushing = false;
  }
}

export function startInputLog() {
  const capture = { capture: true, passive: true };
  for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'paste', 'focusin', 'focusout', 'compositionstart', 'compositionend']) {
    document.addEventListener(type, record, capture);
  }
  window.addEventListener('focus', record, capture);
  window.addEventListener('blur', record, capture);
  document.addEventListener('visibilitychange', record, capture);
  setInterval(flush, FLUSH_MS);
  window.addEventListener('pagehide', () => flush());
}
