// The message box docked under a running model agent's transcript: what is typed goes
// to that agent (the lead keeps its own conversation), which reads it at its next step.
// Enter sends, Shift+Enter adds a line. The message shows in the transcript as "Sending…"
// at once (actions.js sendAgentMessage); one the server refuses leaves it again, its
// text comes back into the box and the server's reason shows under it. Once the agent
// has ended the box goes, or, while it holds an unsent draft or a reason, stays disabled
// with a note.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ArrowUp, CircleAlert } from 'lucide-preact';
import { closeAgent, sendAgentMessage, toast } from '../actions.js';

const MAX_LINES = 6;
// Enter sends where there is a hardware keyboard; phones keep Enter for newlines.
const desktop = () => globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

// `session/agent` -> unsent text, kept while another agent (or the conversation) is shown.
const drafts = new Map();

export function AgentMessageBox({ sessionId, toolId, label, running, onSent }) {
  const key = `${sessionId}/${toolId}`;
  const [value, setValue] = useState(() => drafts.get(key) || '');
  const [error, setError] = useState('');
  const textarea = useRef(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // Grows with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, lineHeight * MAX_LINES + 4) + 'px';
  }, [value, running]);

  const setDraft = (next) => {
    setValue(next);
    if (next) drafts.set(key, next);
    else drafts.delete(key);
  };

  const submit = async () => {
    const text = value.trim();
    if (!text || !running) return;
    setDraft('');
    setError('');
    onSent?.();
    const result = await sendAgentMessage(toolId, text);
    if (result.ok) return;
    // Back into the box for another try, ahead of what was typed meanwhile.
    const typed = drafts.get(key) || '';
    const restored = typed ? `${text}\n${typed}` : text;
    drafts.set(key, restored);
    if (mounted.current) {
      setValue(restored);
      setError(result.error || 'The message was not sent.');
    } else toast(result.error || 'The message was not sent.');
  };

  const onKeyDown = (event) => {
    // keyCode 229: Safari's IME-confirming Enter arrives after compositionend.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      // With words typed, the first Esc only leaves the box (they stay for the next
      // visit); with nothing typed it closes the agent view, as it does anywhere else.
      event.preventDefault();
      if (value) event.currentTarget.blur();
      else closeAgent();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && (desktop() || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  const discard = () => {
    setDraft('');
    setError('');
  };

  if (!running && !value.trim() && !error) return null;
  const canSend = running && !!value.trim();
  return (
    <form
      class={`agent-message ${running ? '' : 'is-ended'}`}
      aria-label={`Message ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div class="agent-message-field">
        <textarea
          ref={textarea}
          class="agent-message-input"
          rows={1}
          value={value}
          placeholder={`Message ${label}…`}
          aria-label={`Message ${label}`}
          aria-invalid={error ? 'true' : undefined}
          disabled={!running}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            if (error) setError('');
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" class="agent-message-send" disabled={!canSend} aria-label="Send message" title={running ? 'Send · the agent reads it at its next step (Enter)' : 'The agent has ended'}>
          <ArrowUp size={15} strokeWidth={2.25} />
        </button>
      </div>
      {error ? (
        <p class="agent-message-note is-error" role="alert">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{error}</span>
          {!running && <DiscardButton onClick={discard} />}
        </p>
      ) : running ? (
        <p class="agent-message-note">
          <span>Read at its next step</span>
          <span class="agent-message-keys">Enter to send · Shift+Enter for a new line</span>
        </p>
      ) : (
        <p class="agent-message-note" role="status">
          <span>{label} has ended, so this was not sent.</span>
          <DiscardButton onClick={discard} />
        </p>
      )}
    </form>
  );
}

function DiscardButton({ onClick }) {
  return (
    <button type="button" class="agent-message-discard" onClick={onClick}>
      Discard
    </button>
  );
}
