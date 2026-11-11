// AskUserQuestion: each question with its header chip, option cards (radio or
// checkbox), and a free-text note: on the picked option, or the answer on its own. Sends {decision:'allow', answers} keyed by
// question text (multi-select joined with ", "); Skip denies.
import { useState } from 'preact/hooks';
import { MessageCircleQuestionMark } from 'lucide-preact';
import { allAnswered, approvalBody, buildAnswers } from '../../lib/approvals.js';
import { ApprovalShell, Key, useCardKeys, useRespond } from './shared.jsx';

const SKIP_REASON = 'The user skipped this question. Continue with your best judgment.';

function Question({ question, index, state, onChange, numbered, name }) {
  const multi = !!question.multiSelect;
  const options = Array.isArray(question.options) ? question.options : [];
  const picked = state.picked;
  // Clicking the picked option again unpicks it (the note then answers on its own).
  const toggle = (label) => {
    if (multi) onChange({ ...state, picked: picked.includes(label) ? picked.filter((x) => x !== label) : [...picked, label] });
    else onChange({ ...state, picked: picked.includes(label) ? [] : [label] });
  };
  const preview = options.find((o) => picked.includes(o.label) && o.preview)?.preview;

  return (
    <fieldset class="q-block">
      <legend class="q-head">
        {question.header && <span class="q-chip">{question.header}</span>}
        <span class="q-text">{question.question}</span>
      </legend>
      {multi && <div class="q-multi">Select all that apply</div>}
      <div class="q-options" role={multi ? 'group' : 'radiogroup'} aria-label={question.question}>
        {options.map((option, oi) => {
          const checked = picked.includes(option.label);
          return (
            <label class={`q-option ${checked ? 'is-checked' : ''} ${multi ? 'is-multi' : ''}`} key={option.label}>
              {/* A checkbox even for one-of-many, so a second click unpicks it (a radio cannot). */}
              <input
                class="sr-only"
                type="checkbox"
                role={multi ? undefined : 'radio'}
                aria-checked={multi ? undefined : String(checked)}
                name={name}
                checked={checked}
                onChange={() => toggle(option.label)}
              />
              <span class="q-indicator" aria-hidden="true" />
              <span class="q-option-text">
                <span class="q-label">{option.label}</span>
                {option.description && <span class="q-desc">{option.description}</span>}
              </span>
              {numbered && oi < 9 && <kbd class="q-key">{oi + 1}</kbd>}
            </label>
          );
        })}
      </div>
      <input
        class="q-other-input"
        value={state.otherText}
        placeholder={picked.length ? 'Add a note to your answer (optional)' : 'Or type your own answer'}
        aria-label={`Note or your own answer for: ${question.question}`}
        onInput={(event) => onChange({ ...state, otherText: event.currentTarget.value })}
        data-question={index}
      />
      {preview && <pre class="approval-code q-preview">{preview}</pre>}
    </fieldset>
  );
}

export function QuestionCard({ pending, count }) {
  const questions = Array.isArray(pending.input?.questions) ? pending.input.questions : [];
  const [states, setStates] = useState(() => questions.map(() => ({ picked: [], otherText: '' })));
  const { busy, respond } = useRespond(pending);
  const ready = questions.length > 0 && allAnswered(questions, states);

  const update = (index, next) => setStates((previous) => previous.map((s, i) => (i === index ? next : s)));
  const submit = () => ready && respond(approvalBody('allow', { answers: buildAnswers(questions, states) }));
  const skip = () => respond(approvalBody('deny', { reason: SKIP_REASON }));

  // With a single question, number keys pick its options.
  const single = questions.length === 1 ? questions[0] : null;
  const keys = {};
  if (single) {
    (single.options || []).slice(0, 9).forEach((option, oi) => {
      keys[String(oi + 1)] = () => {
        const state = states[0];
        if (single.multiSelect) update(0, { ...state, picked: state.picked.includes(option.label) ? state.picked.filter((x) => x !== option.label) : [...state.picked, option.label] });
        else update(0, { ...state, picked: state.picked.includes(option.label) ? [] : [option.label] });
      };
    });
  }
  keys.Enter = submit;
  useCardKeys(keys);

  const onKeyDown = (event) => {
    // Enter in the "Other" field submits.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && event.target.classList?.contains('q-other-input')) {
      event.preventDefault();
      submit();
    }
  };

  const title = questions.length > 1 ? `${questions.length} questions for you` : 'A question for you';

  return (
    <ApprovalShell kind="question" tone="accent" icon={<MessageCircleQuestionMark size={16} />} title={title} subtitle="Pick an option, add a note, or write your own" pending={pending} count={count}>
      <div class="approval-body approval-questions" onKeyDown={onKeyDown}>
        {questions.map((question, index) => (
          <Question
            key={index}
            index={index}
            question={question}
            state={states[index]}
            onChange={(next) => update(index, next)}
            numbered={!!single}
            name={`q-${pending.id}-${index}`}
          />
        ))}
      </div>
      <div class="approval-footer">
        <div class="approval-rule approval-hint">{ready ? 'Ready to send' : questions.length > 1 ? 'Answer each question to continue' : 'Choose an answer to continue'}</div>
        <div class="approval-actions">
          <button type="button" class="btn btn-sm btn-ghost" onClick={skip} disabled={busy}>
            Skip
          </button>
          <button type="button" class="btn btn-sm btn-primary" onClick={submit} disabled={busy || !ready}>
            Submit
            <Key>↵</Key>
          </button>
        </div>
      </div>
    </ApprovalShell>
  );
}
