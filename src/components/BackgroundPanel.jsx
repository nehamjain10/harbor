// The side panel's Background tab: commands and Monitors Claude Code runs in the
// background (live output, Stop), the scheduled jobs that will wake the session
// (CronCreate, ScheduleWakeup, /loop), and the tasks that finished. The list comes from
// GET /api/sessions/:id/tasks and reloads when the session's live set or jobs change.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { AlarmClock, Bot, ChevronRight, CircleCheck, CircleSlash, CircleX, Cloud, Eye, Plug, Repeat, Square, SquareTerminal, Workflow } from 'lucide-preact';
import { api } from '../api.js';
import { openDialog, stopTask } from '../actions.js';
import { shallowEqual, useAppState } from '../state.js';
import { clockTime, firstLine, relativeTime } from '../lib/format.js';
import { KIND_LABELS, describeSchedule, endText, nextRun, ranFor, taskTitle, untilText } from '../lib/tasks.js';
import { Elapsed, useNow } from './Elapsed.jsx';
import { CopyButton } from './tools/shared.jsx';
import './BackgroundPanel.css';

const KIND_ICONS = { shell: SquareTerminal, monitor: Eye, workflow: Workflow, remote: Cloud, mcp: Plug };
// The end of a task's output the panel shows, and how often a running one is re-read.
const OUTPUT_BYTES = 64 * 1024;
const POLL_MS = 1500;
// New messages can finish a task: reload the list at most this often for them.
const MESSAGE_RELOAD_MS = 2000;
const FINISHED_PAGE = 50;

const sessionPath = (sessionId) => `sessions/${encodeURIComponent(sessionId)}`;

/** The session's tasks, reloaded when its live set or jobs change (and, slowly, as it grows). */
function useTasks(sessionId) {
  const { live, crons, count } = useAppState(
    (s) => ({ live: s.current?.liveTasks, crons: s.current?.crons, count: s.current?.messageCount || 0 }),
    shallowEqual,
  );
  const [state, setState] = useState({ data: null, error: null });
  const [settled, setSettled] = useState(count);
  // Message growth reloads after a pause, not on every streamed message.
  useEffect(() => {
    const timer = setTimeout(() => setSettled(count), MESSAGE_RELOAD_MS);
    return () => clearTimeout(timer);
  }, [count]);
  useEffect(() => {
    let cancelled = false;
    api
      .get(`${sessionPath(sessionId)}/tasks`)
      .then((data) => !cancelled && setState({ data, error: null }))
      .catch((error) => !cancelled && setState((s) => ({ data: s.data, error: error.message })));
    return () => {
      cancelled = true;
    };
  }, [sessionId, live, crons, settled]);
  return state;
}

