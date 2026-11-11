// Skill, TodoWrite and the Task tools, AskUserQuestion, ExitPlanMode.
import { Check, ClipboardList, Sparkles } from 'lucide-preact';
import { parseAnswers } from '../../lib/toolOutput.js';
import { Markdown } from '../Markdown.jsx';
import { TodoList } from '../TodoList.jsx';
import { Chip, Clamp, Note, OutputBlock } from './shared.jsx';

export function SkillDetail({ message, output }) {
  const input = message.input || {};
  const args = input.args ?? input.arguments;
  return (
    <>
      <div class="chip-row">
        <Chip tone="accent">
          <Sparkles size={12} />
          {input.skill || input.command || input.name || 'skill'}
        </Chip>
        {args && <Chip mono>{typeof args === 'string' ? args : JSON.stringify(args)}</Chip>}
      </div>
      {output && <OutputBlock text={output} error={message.state === 'error'} maxLines={12} />}
    </>
  );
}

export function TodoDetail({ message, output }) {
  const todos = Array.isArray(message.input?.todos) ? message.input.todos : [];
  return (
    <>
      {todos.length ? <TodoList todos={todos} /> : <Note>Empty list</Note>}
      {message.state === 'error' && output && <OutputBlock text={output} error />}
    </>
  );
}

// TaskCreate / TaskUpdate / TaskList / TaskGet.
export function TaskToolDetail({ message, output }) {
  const input = message.input || {};
  return (
    <>
      {(input.subject || input.taskId || input.status) && (
        <div class="chip-row">
          {input.taskId && <Chip mono>#{input.taskId}</Chip>}
          {input.status && <Chip tone={input.status === 'completed' ? 'success' : input.status === 'in_progress' ? 'accent' : ''}>{input.status.replace('_', ' ')}</Chip>}
          {input.subject && <span class="agent-desc">{input.subject}</span>}
        </div>
      )}
      {input.description && <p class="tool-desc">{input.description}</p>}
      {output && <OutputBlock text={output} error={message.state === 'error'} maxLines={16} />}
    </>
  );
}

const splitAnswer = (answer) => answer.split(/,\s*/).map((part) => part.trim());

export function QuestionDetail({ message, output }) {
  const questions = Array.isArray(message.input?.questions) ? message.input.questions : [];
  const answers = parseAnswers(message.input, output);
  if (!questions.length) return output ? <OutputBlock text={output} error={message.state === 'error'} /> : <Note>Waiting for your answer…</Note>;
  return (
    <div class="questions">
      {questions.map((q, i) => {
        const answer = answers.find((a) => a.question === q.question)?.answer ?? (answers.length === questions.length ? answers[i]?.answer : undefined);
        const chosen = answer ? splitAnswer(answer) : [];
        const options = Array.isArray(q.options) ? q.options : [];
        const custom = answer && !options.some((o) => chosen.includes(o.label)) ? answer : '';
        return (
          <div class="question-card" key={i}>
            <p class="question-title">
              {q.header && <Chip>{q.header}</Chip>}
              <span>{q.question}</span>
            </p>
            <ul class="question-options">
              {options.map((option) => {
                const picked = chosen.includes(option.label);
                return (
                  <li key={option.label} class={picked ? 'is-picked' : ''}>
                    <span class="option-mark">{picked && <Check size={12} strokeWidth={2.5} />}</span>
                    <span class="option-body">
                      <span class="option-label">{option.label}</span>
                      {option.description && <span class="option-description">{option.description}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            {custom && (
              <p class="question-answer">
                <span class="muted">Answer:</span> {custom}
              </p>
            )}
            {!answer && <Note>{message.state === 'running' ? 'Waiting for your answer…' : 'No answer recorded'}</Note>}
          </div>
        );
      })}
    </div>
  );
}

export function PlanDetail({ message, output }) {
  const plan = message.input?.plan || '';
  return (
    <>
      {plan ? (
        <div class="plan-card">
          <div class="plan-card-head">
            <ClipboardList size={14} />
            Plan
          </div>
          <Clamp maxHeight={420}>
            <Markdown text={plan} class="markdown-sm" />
          </Clamp>
        </div>
      ) : (
        <Note>No plan text.</Note>
      )}
      {output && <p class={`tool-desc ${message.state === 'error' ? 'is-error' : ''}`}>{output.split('\n')[0]}</p>}
    </>
  );
}
