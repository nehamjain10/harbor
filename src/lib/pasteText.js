// Text pastes are inserted from the paste event's own data instead of Chrome's default
// action. Dictation apps (Wispr Flow) put the transcript on the clipboard, press ⌘V and
// put the old clipboard back right away; Chrome's default paste reads the clipboard
// again after the event, and on a busy page it can lose that race and insert nothing
// (or the old clipboard). The event's data is the transcript.

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', 'password', '']);

function plainField(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.has((el.getAttribute('type') || '').toLowerCase());
}

/** Inserts `text` at the field's selection, as typing would (undo, `input` event). */
export function insertText(el, text) {
  el.focus();
  // execCommand keeps the native undo stack and fires beforeinput/input.
  if (globalThis.document?.execCommand?.('insertText', false, text)) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.setRangeText(text, start, end, 'end');
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
}

export function onTextPaste(event) {
  const el = event.target;
  if (event.defaultPrevented || !plainField(el)) return;
  const data = event.clipboardData;
  // Files (and pictures with text, see Composer.jsx) are handled by the field itself.
  if (!data || data.files?.length) return;
  const text = data.getData('text/plain');
  if (!text) return;
  event.preventDefault();
  insertText(el, text.replace(/\r\n?/g, '\n'));
}

export function installTextPaste(doc = globalThis.document) {
  doc.addEventListener('paste', onTextPaste, true);
}