export function BackgroundView({ sessionId }) {
  const { data, error } = useTasks(sessionId);
  const agents = useAppState((s) => s.current?.backgroundAgents || 0);
  // A task to show (openTask: a row's button in the transcript), once per request.
  const focus = useAppState((s) => (s.panel.taskId ? `${s.panel.taskId} ${s.panel.nonce}` : ''));
  const [open, setOpen] = useState(() => new Set());
  const [showFinished, setShowFinished] = useState(false);
  const [finishedShown, setFinishedShown] = useState(FINISHED_PAGE);
  const view = useRef(null);
  const focused = useRef('');
  useEffect(() => {
    if (!focus || !data || focused.current === focus) return;
    focused.current = focus;
    const [id] = focus.split(' ');
    const index = data.finished.findIndex((task) => task.id === id);
    if (index < 0 && !data.running.some((task) => task.id === id)) return;
    setOpen((before) => new Set(before).add(id));
    if (index >= 0) {
      setShowFinished(true);
      setFinishedShown((shown) => Math.max(shown, Math.ceil((index + 1) / FINISHED_PAGE) * FINISHED_PAGE));
    }
    requestAnimationFrame(() => view.current?.querySelector(`[data-task="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [focus, data]);
  const toggle = (id) =>
    setOpen((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!data) {
    return error ? (
      <div class="panel-message">
        <b>Could not load background tasks</b>
        <span>{error}</span>
      </div>
    ) : (
      <div class="bg-loading" aria-busy="true" />
    );
  }
  const { running, scheduled, finished, utcOffset = 0 } = data;
  const empty = !running.length && !scheduled.length && !finished.length && !agents;

  return (
    <div class="bg-view" ref={view}>
      {empty && (
        <div class="panel-message">
          <span class="panel-message-icon">
            <SquareTerminal size={20} />
          </span>
          <b>Nothing in the background</b>
          <span>Commands Claude runs in the background, Monitors and scheduled jobs show up here.</span>
        </div>
      )}

      {agents > 0 && (
        <button type="button" class="bg-agents" onClick={() => openDialog('agents')}>
          <Bot size={15} />
          <span>
            {agents} {agents === 1 ? 'subagent' : 'subagents'} working
          </span>
          <ChevronRight size={14} class="bg-chevron" />
        </button>
      )}

      {running.length > 0 && (
        <section class="bg-section" aria-label="Running">
          <h3 class="bg-heading">
            Running <span class="bg-count">{running.length}</span>
          </h3>
          {running.map((task) => (
            <TaskRow key={task.id} task={task} sessionId={sessionId} open={open.has(task.id)} onToggle={() => toggle(task.id)} />
          ))}
        </section>
      )}

      {scheduled.length > 0 && (
        <section class="bg-section" aria-label="Scheduled">
          <h3 class="bg-heading">
            Scheduled <span class="bg-count">{scheduled.length}</span>
          </h3>
          {scheduled.map((job) => (
            <JobRow key={job.id} job={job} offset={utcOffset} open={open.has('cron:' + job.id)} onToggle={() => toggle('cron:' + job.id)} />
          ))}
        </section>
      )}

      {finished.length > 0 && (
        <section class="bg-section" aria-label="Finished">
          <button type="button" class="bg-heading bg-heading-toggle" aria-expanded={String(showFinished)} onClick={() => setShowFinished(!showFinished)}>
            Finished <span class="bg-count">{finished.length}</span>
            <ChevronRight size={14} class="bg-chevron" />
          </button>
          {showFinished && (
            <div class="bg-finished">
              {finished.slice(0, finishedShown).map((task) => (
                <TaskRow key={task.id} task={task} sessionId={sessionId} open={open.has(task.id)} onToggle={() => toggle(task.id)} />
              ))}
              {finished.length > finishedShown && (
                <button type="button" class="btn btn-ghost bg-more" onClick={() => setFinishedShown(finishedShown + FINISHED_PAGE)}>
                  Show {Math.min(FINISHED_PAGE, finished.length - finishedShown)} more
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function StatusIcon({ task }) {
  if (task.status === 'running') return <span class="bg-dot" aria-label="Running" />;
  if (task.status === 'completed' && !task.exitCode) return <CircleCheck size={15} class="bg-status is-done" aria-label="Done" />;
  if (task.status === 'stopped') return <CircleSlash size={15} class="bg-status is-stopped" aria-label="Stopped" />;
  if (task.status === 'ended') return <CircleSlash size={15} class="bg-status is-stopped" aria-label="Ended" />;
  return <CircleX size={15} class="bg-status is-failed" aria-label="Failed" />;
}

function TaskRow({ task, sessionId, open, onToggle }) {
  const [stopping, setStopping] = useState(false);
  const Icon = KIND_ICONS[task.kind] || SquareTerminal;
  const title = taskTitle(task);
  const running = task.status === 'running';
  const command = task.description && task.command ? firstLine(task.command, 200) : '';
  const stop = async (event) => {
    event.stopPropagation();
    setStopping(true);
    await stopTask(task.id);
  };
  return (
    <div class={`bg-task ${open ? 'is-open' : ''} ${running ? 'is-running' : ''}`} data-task={task.id}>
      <div class="bg-task-row">
        <button type="button" class="bg-task-head" onClick={onToggle} aria-expanded={String(open)} title={task.command || title}>
          <StatusIcon task={task} />
          <span class="bg-task-main">
            <span class="bg-task-title">
              <Icon size={13} class="bg-kind" aria-label={KIND_LABELS[task.kind] || 'Task'} />
              {title}
            </span>
            {command && <span class="bg-task-command">{command}</span>}
          </span>
          <span class="bg-task-meta">
            {running ? (
              <Elapsed since={task.startedAt} class="bg-time" />
            ) : (
              <span class="bg-time" title={task.endedAt ? `Ended ${clockTime(task.endedAt)}` : undefined}>
                {[endText(task), ranFor(task) || relativeTime(task.startedAt)].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
        </button>
        {running && (
          <button type="button" class="icon-btn icon-btn-sm bg-stop" onClick={stop} disabled={stopping} aria-label={`Stop ${title}`} title="Stop this task">
            <Square size={11} fill="currentColor" />
          </button>
        )}
      </div>
      {open && <TaskOutput sessionId={sessionId} task={task} />}
    </div>
  );
}

/** The end of a task's output file; re-read every POLL_MS while the task runs and the page is visible. */
function TaskOutput({ sessionId, task }) {
  const running = task.status === 'running';
  const [state, setState] = useState({ output: null, error: null });
  const pre = useRef(null);
  const stick = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const load = async () => {
      if (!running || !document.hidden) {
        try {
          const output = await api.get(`${sessionPath(sessionId)}/tasks/${encodeURIComponent(task.id)}/output?bytes=${OUTPUT_BYTES}`);
          if (!cancelled) setState({ output, error: null });
        } catch (error) {
          if (!cancelled) setState((s) => ({ output: s.output, error: error.status === 404 ? 'missing' : error.message }));
        }
      }
      if (running && !cancelled) timer = setTimeout(load, POLL_MS);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, task.id, running]);

  // Follow new output while scrolled to the end.
  useLayoutEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.output?.text]);

  const { output, error } = state;
  if (!output) {
    if (error === 'missing') return <p class="bg-output-note">No output on disk. It may have been cleared, or the task wrote nothing.</p>;
    if (error) return <p class="bg-output-note">{error}</p>;
    return <div class="bg-output-pending" aria-busy="true" />;
  }
  return (
    <div class="bg-output-wrap">
      {output.truncated && <p class="bg-output-note">Showing the last {Math.round(OUTPUT_BYTES / 1024)} KB.</p>}
      <pre
        ref={pre}
        class="bg-output"
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {output.text || (running ? 'No output yet.' : 'No output.')}
      </pre>
      {output.text && <CopyButton text={output.text} class="bg-output-copy" label="Copy output" />}
    </div>
  );
}

function JobRow({ job, offset, open, onToggle }) {
  const now = useNow(true);
  const next = nextRun(job.schedule, now, offset);
  const Icon = job.recurring ? Repeat : AlarmClock;
  return (
    <div class={`bg-task bg-job ${open ? 'is-open' : ''}`}>
      <button type="button" class="bg-task-head" onClick={onToggle} aria-expanded={String(open)} title={job.schedule}>
        <Icon size={15} class="bg-status is-job" aria-hidden="true" />
        <span class="bg-task-main">
          <span class="bg-task-title">{describeSchedule(job, now, offset)}</span>
          <span class={`bg-job-prompt ${open ? 'is-open' : ''}`}>{job.prompt}</span>
        </span>
        <span class="bg-task-meta">
          {next && (
            <span class="bg-time" title={`Next run ${clockTime(next)}`}>
              {clockTime(next)} · {untilText(next, now)}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
