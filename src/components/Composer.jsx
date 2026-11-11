// Docked composer: textarea with per-session drafts and attachments, `@` file and `/`
// command menus, model/mode/effort chips, context ring, send / queue / stop (Esc
// twice), plus the bars that sit above it (connection, queue, approval). While a turn
// runs, Enter sends the message into it (Claude reads it at its next step) and
// Alt+Enter or the queue button keeps it for after the turn.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowUp, AtSign, BookOpen, CircleHelp, CornerDownRight, Cpu, Eraser, File, Folder, Gauge, Hand, ListPlus, LoaderCircle, Pause, Pencil, Play, Plus, Sparkles, Square, SquareSlash, WifiOff, X, Zap } from 'lucide-preact';
import { activeModel, cancelQueued, interruptAndSend, resumeQueue, sendMessage, shownAgent, stopSession, toast, warmForTyping } from '../actions.js';
import {
  addFiles, attachmentItems, cachedCommands, clearSentItems, commandScope, completeFiles, hydrateAttachments, loadCommands,
  runLocalCommand, slotFor,
} from '../composer.js';
import { shallowEqual, store, useAppState } from '../state.js';
import { folderClusterId } from '../lib/clusters.js';
import { isInterrupting, isStopping } from '../store.js';
import { KEYS, getItem, removeItem, setItem } from '../lib/storage.js';
import { basename, dirname } from '../lib/format.js';
import { isBusy } from '../lib/sessions.js';
import { detectTrigger, insertToken, mentionText } from '../lib/mentions.js';
import { groupCommands, mergeCommands, parseLocalCommand } from '../lib/commands.js';
import { createDoublePress, isTextEntry } from '../lib/keys.js';
import { caretCoordinates } from '../lib/caret.js';
import { isImage } from '../lib/uploads.js';
import { currentStep, runningLabel } from '../lib/tools.js';
import { Elapsed, useNow } from './Elapsed.jsx';
import { ClusterPicker, EffortPicker, ModePicker, ModelPicker } from './Pickers.jsx';
import { ApprovalCard } from './ApprovalCard.jsx';
import { AgentsStrip } from './AgentsStrip.jsx';
import { TasksStrip } from './TasksStrip.jsx';
import { AttachmentTray } from './composer/Attachments.jsx';
import { ContextMeter } from './composer/ContextMeter.jsx';
import { SuggestMenu } from './composer/SuggestMenu.jsx';
import './Composer.css';

const MAX_LINES = 12;
const MENTION_DEBOUNCE = 120;
const STOP_HINT_MS = 1500;
// Enter sends where there is a hardware keyboard (fine pointer); phones keep Enter for newlines.
const desktop = () => globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
const canHover = () => globalThis.matchMedia?.('(hover: hover)').matches;
const narrow = () => globalThis.matchMedia?.('(max-width: 759px)').matches;

const LOCAL_ICONS = { clear: Eraser, model: Cpu, mode: Hand, effort: Gauge, rename: Pencil, help: CircleHelp };
const NONE = [];
// Claude Code runs a message starting with `/name` as a slash command.
const isSlashCommand = (text) => /^\/[^\s/]/.test(text);

export function ComposerArea() {
  const hasSession = useAppState((s) => !!s.current);
  return (
    <section class={`composer-area ${hasSession ? '' : 'is-new'}`}>
      <div class="composer-column">
        <ConnectionBanner />
        {hasSession && <AgentsStrip />}
        {hasSession && <TasksStrip />}
        {hasSession && <QueueBar />}
        {hasSession && <ApprovalCard />}
        <Composer />
      </div>
    </section>
  );
}

function ConnectionBanner() {
  const connection = useAppState((s) => s.connection);
  if (connection !== 'offline' && connection !== 'polling') return null;
  return (
    <div class={`connection-banner banner-${connection}`} role="status">
      <WifiOff size={14} />
      {connection === 'polling' ? 'Live updates reconnecting · your chat is still syncing' : 'Reconnecting to the server · your draft is saved'}
    </div>
  );
}

