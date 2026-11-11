// Building blocks shared by the tool detail renderers.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Check, Copy, Download, FileText, LoaderCircle, PanelRightOpen } from 'lucide-preact';
import { cachedFullOutput, copyText, loadFullOutput, openFile } from '../../actions.js';
import { dirname, basename } from '../../lib/format.js';

export function CopyButton({ text, label = 'Copy', class: className = '' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (event) => {
    event.stopPropagation();
    if (!(await copyText(String(text ?? '')))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" class={`icon-btn icon-btn-sm copy-btn ${className}`} onClick={copy} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

// The tool's output, upgraded to the full stored text once "Load full output" is
// used (cached per message).
export function useToolOutput(message) {
  const [state, setState] = useState({ loading: false, error: null, full: null });
  const full = state.full ?? cachedFullOutput(message.id) ?? null;
  const load = async () => {
    setState({ loading: true, error: null, full: null });
    try {
      setState({ loading: false, error: null, full: await loadFullOutput(message) });
    } catch (error) {
      setState({ loading: false, error: error.message, full: null });
    }
  };
  return {
    output: full ?? (typeof message.output === 'string' ? message.output : message.output == null ? '' : JSON.stringify(message.output, null, 2)),
    truncated: !!message.outputTruncated && full == null,
    loading: state.loading,
    error: state.error,
    load,
  };
}

export function LoadFullOutput({ loading, error, load }) {
  return (
    <div class="load-full">
      <button type="button" class="btn btn-sm btn-secondary" onClick={load} disabled={loading}>
        {loading ? <LoaderCircle size={14} class="spin" /> : <Download size={14} />}
        Load full output
      </button>
      <span class="load-full-note">{error || 'Showing the first 4,000 characters.'}</span>
    </div>
  );
}

// Plain output text, collapsed to `maxLines` with a "Show all" button.
// Collapsed output is cut to `maxLines` lines and about `maxChars` characters (long
// lines wrap), so it needs no height limit or inner scrollbar of its own.
export function OutputBlock({ text, error = false, maxLines = 30, maxChars = 3000, class: className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const value = String(text ?? '');
  const lines = value.split('\n');
  const clipped = !expanded && (lines.length > maxLines + 5 || value.length > maxChars + 500);
  return (
    <div class={`output-block ${error ? 'is-error' : ''} ${expanded ? 'is-expanded' : ''} ${className}`}>
      <pre class="output-pre">{clipped ? clipText(lines.slice(0, maxLines).join('\n'), maxChars) : value}</pre>
      {clipped && (
        <button type="button" class="show-all" onClick={() => setExpanded(true)}>
          {lines.length > maxLines + 5 ? `Show all ${lines.length.toLocaleString('en-US')} lines` : `Show all ${value.length.toLocaleString('en-US')} characters`}
        </button>
      )}
    </div>
  );
}

// `text` cut to at most `maxChars` characters, at a line break when one is near.
function clipText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf('\n', maxChars);
  return text.slice(0, cut > maxChars * 0.8 ? cut : maxChars);
}

// Content clamped to a height with a fade and a "Show all" button when it overflows.
export function Clamp({ children, maxHeight = 320, class: className = '' }) {
  const ref = useRef(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return undefined;
    const measure = () => setOverflows(el.scrollHeight > maxHeight + 24);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, maxHeight]);
  const clamped = overflows && !expanded;
  return (
    <div class={`clamp ${clamped ? 'is-clamped' : ''} ${className}`}>
      <div class="clamp-body" ref={ref} style={clamped ? { maxHeight: maxHeight + 'px' } : undefined}>
        {children}
      </div>
      {clamped && (
        <button type="button" class="show-all" onClick={() => setExpanded(true)}>
          Show all
        </button>
      )}
    </div>
  );
}

export function Chip({ children, tone = '', mono = false, title }) {
  return (
    <span class={`tool-chip ${tone ? 'chip-' + tone : ''} ${mono ? 'mono' : ''}`} title={title}>
      {children}
    </span>
  );
}

export function Section({ label, children, aside }) {
  return (
    <div class="tool-section">
      <div class="tool-section-head">
        <span class="eyebrow">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

// A path shown as dimmed folder + bright file name; ellipsis cuts the folder.
export function PathLabel({ path }) {
  const dir = dirname(path);
  return (
    <span class="path-label mono" title={path}>
      <bdi>
        {dir && <span class="path-dir">{dir}/</span>}
        <span class="path-name">{basename(path, path)}</span>
      </bdi>
    </span>
  );
}

// Header row of file-based cards: icon, path, extras, and an Open action that shows
// the file in the side panel (at `line` when given).
export function FileHeader({ path, display, line = null, icon: Icon = FileText, children }) {
  return (
    <div class="file-header">
      <Icon size={14} class="file-header-icon" />
      <PathLabel path={display || path} />
      <span class="file-header-extra">{children}</span>
      {path && (
        <button type="button" class="btn btn-sm btn-ghost open-btn" onClick={() => openFile(path, line)} title={line ? `Open at line ${line}` : 'Open in the side panel'}>
          <PanelRightOpen size={14} />
          Open
        </button>
      )}
    </div>
  );
}

export function Note({ children, icon: Icon }) {
  return (
    <p class="tool-note">
      {Icon && <Icon size={14} />}
      {children}
    </p>
  );
}
