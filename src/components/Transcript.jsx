// The conversation view: messages, tool activity (Activity.jsx), thinking, the live
// reply and the working indicator. Its scroller (TranscriptView) also shows an agent's
// conversation in the side panel (AgentPanel.jsx).
//
// Scrolling rules carried over from v1: stay pinned to the bottom only when the user
// is already near it, never move while they are selecting text in the transcript,
// and otherwise keep the first visible entry where it was.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowDown, Bot, Check, CircleAlert, CircleCheck, CircleStop, Copy, GitBranch, History, Info, LoaderCircle, ScrollText, TriangleAlert, Undo2, X } from 'lucide-preact';
import { copyText, forkSession, loadAllMessages, loadOlderMessages, openDialog, selectSession } from '../actions.js';
import { memo } from '../memo.js';
import { shallowEqual, useAppState } from '../state.js';
import { heldFrom } from '../store.js';
import { countRender } from '../lib/debug.js';
import { clockTime, formatCost, formatDuration, formatNumber } from '../lib/format.js';
import { steerFrom, steerNote } from '../lib/agents.js';
import { canForkFrom, splitForkNotice } from '../lib/fork.js';
import { isBusy } from '../lib/sessions.js';
import { importBanner, messageTime } from '../lib/imports.js';
import { effortName, findModel, showsCost } from '../lib/models.js';
import { toolDisplayName } from '../lib/tools.js';
import { buildEntries, liveEntries } from '../lib/transcript.js';
import { ActivityGroup, AgentEvent, ThinkingBlock } from './Activity.jsx';
import { ArtifactCard } from './ArtifactCard.jsx';
import { MessageAttachments } from './composer/Attachments.jsx';
import { Elapsed } from './Elapsed.jsx';
import { Markdown } from './Markdown.jsx';
import { ModelIcon } from './ModelIcon.jsx';
import { Clamp, CopyButton } from './tools/shared.jsx';
import './Transcript.css';

const NEAR_BOTTOM = 100;
// Streaming text is revealed in steps at most this often (about 30 per second), each
// step a share of what has arrived but is not shown yet.
const REVEAL_STEP_MS = 32;
const REVEAL_SHARE = 0.18;
const REVEAL_MIN_CHARS = 3;
// A session opens with its latest entries; older ones are added as the reader scrolls
// up (well before the top comes into view). Opening a long session (800 messages) then
// renders a screenful or two instead of everything, so the click that opened it paints
// in a frame or two even on a slow laptop. A session held from its tail (lib/tail.js)
// loads its older messages the same way once every entry held is shown.
const FIRST_ENTRIES = 50;
const MORE_ENTRIES = 50;
const LOAD_MARGIN = '1200px';

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;

function selectingIn(el) {
  const selection = globalThis.getSelection?.();
  return !!selection && !selection.isCollapsed && el.contains(selection.anchorNode);
}