// Messages waiting above the composer: those sent mid-turn that Claude has not read yet
// (they can still be taken back), then the queue that runs after the turn.
function QueueBar() {
  const { queue, steering, paused, sessionId, sends, messages, step, waitingSince, cwd, interrupting } = useAppState(
    (s) => {
      const steering = s.current?.steering || NONE;
      return {
        queue: s.current?.queue || NONE,
        steering,
        paused: !!s.current?.queuePaused,
        sessionId: s.current?.id ?? null,
        sends: s.outgoing,
        // Only needed (and only re-rendering this bar) while something is being sent.
        messages: s.outgoing.length ? s.current?.messages || NONE : NONE,
        // While messages wait for Claude: the step it is on, and since when they wait.
        step: steering.length ? currentStep(s.current?.messages) : null,
        waitingSince: steering.length ? (s.current?.messages || NONE).findLast((m) => m.id === steering[0].id)?.at ?? null : null,
        cwd: s.current?.cwd ?? '',
        interrupting: isInterrupting(s),
      };
    },
    shallowEqual,
  );
  const outgoing = sends.length ? sendingHere(sends, sessionId, messages) : NONE;
  if (!queue.length && !steering.length && !outgoing.length) return null;
  return (
    <div class="queue-bar">
      {outgoing.length > 0 && (
        <div class="queue-section is-outgoing" role="status">
          {outgoing.map((item) => (
            <div class="queue-item" key={item.key}>
              <LoaderCircle size={13} class="spin" aria-hidden="true" />
              <span class="queue-text">{item.text}</span>
              <span class="queue-note">Sending…</span>
            </div>
          ))}
        </div>
      )}
      {steering.length > 0 && (
        <div class="queue-section is-steering">
          <SteeringHead count={steering.length} step={step} waitingSince={waitingSince} cwd={cwd} interrupting={interrupting} />
          {steering.map((item) => (
            <div class="queue-item" key={item.id}>
              <span class="queue-text">{item.text}</span>
              <button type="button" class="icon-btn icon-btn-sm" onClick={() => cancelQueued(item.id)} aria-label="Take back message" title="Take back (Claude has not read it yet)">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {queue.length > 0 && (
        <div class="queue-section">
          <div class="queue-head">
            {paused ? <Pause size={13} /> : <ListPlus size={13} />}
            <span class="queue-title">
              {queue.length} queued{paused ? ' · Paused' : ''}
            </span>
            {paused ? (
              <button type="button" class="btn btn-sm btn-secondary" onClick={resumeQueue}>
                <Play size={13} />
                Resume
              </button>
            ) : (
              <span class="queue-note">Runs after the current turn</span>
            )}
          </div>
          {queue.map((item) => (
            <div class="queue-item" key={item.id}>
              <span class="queue-text">{item.text}</span>
              <button type="button" class="icon-btn icon-btn-sm" onClick={() => cancelQueued(item.id)} aria-label="Remove queued message" title="Remove from queue">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A step this long makes "Interrupt and send now" worth offering.
const LONG_STEP_MS = 10_000;

// What the messages sent mid-turn are waiting for: Claude reads them when its current
// step (a tool call, with its elapsed time) finishes. A long step can be cut short.
function SteeringHead({ count, step, waitingSince, cwd, interrupting }) {
  const now = useNow();
  const since = step?.at ?? waitingSince ?? now;
  const long = now - since >= LONG_STEP_MS;
  return (
    <>
      <div class="queue-head">
        <CornerDownRight size={13} />
        <span class="queue-title">{count} sent to Claude</span>
        <span class="queue-note">{interrupting ? 'Interrupting…' : step ? 'Read when this step finishes' : 'Read at its next step'}</span>
        {long && !interrupting && (
          <button type="button" class="btn btn-sm btn-secondary steer-now-btn" onClick={interruptAndSend} title="Stop the current step and have Claude read your messages now">
            <Zap size={13} />
            Interrupt and send now
          </button>
        )}
      </div>
      {step && (
        <div class="queue-step" role="status">
          <LoaderCircle size={12} class="spin" aria-hidden="true" />
          <span class="queue-step-label">{runningLabel(step, cwd)}</span>
          <Elapsed since={step.at} class="queue-step-time" />
        </div>
      )}
    </>
  );
}

// Messages being sent from this view, until the server's copy of each arrives (the user
// message with its clientId; the server publishes it before it answers).
function sendingHere(sends, sessionId, messages) {
  const arrived = new Set();
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 20); i--) if (messages[i].clientId) arrived.add(messages[i].clientId);
  return sends.filter((item) => item.sessionId === sessionId && !(item.id && arrived.has(item.id)));
}

/* Menu items */

function mentionItems(items) {
  return [
    {
      label: '',
      items: items.map((item) => {
        const path = String(item.path || '').replace(/\/+$/, '');
        const dir = dirname(path);
        return {
          key: path + (item.directory ? '/' : ''),
          value: item,
          icon: item.directory ? <Folder size={15} /> : <File size={15} />,
          class: item.directory ? 'is-folder' : '',
          title: (
            <>
              <span class="mention-name">
                {basename(path, path)}
                {item.directory ? '/' : ''}
              </span>
              {dir && <span class="mention-dir">{dir}</span>}
            </>
          ),
        };
      }),
    },
  ];
}

function commandIcon(command) {
  if (command.source === 'skill') return <Sparkles size={15} />;
  if (command.source === 'local') {
    const Icon = LOCAL_ICONS[command.name] || BookOpen;
    return <Icon size={15} />;
  }
  return <SquareSlash size={15} />;
}

function commandItems(commands, query) {
  return groupCommands(commands, query).map((group) => ({
    label: group.label,
    items: group.items.map((command) => ({
      key: `${command.source}:${command.name}`,
      value: command,
      icon: commandIcon(command),
      class: `is-${command.source}`,
      title: (
        <>
          <span class="command-name">/{command.name}</span>
          {command.argumentHint && <span class="command-arg">{command.argumentHint}</span>}
        </>
      ),
      description: command.description,
    })),
  }));
}

/* Composer */

function Composer() {
  const { sessionId, busy, stopping, sending, connection, ready, context, preset, focusNonce, visionOff, cluster } = useAppState(
    (s) => ({
      sessionId: s.current?.id || null,
      busy: isBusy(s.current),
      stopping: isStopping(s),
      sending: s.sending,
      connection: s.connection,
      ready: !!s.info,
      context: s.current?.context || null,
      preset: s.composerPreset,
      focusNonce: s.focusNonce,
      visionOff: activeModel(s).vision === false,
      // The cluster the folder's commands come from (the session's, or the new chat's).
      cluster: folderClusterId(s),
    }),
    shallowEqual,
  );
  const slot = slotFor(sessionId);
  const attachments = useAppState((s) => attachmentItems(s, slot));
  const [value, setValue] = useState(() => getItem(KEYS.draft(sessionId)) || '');
  const [trigger, setTrigger] = useState(null);
  const [dismissed, setDismissed] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [files, setFiles] = useState({ items: [], loading: false, query: null });
  const [commands, setCommands] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const [stopHint, setStopHint] = useState(false);
  const textarea = useRef(null);
  const form = useRef(null);
  const fileInput = useRef(null);
  const draftKey = useRef(KEYS.draft(sessionId));
  const stopper = useMemo(() => createDoublePress({ windowMs: STOP_HINT_MS }), []);

  const resize = () => {
    const el = textarea.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
    // Hold the form's height while measuring: collapsing the textarea for a moment
    // would grow the transcript above, clamp its scroll position and unpin it.
    const box = form.current;
    box.style.minHeight = box.offsetHeight + 'px';
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, lineHeight * MAX_LINES + 4) + 'px';
    box.style.minHeight = '';
  };

  // Each session has its own draft (text and attachments). A send from the
  // new-session view moves both to the new session's draft (see sendMessage).
  useLayoutEffect(() => {
    hydrateAttachments(slot);
    const key = KEYS.draft(sessionId);
    if (key === draftKey.current) return;
    draftKey.current = key;
    setValue(getItem(key) || '');
    setTrigger(null);
  }, [sessionId]);

  useLayoutEffect(resize, [value, attachments.length]);

  useEffect(() => {
    if (!preset) return;
    setDraft(preset.text);
    const el = textarea.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(preset.text.length, preset.text.length));
    }
  }, [preset]);

  useEffect(() => {
    if (focusNonce && canHover()) textarea.current?.focus();
  }, [focusNonce]);

  const setDraft = (next) => {
    setValue(next);
    if (next) setItem(draftKey.current, next);
    else removeItem(draftKey.current);
  };

  /* Autocomplete */

  const syncTrigger = (el = textarea.current) => {
    if (!el) return;
    const next = el.selectionStart === el.selectionEnd ? detectTrigger(el.value, el.selectionStart) : null;
    setTrigger((previous) => (shallowEqual(previous, next) ? previous : next));
  };

  // A dismissed menu stays closed until the caret leaves that token.
  useEffect(() => {
    if (!trigger) setDismissed(null);
  }, [trigger]);

  const menuKind =
    trigger && !(dismissed && dismissed.type === trigger.type && dismissed.start === trigger.start) ? trigger.type : null;

  // `@` files: debounced, and only the latest request's answer is used.
  const mentionQuery = menuKind === 'mention' ? trigger.query : null;
  useEffect(() => {
    if (mentionQuery == null) return undefined;
    const controller = new AbortController();
    setFiles((previous) => ({ ...previous, loading: true }));
    const timer = setTimeout(() => {
      completeFiles(mentionQuery, { signal: controller.signal }).then(
        (items) => {
          if (!controller.signal.aborted) setFiles({ items, loading: false, query: mentionQuery });
        },
        () => {
          if (!controller.signal.aborted) setFiles({ items: [], loading: false, query: mentionQuery });
        },
      );
    }, MENTION_DEBOUNCE);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mentionQuery, sessionId, cluster]);

  // `/` commands: cached per project on its cluster; refreshed on open when older than 5 minutes.
  const commandsOpen = menuKind === 'command';
  useEffect(() => {
    if (!commandsOpen) return undefined;
    const scope = commandScope();
    let live = true;
    setCommands(cachedCommands(scope));
    loadCommands(scope).then(
      (list) => live && setCommands(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [commandsOpen, sessionId, cluster]);

  const groups = useMemo(() => {
    if (menuKind === 'mention') return mentionItems(files.items);
    if (menuKind === 'command') return commandItems(commands || mergeCommands([]), trigger.query);
    return [];
  }, [menuKind, files.items, commands, trigger?.query]);
  const flatItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const menuOpen = !!menuKind;

  useEffect(() => setActiveIndex(0), [menuKind, trigger?.query, files.items]);

  // Anchor the menu at the trigger character (full width on phones).
  useLayoutEffect(() => {
    if (!menuOpen || !textarea.current || !form.current) {
      setMenuPosition(null);
      return;
    }
    if (narrow()) {
      setMenuPosition({});
      return;
    }
    const el = textarea.current;
    const box = form.current;
    const caret = caretCoordinates(el, trigger.start);
    const width = Math.min(460, box.clientWidth - 12);
    // Horizontally at the trigger character; vertically just above the composer, like
    // the other composer menus.
    const left = Math.max(6, Math.min(el.offsetLeft + caret.left - 12, box.clientWidth - width - 6));
    setMenuPosition({ left: left + 'px', bottom: box.clientHeight + 8 + 'px', width: width + 'px' });
  }, [menuOpen, trigger?.start, value, attachments.length]);

  // Puts `text` in the textarea with the caret at `position`. The DOM value is set
  // right away so the caret survives the re-render (Preact leaves an equal value alone).
  const placeCaret = (text, position) => {
    const el = textarea.current;
    if (!el) return;
    el.value = text;
    el.focus();
    el.setSelectionRange(position, position);
    syncTrigger(el);
  };

  const pick = (index) => {
    const item = flatItems[index];
    if (!item || !trigger) return;
    if (menuKind === 'mention') {
      const next = insertToken(value, trigger, mentionText(item.value));
      setDraft(next.text);
      placeCaret(next.text, next.caret);
      return;
    }
    const command = item.value;
    if (command.source === 'local' && !command.argumentHint) {
      const next = insertToken(value, trigger, '');
      setDraft(next.text.replace(/^\s+/, ''));
      setTrigger(null);
      runLocalCommand({ name: command.name, args: '' });
      return;
    }
    const next = insertToken(value, trigger, `/${command.name} `);
    setDraft(next.text);
    placeCaret(next.text, next.caret);
  };

  /* Sending */

  const uploading = attachments.some((a) => a.status === 'uploading');
  const failed = attachments.some((a) => a.status === 'error');
  const ready2send = attachments.filter((a) => a.status === 'done');
  const hasContent = !!value.trim() || ready2send.length > 0;
  // A send while another is on its way waits for it (sendMessage keeps the order).
  const canSend = hasContent && ready && connection !== 'offline' && !uploading && !failed;
  // While a turn runs a message (files too) goes straight into it; slash commands can
  // only start a turn, so they wait in the queue.
  const onlyQueues = isSlashCommand(value.trim());

  const submit = async (event, { queue = false } = {}) => {
    event?.preventDefault();
    const local = parseLocalCommand(value);
    if (local && !attachments.length) {
      if (runLocalCommand(local)) {
        setDraft('');
        setTrigger(null);
      }
      return;
    }
    if (hasContent && uploading) return toast('Wait for the upload to finish, then send.');
    if (hasContent && failed) return toast('An attachment failed to upload. Retry or remove it first.');
    if (!canSend) return;
    const text = value.trim();
    const sent = ready2send.map((item) => item.attachment);
    // The box empties at once (the message shows above it as "Sending…"); the stored
    // draft keeps the text until the server has it, and a failed send puts it back.
    const shown = value;
    setValue('');
    const result = await sendMessage(text, { attachments: sent, queue });
    const ids = sent.map((a) => a.id);
    if (!result.ok) {
      if (!textarea.current?.value) setValue(getItem(draftKey.current) || shown);
      // The send created a session and then failed: the files moved to that
      // session's draft, so the new-chat view must not keep its own copies.
      if (result.created) clearSentItems('new', ids);
      return;
    }
    clearSentItems(slotFor(result.sessionId), ids);
    if (result.created) clearSentItems('new', ids);
    // sendMessage cleared the stored drafts that still held the text. If the composer
    // still shows it (the user stayed, and typed nothing since), show what is stored.
    if ((textarea.current?.value ?? '').trim() === text) setValue(getItem(draftKey.current) || '');
    setTrigger(null);
  };

  // ↑ in an empty composer brings back the last message sent in this chat.
  const recallLast = () => {
    const messages = store.get().current?.messages || [];
    const last = messages.findLast((m) => m.role === 'user' && !m.parentToolId && m.text);
    if (!last) return false;
    setDraft(last.text);
    placeCaret(last.text, last.text.length);
    return true;
  };

  const onKeyDown = (event) => {
    // keyCode 229: Safari's IME-confirming Enter arrives after compositionend.
    if (event.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    if (menuOpen) {
      const count = flatItems.length;
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed({ type: trigger.type, start: trigger.start });
        return;
      }
      if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        setActiveIndex((i) => (event.key === 'ArrowDown' ? (i + 1) % count : (i - 1 + count) % count));
        return;
      }
      if (count && !mod && !event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
        event.preventDefault();
        pick(Math.min(activeIndex, count - 1));
        return;
      }
    }
    if (event.key === 'Enter' && event.altKey && !mod && !event.shiftKey) {
      // Alt+Enter: keep it for after the running turn.
      event.preventDefault();
      submit(null, { queue: true });
    } else if (event.key === 'Enter' && mod) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Enter' && !event.shiftKey && desktop()) {
      event.preventDefault();
      submit();
    } else if (event.key === 'ArrowUp' && !mod && !event.shiftKey && !event.altKey && !value) {
      if (recallLast()) event.preventDefault();
    }
  };

  const onInput = (event) => {
    setDraft(event.currentTarget.value);
    if (event.currentTarget.value.trim()) warmForTyping();
    syncTrigger(event.currentTarget);
  };

  const onPaste = (event) => {
    const data = event.clipboardData;
    const pasted = [...(data?.files || [])];
    if (!pasted.length) return;
    // Spreadsheets and word processors put a picture of the selection next to its
    // text; the text is what was meant.
    if (pasted.every(isImage) && data.getData('text/plain').trim()) return;
    event.preventDefault();
    addFiles(slot, pasted, { pasted: true });
  };

  const onPickFiles = (event) => {
    addFiles(slot, event.currentTarget.files);
    event.currentTarget.value = '';
    textarea.current?.focus();
  };

  const insertAt = () => {
    const el = textarea.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const before = value.slice(0, start);
    const token = before && !/\s$/.test(before) ? ' @' : '@';
    const next = before + token + value.slice(end);
    setDraft(next);
    setDismissed(null);
    placeCaret(next, start + token.length);
  };

  /* Esc twice stops the running turn */

  useEffect(() => {
    let timer = null;
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const state = store.get();
      if (!isBusy(state.current) || state.dialog || state.lightbox || state.drawerOpen) return;
      if (document.querySelector('dialog[open]')) return;
      if (state.panel?.open && globalThis.matchMedia?.('(max-width: 1023px)').matches) return;
      // Esc closes the agent view first (App.jsx).
      if (shownAgent(state)) return;
      if (event.target !== textarea.current && isTextEntry(event.target)) return;
      clearTimeout(timer);
      if (stopper.press() === 'fire') {
        setStopHint(false);
        stopSession();
      } else {
        setStopHint(true);
        timer = setTimeout(() => setStopHint(false), STOP_HINT_MS);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (!busy) {
      stopper.reset();
      setStopHint(false);
    }
  }, [busy]);

  // A paste with no text field focused (the last click was in the transcript, on a
  // button or a menu) goes into the message box: dictation apps such as Wispr Flow
  // paste with ⌘V into whatever has focus, and the browser drops it otherwise.
  // The text lands where the caret was; pasted files attach as they would in the box.
  useEffect(() => {
    const onPaste = (event) => {
      const el = textarea.current;
      if (!el || event.defaultPrevented || isTextEntry(event.target)) return;
      const state = store.get();
      if (state.dialog || state.lightbox || document.querySelector('dialog[open]')) return;
      const data = event.clipboardData;
      const files = [...(data?.files || [])];
      const text = data?.getData('text/plain') || '';
      if (files.length && !(files.every(isImage) && text.trim())) {
        event.preventDefault();
        addFiles(slot, files, { pasted: true });
        el.focus();
        return;
      }
      if (!text) return;
      event.preventDefault();
      const current = el.value;
      const start = Math.min(el.selectionStart ?? current.length, current.length);
      const end = Math.min(el.selectionEnd ?? start, current.length);
      const next = current.slice(0, start) + text + current.slice(end);
      setDraft(next);
      if (next.trim()) warmForTyping();
      placeCaret(next, start + text.length);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  const placeholder = busy
    ? 'Message Claude while it works…'
    : sessionId
      ? 'Reply, or describe the next change…'
      : 'Describe what you want to build…';
  const menuId = 'composer-menu';
  const activeId = menuOpen && flatItems.length ? `${menuId}-${Math.min(activeIndex, flatItems.length - 1)}` : undefined;

  return (
    <form ref={form} class={`composer ${menuOpen ? 'has-menu' : ''}`} onSubmit={submit}>
      {stopHint && (
        <div class="esc-hint" role="status">
          Press <kbd>Esc</kbd> again to stop
        </div>
      )}
      {menuOpen && menuPosition && (
        <SuggestMenu
          id={menuId}
          label={menuKind === 'mention' ? 'Files' : 'Commands'}
          class={menuKind === 'mention' ? 'suggest-files' : 'suggest-commands'}
          groups={groups}
          activeIndex={activeIndex}
          onPick={pick}
          onHover={setActiveIndex}
          loading={menuKind === 'mention' ? files.loading : !commands}
          empty={menuKind === 'mention' ? (trigger.query ? `No files match “${trigger.query}”` : 'No files found') : 'No matching commands · Enter sends it as text'}
          position={menuPosition}
        />
      )}
      <AttachmentTray slot={slot} items={attachments} visionOff={visionOff} />
      <textarea
        ref={textarea}
        class="composer-input"
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label="Message"
        aria-autocomplete="list"
        aria-expanded={menuOpen ? 'true' : 'false'}
        aria-controls={menuOpen ? menuId : undefined}
        aria-activedescendant={activeId}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && syncTrigger()}
        onClick={() => syncTrigger()}
        onBlur={() => setTrigger(null)}
        onPaste={onPaste}
      />
      <div class="composer-toolbar">
        <div class="composer-chips">
          <input ref={fileInput} type="file" multiple hidden onChange={onPickFiles} tabIndex={-1} aria-hidden="true" />
          <button type="button" class="tool-btn tool-attach" onClick={() => fileInput.current?.click()} aria-label="Attach files" title="Attach files (or paste / drop)">
            <Plus size={18} strokeWidth={1.75} />
          </button>
          <button type="button" class="tool-btn tool-at" onMouseDown={(event) => event.preventDefault()} onClick={insertAt} aria-label="Mention a file" title="Mention a file (@)">
            <AtSign size={16} />
          </button>
          <ModePicker />
          <EffortPicker />
          {/* A new chat chooses where it runs; a session keeps its cluster. */}
          {!sessionId && <ClusterPicker />}
        </div>
        <div class="composer-actions">
          <ContextMeter context={context} busy={busy} sending={sending} />
          <ModelPicker />
          {busy && (
            <button
              type="button"
              class={`stop-btn ${stopping ? 'is-stopping' : ''}`}
              onClick={stopSession}
              disabled={stopping}
              aria-label={stopping ? 'Stopping' : 'Stop'}
              title={stopping ? 'Stopping…' : 'Stop (Esc twice)'}
            >
              {stopping ? <LoaderCircle size={14} class="spin" /> : <Square size={12} fill="currentColor" />}
            </button>
          )}
          {busy && !onlyQueues && (
            <button
              type="button"
              class="queue-btn"
              disabled={!canSend}
              onClick={() => submit(null, { queue: true })}
              aria-label="Queue for after this turn"
              title="Queue for after this turn (Alt+Enter)"
            >
              <ListPlus size={16} strokeWidth={2} />
            </button>
          )}
          <button
            type="submit"
            class={`send-btn ${busy ? (onlyQueues ? 'is-queue' : 'is-steer') : ''}`}
            disabled={!canSend}
            aria-label={busy ? (onlyQueues ? 'Queue message' : 'Send now') : 'Send message'}
            title={
              uploading
                ? 'Waiting for uploads…'
                : busy
                  ? onlyQueues
                    ? 'Queue for after this turn (commands wait for it to end)'
                    : 'Send now · Claude reads it at its next step (Enter)'
                  : 'Send (Enter)'
            }
          >
            {busy && onlyQueues ? <ListPlus size={16} strokeWidth={2} /> : <ArrowUp size={17} strokeWidth={2.25} />}
          </button>
        </div>
      </div>
    </form>
  );
}
