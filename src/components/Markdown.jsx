// Rendered markdown. HTML is memoized on the source text; code blocks get a header
// with the language and a copy button, and math is typeset. Clicks are handled here
// so every instance (transcript, approval card, plan panel) opens file links in the
// Files panel and copies code the same way.
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { memo } from '../memo.js';
import { copyText, openFile } from '../actions.js';
import { fileReference } from '../lib/fileReference.js';
import { localImageUrl } from '../lib/localImage.js';
import { renderMarkdown, renderMarkdownCached, splitBlocks } from '../lib/markdown.js';
import { typesetMath } from '../lib/typeset.js';
import { store } from '../state.js';
import './Markdown.css';

const COPY_LABEL = 'Copy';
const COPIED_LABEL = 'Copied';
const resetTimers = new WeakMap();

function decorate(root) {
  typesetMath(root);
  const sessionId = store.get().current?.id;
  for (const image of root.querySelectorAll('img[data-local-src]:not([src])')) {
    image.src = localImageUrl(image.dataset.localSrc, sessionId);
    image.classList.add('local-image');
  }
  for (const block of root.querySelectorAll('.code-block')) {
    if (block.querySelector(':scope > .code-head')) continue;
    const head = document.createElement('div');
    head.className = 'code-head';
    const lang = document.createElement('span');
    lang.className = 'code-lang';
    lang.textContent = block.dataset.lang || 'text';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'code-copy';
    copy.textContent = COPY_LABEL;
    copy.setAttribute('aria-label', 'Copy code');
    head.append(lang, copy);
    block.prepend(head);
  }
}

function showCopied(button) {
  clearTimeout(resetTimers.get(button));
  button.textContent = COPIED_LABEL;
  resetTimers.set(
    button,
    setTimeout(() => {
      button.textContent = COPY_LABEL;
    }, 1500),
  );
}

async function onClick(event) {
  // A local image opens full size in a new tab (it may be a large plot).
  const image = event.target.closest('img.local-image');
  if (image && !event.target.closest('a')) {
    window.open(image.src, '_blank', 'noopener');
    return;
  }
  const link = event.target.closest('a');
  if (link) {
    const ref = fileReference(link.getAttribute('href'), location.origin);
    if (ref) {
      event.preventDefault();
      openFile(ref.path, ref.line);
    }
    return;
  }
  const button = event.target.closest('.code-copy');
  if (!button) return;
  const code = button.closest('.code-block')?.querySelector('code')?.textContent || '';
  if (await copyText(code)) showCopied(button);
}

// `live` text changes on every streaming tick: it renders block by block (see
// splitBlocks), so a tick re-renders only the block still being written.
export function Markdown({ text, class: className = '', live = false }) {
  if (live) return <LiveMarkdown text={text} class={className} />;
  return <StaticMarkdown text={text} class={className} />;
}

function StaticMarkdown({ text, class: className }) {
  const html = useMemo(() => renderMarkdownCached(text), [text]);
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current) decorate(ref.current);
  }, [html]);
  return <div ref={ref} class={`markdown ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

function LiveMarkdown({ text, class: className }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div class={`markdown is-blocks ${className}`} onClick={onClick}>
      {blocks.map((source, index) => (
        <Block key={index} source={source} growing={index === blocks.length - 1} />
      ))}
    </div>
  );
}

// One block of streaming text; a finished block keeps its source, so it never re-renders.
// The growing one skips the shared cache (each tick is a new text).
const Block = memo(function Block({ source, growing }) {
  const html = growing ? renderMarkdown(source) : renderMarkdownCached(source);
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current) decorate(ref.current);
  }, [html]);
  return <div ref={ref} class="md-block" dangerouslySetInnerHTML={{ __html: html }} />;
});
