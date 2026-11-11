// Pixel position of a character offset inside a <textarea>, measured with a hidden
// mirror element that copies the textarea's text layout.

const COPIED = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
  'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'fontFeatureSettings', 'textAlign', 'textTransform',
  'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize',
];

// { top, left, height } of `position` relative to the textarea's border box, taking
// its scroll offset into account.
export function caretCoordinates(textarea, position) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement('div');
  for (const prop of COPIED) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    overflow: 'hidden',
    height: 'auto',
  });
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(position) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
  const result = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    height: lineHeight,
  };
  mirror.remove();
  return result;
}