// First child whose bottom edge is below `top` (children are stacked vertically).
function firstVisibleChild(column, top) {
  const nodes = column.children;
  let low = 0;
  let high = nodes.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (nodes[mid].getBoundingClientRect().bottom > top) {
      found = nodes[mid];
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

// Where the reader was in each view they scrolled up in (view key -> the first entry in
// sight and its offset from the top), so coming back to a session returns there. A
// view left at the bottom opens at the bottom, new messages and all.
const positions = new Map();
const POSITIONS_MAX = 100;

function savePosition(viewKey, scroller, column, rendered, stuck) {
  positions.delete(viewKey);
  if (viewKey == null || stuck || !scroller || !column) return;
  const top = scroller.getBoundingClientRect().top;
  const child = firstVisibleChild(column, top);
  const entry = child && rendered[Array.prototype.indexOf.call(column.children, child)];
  if (!entry) return;
  positions.set(viewKey, { key: entry.key, offset: child.getBoundingClientRect().top - top });
  if (positions.size > POSITIONS_MAX) positions.delete(positions.keys().next().value);
}

// New entries at the end rise into place. Transform and opacity only (the compositor
// runs them), none while the page is hidden or the reader asked for less motion.
const ENTER_FRAMES = [
  { opacity: 0, transform: 'translateY(6px)' },
  { opacity: 1, transform: 'none' },
];
const ENTER_MAX = 6;
const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

function animateAppended(last) {
  if (document.hidden || reducedMotion?.matches || !last?.isConnected) return;
  let count = 0;
  for (let node = last.nextElementSibling; node && count < ENTER_MAX; node = node.nextElementSibling, count++) {
    node.animate?.(ENTER_FRAMES, { duration: 240, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' });
  }
}

// Assigning scrollTop cancels a smooth scroll in progress, so only move when needed.
function scrollToBottom(scroller) {
  const max = scroller.scrollHeight - scroller.clientHeight;
  if (Math.abs(scroller.scrollTop - max) >= 1) scroller.scrollTop = max;
}

// Streaming text at an even pace: what arrives in a burst (a slow link delivers a
// second's worth at once) plays out over the next frames instead of appearing at once.
// The pace follows the backlog, so the text is never far behind; text that is not a
// continuation of what is shown, and a hidden page, show at once.
function useRevealed(text) {
  const [shown, setShown] = useState(text);
  const reveal = useRef({ shown: text, frame: 0, last: 0 });
  useEffect(() => {
    const state = reveal.current;
    if (!text.startsWith(state.shown) || document.hidden) {
      state.shown = text;
      setShown(text);
      return;
    }
    const step = (now) => {
      state.frame = 0;
      if (now - state.last < REVEAL_STEP_MS) {
        state.frame = requestAnimationFrame(step);
        return;
      }
      state.last = now;
      const backlog = text.length - state.shown.length;
      const next = document.hidden ? text.length : state.shown.length + Math.max(REVEAL_MIN_CHARS, Math.ceil(backlog * REVEAL_SHARE));
      state.shown = text.slice(0, Math.min(text.length, next));
      setShown(state.shown);
      if (state.shown.length < text.length) state.frame = requestAnimationFrame(step);
    };
    if (state.shown.length < text.length) state.frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, [text]);
  return shown;
}

export function Transcript() {
  const { session, info, scrollNonce } = useAppState((s) => ({ session: s.current, info: s.info, scrollNonce: s.scrollNonce }), shallowEqual);
  // Streaming ticks keep `messages` identical, so only the live tail is rebuilt and
  // the memoized entries above it do not re-render. Structural updates reuse every
  // unchanged entry from the previous build (see buildEntries).
  const previousBase = useRef(null);
  const base = useMemo(() => {
    const next = buildEntries(session?.messages, previousBase.current);
    previousBase.current = next;
    return next;
  }, [session?.messages]);
  const entries = useMemo(() => (session ? [...base.entries, ...liveEntries(session, base)] : []), [base, session]);
  if (!session) return null;
  return (
    <TranscriptView
      entries={entries}
      viewKey={session.id}
      scrollNonce={scrollNonce}
      pageKeys
      cwd={session.cwd}
      info={info}
      empty="No messages yet. Say hello below."
      before={session.source && <ImportBanner session={session} info={info} />}
      older={heldFrom(session) > 0}
      onOlder={loadOlderMessages}
      onAll={loadAllMessages}
    />
  );
}

/**
 * The scrolling list of entries, shared by the main transcript and the agent view
 * (AgentPanel.jsx): windowed (the latest entries first, older ones as the reader scrolls
 * up), pinned to the bottom while the reader is there. A new `viewKey` starts over at
 * the bottom, as does a new `scrollNonce`. `speaker` names who writes the replies when
 * it is not the session's model (an agent). `older`: there are older messages to load
 * (a session held from its tail): `onOlder()` loads the previous page once every entry
 * is shown and the top nears (resolving to whether it added any), `onAll()` all of them
 * (for find in page). Entries added in front keep the reader where they were.
 */
export function TranscriptView({ entries, viewKey, scrollNonce = 0, cwd, info, speaker = null, empty = '', before = null, older = false, onOlder = null, onAll = null, pageKeys = false, class: className = '' }) {
  const scrollRef = useRef(null);
  const columnRef = useRef(null);
  const moreRef = useRef(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // The entries on screen, one element each (savePosition maps them to the DOM).
  const rendered = useRef([]);
  // Where to put a view that is opened again (positions), once it has rendered.
  const restore = useRef(null);
  const loaders = useRef(null);
  loaders.current = { older: older && !!onOlder, onOlder, onAll: older ? onAll : null };

  // The first entry rendered, per view: its index (`from`) and key, and the next one's
  // key. New entries always render; older ones join in batches when the sentinel above
  // them nears the viewport. Entries added in front (older messages loaded) move the
  // index so the same entry stays first; `all` renders every entry (find in page).
  const shown = useRef({ id: null, from: 0 });
  const [, showMore] = useState(0);
  if (shown.current.id !== viewKey) {
    // The DOM still shows the view being left.
    if (shown.current.id !== null) savePosition(shown.current.id, scrollRef.current, columnRef.current, rendered.current, stick.current);
    const saved = positions.get(viewKey);
    const index = saved ? entries.findIndex((entry) => entry.key === saved.key) : -1;
    const latest = Math.max(0, entries.length - FIRST_ENTRIES);
    restore.current = index >= 0 ? saved : null;
    shown.current = { id: viewKey, from: index >= 0 ? Math.min(latest, Math.max(0, index - 10)) : latest, all: false, key: null, next: null };
  }
  const view = shown.current;
  if (view.all) view.from = 0;
  else if (view.key != null && entries[view.from]?.key !== view.key) {
    // The first entry shown may have merged with older ones (a group of tool calls): then
    // the one after it stays in place.
    const at = entries.findIndex((entry) => entry.key === view.key);
    const next = at < 0 && view.next != null ? entries.findIndex((entry) => entry.key === view.next) : -1;
    const found = at >= 0 ? at : next > 0 ? next - 1 : -1;
    // A page loaded while every entry was shown: a batch of it shows at once, so a reader
    // at the very top keeps their place as the loading note above goes.
    if (found >= 0) view.from = view.from === 0 ? Math.max(0, found - MORE_ENTRIES) : found;
  }
  const from = Math.min(view.from, Math.max(0, entries.length - FIRST_ENTRIES));
  view.key = entries[from]?.key ?? null;
  view.next = entries[from + 1]?.key ?? null;
  // A turn end shown with its reply renders nothing; leaving it out keeps one element per entry.
  const visible = (from > 0 ? entries.slice(from) : entries).filter((entry) => !entry.merged);
  rendered.current = visible;

  // Loading the previous page of a tail: `loading`, or `failed` (a button tries again).
  const [olderLoad, setOlderLoad] = useState({ key: viewKey, state: 'idle' });
  const olderState = olderLoad.key === viewKey ? olderLoad.state : 'idle';
  const loadOlder = () => {
    const key = viewKey;
    setOlderLoad({ key, state: 'loading' });
    Promise.resolve(loaders.current.onOlder?.()).then(
      (added) => setOlderLoad((load) => (load.key === key ? { key, state: added ? 'idle' : 'failed' } : load)),
      () => setOlderLoad((load) => (load.key === key ? { key, state: 'failed' } : load)),
    );
  };
  const wantsOlder = from === 0 && loaders.current.older;

  useEffect(() => {
    const sentinel = moreRef.current;
    const scroller = scrollRef.current;
    if (!sentinel || !scroller || typeof IntersectionObserver === 'undefined') return;
    if (from === 0 && (!wantsOlder || olderState !== 'idle')) return;
    // A fresh observer reports at once, so a sentinel still in range after a batch (or a
    // page) brings the next one.
    const observer = new IntersectionObserver(
      (records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        observer.disconnect();
        if (from === 0) return loadOlder();
        shown.current = { ...shown.current, from: Math.max(0, from - MORE_ENTRIES), key: null, next: null };
        showMore((n) => n + 1);
      },
      { root: scroller, rootMargin: `${LOAD_MARGIN} 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [from, viewKey, wantsOlder, olderState]);

  // The browser's find (Ctrl/Cmd+F) only sees rendered rows: render them all first, and
  // load the messages not held yet.
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
      const { onAll } = loaders.current;
      if (!shown.current.from && !onAll) return;
      shown.current = { ...shown.current, from: 0, all: true, key: null, next: null };
      showMore((n) => n + 1);
      onAll?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Measure before the DOM updates (render runs before commit). The anchor is only
  // needed when the view is not pinned to the bottom.
  const snapshot = useRef(null);
  const el = scrollRef.current;
  if (el && columnRef.current) {
    const atBottom = nearBottom(el);
    const selecting = selectingIn(el);
    let anchor = null;
    let anchorTop;
    if (!atBottom || selecting) {
      anchor = firstVisibleChild(columnRef.current, el.getBoundingClientRect().top);
      anchorTop = anchor?.getBoundingClientRect().top;
    }
    snapshot.current = { atBottom, selecting, anchor, anchorTop, last: columnRef.current.lastElementChild, view: viewKey };
  }

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const snap = snapshot.current;
    if (!scroller || !snap) return;
    if (snap.view === viewKey) animateAppended(snap.last);
    if (snap.atBottom && !snap.selecting) scrollToBottom(scroller);
    else if (snap.anchor?.isConnected && snap.anchorTop !== undefined) {
      const delta = snap.anchor.getBoundingClientRect().top - snap.anchorTop;
      if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
    }
  });

  // Another session or agent: back where the reader left it, else at the bottom. An
  // explicit "scroll to latest" always goes to the bottom.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const target = restore.current;
    restore.current = null;
    const index = target ? visible.findIndex((entry) => entry.key === target.key) : -1;
    const node = index >= 0 ? columnRef.current?.children[index] : null;
    if (node) {
      scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - target.offset;
      if (!nearBottom(scroller)) {
        stick.current = false;
        setShowJump(true);
        return;
      }
    }
    scrollToBottom(scroller);
    stick.current = true;
    setShowJump(false);
  }, [scrollNonce, viewKey]);

  // Page Up / Page Down page the conversation from the composer too (it is rarely a
  // page tall), smoothly.
  useEffect(() => {
    if (!pageKeys) return;
    const onKey = (event) => {
      if ((event.key !== 'PageUp' && event.key !== 'PageDown') || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const scroller = scrollRef.current;
      const target = event.target;
      if (!scroller || !(target === document.body || target.closest?.('.composer'))) return;
      event.preventDefault();
      scroller.scrollBy({ top: (event.key === 'PageUp' ? -0.85 : 0.85) * scroller.clientHeight, behavior: 'smooth' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageKeys]);

  // Keep the bottom pinned when content grows after render (fonts, expanding rows)
  // and when the viewport shrinks (taller composer, banners, the mobile keyboard).
  useEffect(() => {
    const scroller = scrollRef.current;
    const column = columnRef.current;
    if (!scroller || !column || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current && !selectingIn(scroller)) scrollToBottom(scroller);
    });
    observer.observe(column);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Scroll events can arrive after an unmount (smooth scrolling), so read the target
  // from the event rather than the ref.
  const onScroll = (event) => {
    const atBottom = nearBottom(event.currentTarget);
    stick.current = atBottom;
    setShowJump(!atBottom);
  };

  const jump = () => {
    const scroller = scrollRef.current;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div class={`transcript-wrap ${className}`}>
      {before}
      <div class="transcript" ref={scrollRef} onScroll={onScroll}>
        {from > 0 && <div class="transcript-more" ref={moreRef} aria-hidden="true" />}
        {wantsOlder && (
          <div class="transcript-older" ref={moreRef}>
            {olderState === 'failed' ? (
              <button type="button" class="btn btn-sm btn-ghost transcript-older-btn" onClick={loadOlder}>
                <History size={14} />
                Load earlier messages
              </button>
            ) : (
              <span class="transcript-older-note" role="status">
                <LoaderCircle size={14} class="spin" aria-hidden="true" />
                Loading earlier messages…
              </span>
            )}
          </div>
        )}
        <div class="transcript-column" ref={columnRef}>
          {visible.map((entry) => (
            <Entry key={entry.key} entry={entry} cwd={cwd} info={info} speaker={speaker} />
          ))}
          {!entries.length && !wantsOlder && empty && <p class="transcript-empty">{empty}</p>}
        </div>
      </div>
      {showJump && (
        <button type="button" class="jump-latest" onClick={jump}>
          <ArrowDown size={14} />
          Latest
        </button>
      )}
    </div>
  );
}

// Sessions whose import banner was closed (for this page's lifetime).
const closedBanners = new Set();

// Pinned above an imported session until its first turn here, so it is seen even
// though a long history opens scrolled to the end.
function ImportBanner({ session, info }) {
  const [, setClosed] = useState(0);
  const modelName = findModel(info, session.model).name;
  const banner = useMemo(() => importBanner(session, modelName), [session.messages, session.source, modelName]);
  if (!banner || closedBanners.has(session.id)) return null;
  const close = () => {
    closedBanners.add(session.id);
    setClosed((n) => n + 1);
  };
  return (
    <div class={`import-banner source-${session.source.kind}`} role="note">
      <History size={15} class="import-banner-icon" />
      <p>
        <strong>{banner.lead}</strong> {banner.text}
      </p>
      <button type="button" class="icon-btn icon-btn-sm import-banner-close" onClick={close} aria-label="Hide this note" title="Hide">
        <X size={14} />
      </button>
    </div>
  );
}

// Memoized: entries built from unchanged messages keep their identity, so a
// streaming tick re-renders only the live tail. Only what every entry shares is passed
// down (the session's model and effort are read by the few rows that show them), so a
// model, mode or status change re-renders no message.
const Entry = memo(function Entry({ entry, cwd, info, speaker }) {
  countRender('Entry');
  switch (entry.type) {
    case 'user':
      return <UserMessage message={entry.message} />;
    case 'assistant':
      return <AssistantMessage entry={entry} info={info} speaker={speaker} />;
    case 'live':
      return <LiveMessage entry={entry} info={info} />;
    case 'thinking':
      return <ThinkingBlock text={entry.message.text} duration={entry.duration} />;
    case 'live-thinking':
      return <ThinkingBlock text={entry.text} live />;
    case 'activity':
      return <ActivityGroup entry={entry} cwd={cwd} />;
    case 'working':
      return <WorkingRow entry={entry} />;
    case 'notice':
      return <Notice message={entry.message} />;
    case 'agent-event':
      return <AgentEvent entry={entry} cwd={cwd} />;
    case 'artifact':
      return <ArtifactCard message={entry.message} />;
    case 'turn':
      // A normal end shows with the reply's actions (entry.footer, lib/transcript.js).
      if (entry.merged) return null;
      return (
        <TurnFooter
          duration={entry.message.duration}
          tokens={entry.message.outputTokens}
          cost={entry.message.cost}
          costModel={entry.message.model}
          info={info}
          isError={entry.message.isError}
          stopped={entry.message.stopped}
          interrupted={entry.message.interrupted}
        />
      );
    case 'summary':
      return <TurnFooter duration={entry.duration} tokens={entry.tokens} cost={entry.cost} info={info} />;
    case 'agent-prompt':
      return <AgentPrompt entry={entry} />;
    case 'steer':
      return <SteerMessage message={entry.message} info={info} />;
    case 'agent-report':
      return <AgentReport entry={entry} />;
    case 'agent-end':
      return <AgentEnd entry={entry} />;
    default:
      return null;
  }
});

const DELIVERY_NOTES = { stopped: 'Stopped', interrupted: 'Interrupted', error: 'Failed', running: '' };

function UserMessage({ message }) {
  const note = DELIVERY_NOTES[message.delivery];
  // The open session's id when this message can start a fork (see lib/fork.js).
  const forkId = useAppState((s) => (canForkFrom(message, s.current) ? s.current.id : null));
  // Rewinding waits for the turn (and its agents) to end.
  const canRewind = useAppState((s) => Boolean(forkId) && !isBusy(s.current));
  return (
    <div class="msg-user">
      <MessageAttachments attachments={message.attachments} />
      <div class="user-bubble">{message.text}</div>
      <div class="msg-foot">
        {forkId && (
          <div class="msg-actions">
            <button
              type="button"
              class="msg-action"
              onClick={() => forkSession(forkId, { messageId: message.id })}
              aria-label="Fork from here"
              title="New session with everything before this message; this message goes into the composer to edit"
            >
              <GitBranch size={14} />
              <span>Fork from here</span>
            </button>
            {canRewind && (
              <button
                type="button"
                class="msg-action"
                onClick={() => openDialog('rewind', { sessionId: forkId, messageId: message.id })}
                aria-label="Rewind to here"
                title="Go back to before this message in this session, optionally putting Claude's file edits back too"
              >
                <Undo2 size={14} />
                <span>Rewind</span>
              </button>
            )}
          </div>
        )}
        <div class="msg-meta">
          {message.imported ? messageTime(message.at) : clockTime(message.at)}
          {note && <span class="msg-meta-note"> · {note}</span>}
        </div>
      </div>
    </div>
  );
}

// Heads the first reply after the model changed (and a session's first reply).
function AssistantHeader({ modelId, effort, info }) {
  const model = findModel(info, modelId);
  return (
    <div class="assistant-head">
      <ModelIcon model={model} size={13} />
      <span class="assistant-model">{model.name}</span>
      {effort && <span class="effort-chip">{effortName(effort)}</span>}
    </div>
  );
}

// An agent's replies are headed by the agent (its kind, or a model agent's model).
function SpeakerHeader({ speaker, at, imported }) {
  return (
    <div class="assistant-head">
      {speaker.model ? <ModelIcon model={speaker.model} size={14} /> : <Bot size={14} class="model-icon" />}
      <span class="assistant-model">{speaker.name}</span>
      {at && <span class="assistant-time">{imported ? messageTime(at) : clockTime(at)}</span>}
    </div>
  );
}

function AssistantMessage({ entry, info, speaker }) {
  const { message } = entry;
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef(null);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const copy = async () => {
    if (!(await copyText(entry.turnText ?? message.text))) return;
    setCopied(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    // has-turn-end: the turn ended normally here (its stats sit in the actions row).
    <div class={entry.footer ? 'msg-assistant has-turn-end' : 'msg-assistant'}>
      {entry.showHeader &&
        (speaker ? (
          <SpeakerHeader speaker={speaker} at={message.at} imported={message.imported} />
        ) : (
          <AssistantHeader modelId={message.model} effort={message.effort} info={info} />
        ))}
      <Markdown text={message.text} />
      {entry.turnEnd && (
        <div class="msg-actions">
          <button type="button" class="msg-action icon-only" onClick={copy} aria-label="Copy response" title={copied ? 'Copied' : 'Copy response'}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <span class="msg-stats">
            {message.at && <span class="assistant-time">{message.imported ? messageTime(message.at) : clockTime(message.at)}</span>}
            {entry.footer && <TurnStats turn={entry.footer} info={info} />}
          </span>
        </div>
      )}
    </div>
  );
}

// "15s · 1,301 tokens · $0.10" for a turn that ended normally.
function TurnStats({ turn, info }) {
  const sessionModel = useAppState((s) => (turn.model ? null : s.current?.model));
  const parts = [];
  if (turn.duration) parts.push(formatDuration(turn.duration));
  if (turn.outputTokens) parts.push(`${formatNumber(turn.outputTokens)} tokens`);
  if (turn.cost && showsCost(info, turn.model || sessionModel)) parts.push(formatCost(turn.cost));
  return parts.length ? <span>{parts.join(' · ')}</span> : null;
}

// The open session's model and its chosen effort (null for the default).
function useSessionModel() {
  return useAppState(
    (s) => {
      const effort = s.current?.efforts?.[s.current?.model];
      return { modelId: s.current?.model, effort: effort && effort !== 'default' ? effort : null };
    },
    shallowEqual,
  );
}

function LiveMessage({ entry, info }) {
  const text = useRevealed(entry.text);
  const { modelId, effort } = useSessionModel();
  return (
    <div class="msg-assistant is-live">
      {entry.showHeader && <AssistantHeader modelId={modelId} effort={effort} info={info} />}
      <Markdown text={text} class="live-cursor" live />
    </div>
  );
}

// Shown while the session is busy and nothing is streaming: what is happening now
// and for how long.
function WorkingRow({ entry }) {
  const connection = useAppState((s) => s.connection);
  let label = 'Thinking';
  let timer = <Elapsed since={entry.since || entry.startedAt} class="working-time" />;
  if (entry.waiting) label = 'Waiting for you';
  else if (entry.compacting) {
    label = 'Compacting conversation';
    timer = <Elapsed since={entry.compacting} class="working-time" />;
  }
  // A worker between turns: its Monitors or background commands will wake it.
  else if (entry.waitingOn) label = `Waiting on ${entry.waitingOn} background ${entry.waitingOn === 1 ? 'task' : 'tasks'}`;
  else if (entry.tool) {
    label = `Running ${toolDisplayName(entry.tool)}`;
    timer = <Elapsed since={entry.toolAt || entry.startedAt} elapsed={entry.toolElapsed} class="working-time" />;
  } else if (connection === 'offline') label = 'Reconnecting';
  return (
    <div class={`working ${entry.waiting ? 'is-waiting' : ''}`} role="status">
      <span class="working-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span class={entry.waiting ? 'working-label' : 'working-label shimmer'}>{label}</span>
      <span class="working-sep">·</span>
      {timer}
    </div>
  );
}

const NOTICE_ICONS = { info: Info, warning: TriangleAlert, error: CircleAlert };

function Notice({ message }) {
  const level = message.level || (/fail|error|could not/i.test(message.text) ? 'error' : 'info');
  const Icon = NOTICE_ICONS[level] || Info;
  // A fork's notice names the session it came from, which opens it while it still exists.
  const original = useAppState((s) => !!message.forkOf && s.sessions.some((x) => x.id === message.forkOf));
  const parts = original ? splitForkNotice(message.text) : null;
  return (
    <div class={`notice notice-${level}`} role="note">
      <Icon size={14} />
      {parts ? (
        <span>
          {parts.before}
          <button type="button" class="notice-link" onClick={() => selectSession(message.forkOf)} title="Open the original session">
            {parts.title}
          </button>
          {parts.after}
        </span>
      ) : (
        <span>{message.text}</span>
      )}
    </div>
  );
}

/* The agent view's own rows (lib/agentTranscript.js) */

// The task an agent was given, as the first message of its transcript; long ones fold.
function AgentPrompt({ entry }) {
  return (
    <div class="msg-user agent-prompt">
      <div class="user-bubble">
        <Clamp maxHeight={220}>{entry.text}</Clamp>
      </div>
      <div class="msg-meta">
        Task{entry.at ? ` · ${clockTime(entry.at)}` : ''}
      </div>
    </div>
  );
}

// A message sent to the agent: by the user (from the message box of this panel, or from
// another device) or by the lead, the session's main model. Under it, who and when,
// and while it has not been read: `sending` (still on its way to the server, only
// here), `sent` (the agent reads it at its next step) or `dropped` (it ended first).
function SteerMessage({ message, info }) {
  const lead = steerFrom(message) === 'lead';
  const leadModel = useAppState((s) => (lead ? s.current?.model : null));
  const model = lead ? findModel(info, leadModel) : null;
  const sending = message.delivery === 'sending';
  const note = sending ? 'Sending…' : steerNote(message);
  return (
    <div class={`msg-user steer-msg is-${lead ? 'lead' : 'user'} ${sending ? 'is-sending' : ''} ${message.delivery === 'dropped' ? 'is-dropped' : ''}`}>
      <div class="user-bubble">
        <Clamp maxHeight={220}>{message.text}</Clamp>
      </div>
      <div class="msg-meta">
        {lead && <ModelIcon model={model} size={12} />}
        <span class="steer-from">{lead ? `Lead · ${model.name}` : 'You'}</span>
        {message.at && <span> · {message.imported ? messageTime(message.at) : clockTime(message.at)}</span>}
        {note && (
          <span class="msg-meta-note">
            {' · '}
            {sending && <LoaderCircle size={11} class="spin" aria-hidden="true" />}
            {note}
          </span>
        )}
      </div>
    </div>
  );
}

// What the agent handed back (or why it failed).
function AgentReport({ entry }) {
  return (
    <section class={`agent-report ${entry.error ? 'is-error' : ''}`} aria-label={entry.error ? 'Error' : 'Report'}>
      <div class="agent-report-head">
        {entry.error ? <TriangleAlert size={14} /> : <ScrollText size={14} />}
        <span>{entry.error ? 'Error' : 'Report'}</span>
        <CopyButton text={entry.text} label={entry.error ? 'Copy error' : 'Copy report'} />
      </div>
      {entry.error ? <pre class="agent-report-error">{entry.text}</pre> : <Markdown text={entry.text} class="agent-report-text" />}
    </section>
  );
}

const AGENT_ENDS = { finished: 'Done', failed: 'Failed', stopped: 'Stopped' };

// A stopped agent says who stopped it ("Stopped by the lead") and, when the lead gave
// one, why.
function AgentEnd({ entry }) {
  const tone = entry.outcome === 'failed' ? 'is-error' : entry.outcome === 'stopped' ? 'is-stopped' : '';
  const Icon = entry.outcome === 'failed' ? TriangleAlert : entry.outcome === 'stopped' ? CircleStop : CircleCheck;
  return (
    <div class={`turn-footer agent-end ${tone}`}>
      <Icon size={13} />
      <span>{entry.label || AGENT_ENDS[entry.outcome] || 'Ended'}</span>
      {entry.reason && <span class="agent-end-reason">{entry.reason}</span>}
      {entry.stats && <span class="turn-stats">{entry.stats}</span>}
    </div>
  );
}

// `cost` shows only for models billed per token (`costModel`, else the session's).
function TurnFooter({ duration, tokens, cost, costModel, info, isError, stopped, interrupted }) {
  const sessionModel = useAppState((s) => (costModel ? null : s.current?.model));
  const parts = [];
  if (duration) parts.push(formatDuration(duration));
  if (tokens) parts.push(`${formatNumber(tokens)} output tokens`);
  const price = cost && showsCost(info, costModel || sessionModel) ? formatCost(cost) : '';
  if (price) parts.push(price);
  const tone = isError ? 'is-error' : stopped || interrupted ? 'is-stopped' : '';
  return (
    <div class={`turn-footer ${tone}`}>
      {isError ? <TriangleAlert size={13} /> : stopped || interrupted ? <CircleStop size={13} /> : <CircleCheck size={13} />}
      <span>{isError ? 'Ended with an error' : interrupted ? 'Interrupted for your messages' : stopped ? 'Stopped' : 'Done'}</span>
      {parts.length > 0 && <span class="turn-stats">{parts.join(' · ')}</span>}
    </div>
  );
}
