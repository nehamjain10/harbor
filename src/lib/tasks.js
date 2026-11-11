// Background tasks and scheduled jobs (the side panel's Background tab): labels, and
// cron schedules in words with their next run. Claude Code reads a schedule in its own
// local time, which is the server's: `offset` is the server's minutes east of UTC.
import { clockTime, firstLine, formatDuration } from './format.js';

export const KIND_LABELS = {
  shell: 'Shell',
  monitor: 'Monitor',
  workflow: 'Workflow',
  remote: 'Remote agent',
  mcp: 'MCP task',
};

/** A task's name: its description, else its command's first line, else its kind. */
export function taskTitle(task) {
  return task.description || firstLine(task.command || '', 120).trim() || KIND_LABELS[task.kind] || 'Task';
}

/** How a finished task ended, in a few words. */
export function endText(task) {
  if (task.status === 'completed') return task.exitCode ? `Exit ${task.exitCode}` : 'Done';
  if (task.status === 'failed') return task.exitCode !== undefined && task.exitCode !== null ? `Exit ${task.exitCode}` : 'Failed';
  if (task.status === 'stopped') return 'Stopped';
  return 'Ended';
}

/** How long a finished task ran, when its end is known. */
export function ranFor(task) {
  return task.endedAt && task.startedAt && task.endedAt >= task.startedAt ? formatDuration(task.endedAt - task.startedAt) : '';
}

/* Cron schedules: five fields, minute hour day-of-month month day-of-week. */

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** One field as a Set of the values it matches, or null for `*` (anything). */
function parseField(text, [min, max]) {
  if (text === '*') return null;
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return undefined;
    const step = match[4] ? Number(match[4]) : 1;
    const from = match[1] === '*' ? min : Number(match[2]);
    const to = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : from;
    if (!step || from < min || to > max || from > to) return undefined;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** The schedule's fields as Sets (null = any), or null when it is not a 5-field cron. */
export function parseCron(schedule) {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((part, index) => parseField(part, RANGES[index]));
  if (fields.includes(undefined)) return null;
  // Sunday is 0 or 7.
  if (fields[4]?.has(7)) fields[4].add(0);
  return { minute: fields[0], hour: fields[1], day: fields[2], month: fields[3], weekday: fields[4] };
}

function matches(cron, date) {
  const has = (set, value) => !set || set.has(value);
  if (!has(cron.minute, date.getUTCMinutes()) || !has(cron.hour, date.getUTCHours()) || !has(cron.month, date.getUTCMonth() + 1)) return false;
  // Both day fields restricted: either one may match (cron's rule).
  if (cron.day && cron.weekday) return cron.day.has(date.getUTCDate()) || cron.weekday.has(date.getUTCDay());
  return has(cron.day, date.getUTCDate()) && has(cron.weekday, date.getUTCDay());
}

/**
 * The next time (ms) after `now` that `schedule` fires, read in the server's time
 * (`offset` minutes east of UTC); null when it is not a cron or fires beyond 8 days.
 */
export function nextRun(schedule, now = Date.now(), offset = 0) {
  const cron = parseCron(schedule);
  if (!cron) return null;
  const shift = offset * 60_000;
  // Walk the server's wall clock a minute at a time (as UTC fields), starting next minute.
  let t = Math.floor((now + shift) / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 8 * 24 * 60; i += 1, t += 60_000) {
    if (matches(cron, new Date(t))) return t - shift;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

/** A server wall-clock time today (hour, minute) as a local clock label. */
function serverClock(hour, minute, offset, now) {
  const day = new Date(now + offset * 60_000);
  const t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute) - offset * 60_000;
  return clockTime(t);
}

/** A schedule in words: "Every 30 minutes", "Hourly at :17 and :47", "Daily at 9:00 AM". */
export function describeSchedule({ schedule, recurring = true }, now = Date.now(), offset = 0) {
  const cron = parseCron(schedule);
  if (!cron) return schedule || 'Scheduled';
  const one = (set) => (set && set.size === 1 ? [...set][0] : null);
  const everyDay = !cron.day && !cron.month && !cron.weekday;
  if (!recurring) {
    const next = nextRun(schedule, now - 60_000, offset);
    return next ? `Once at ${clockTime(next)}` : `Once (${schedule})`;
  }
  if (everyDay && !cron.hour) {
    if (!cron.minute) return 'Every minute';
    const minutes = [...cron.minute].sort((a, b) => a - b);
    const gaps = minutes.map((m, i) => (minutes[(i + 1) % minutes.length] - m + 60) % 60 || 60);
    if (minutes.length > 1 && gaps.every((gap) => gap === gaps[0])) {
      return `Every ${gaps[0]} minutes` + (minutes[0] ? ` (from :${pad(minutes[0])})` : '');
    }
    if (minutes.length <= 3) return 'Hourly at ' + minutes.map((m) => ':' + pad(m)).join(minutes.length === 2 ? ' and ' : ', ');
    return schedule;
  }
  const hour = one(cron.hour);
  const minute = one(cron.minute);
  if (hour !== null && minute !== null) {
    const at = serverClock(hour, minute, offset, now);
    if (everyDay) return `Daily at ${at}`;
    const weekdays = cron.weekday && [...cron.weekday].filter((d) => d !== 7).sort().join(',');
    if (!cron.day && !cron.month && weekdays === '1,2,3,4,5') return `Weekdays at ${at}`;
  }
  return schedule;
}

/** "in 12 min", "in 3 h", for a time ahead of `now`. */
export function untilText(ts, now = Date.now()) {
  const minutes = Math.max(0, Math.round((ts - now) / 60_000));
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `in ${hours} h ${minutes % 60} min` : `in ${Math.floor(hours / 24)} d`;
}
