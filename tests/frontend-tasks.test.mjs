// The Background tab's labels (src/lib/tasks.js): cron schedules in words, their next
// run in the server's time, and how finished tasks read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSchedule, endText, nextRun, parseCron, ranFor, taskTitle, untilText } from '../src/lib/tasks.js';

// 2026-10-13 19:05:30 UTC.
const NOW = Date.UTC(2026, 9, 13, 19, 5, 30);
const at = (h, m, d = 13) => Date.UTC(2026, 9, d, h, m);

test('parseCron reads the five fields (lists, ranges, steps; Sunday as 7) and refuses anything else', () => {
  const cron = parseCron('17,47 9-17/4 * 1-12 0');
  assert.deepEqual([...cron.minute], [17, 47]);
  assert.deepEqual([...cron.hour], [9, 13, 17]);
  assert.equal(cron.day, null);
  assert.deepEqual(parseCron('0 0 * * 7').weekday.has(0), true);
  for (const bad of ['', '* * * *', '61 * * * *', '* * * * * *', '5-1 * * * *', '*/0 * * * *', 'a * * * *']) assert.equal(parseCron(bad), null, bad);
});

test('nextRun: the next matching minute, in the server’s time', () => {
  assert.equal(nextRun('17,47 * * * *', NOW, 0), at(19, 17));
  assert.equal(nextRun('*/30 * * * *', NOW, 0), at(19, 30));
  assert.equal(nextRun('* * * * *', NOW, 0), at(19, 6));
  assert.equal(nextRun('0 9 * * *', NOW, 0), at(9, 0, 14));
  // A server at UTC-7 runs "0 9 * * *" at 16:00 UTC.
  assert.equal(nextRun('0 9 * * *', NOW, -420), at(16, 0, 14));
  // Both day fields set: either one matches (the 20th, or a Wednesday: the 14th is one).
  assert.equal(nextRun('0 12 20 * 3', NOW, 0), at(12, 0, 14));
  assert.equal(nextRun('0 0 31 2 *', NOW, 0), null, 'never within 8 days');
  assert.equal(nextRun('nonsense', NOW, 0), null);
});

test('describeSchedule says common schedules in words and keeps the rest as written', () => {
  const words = (schedule, recurring = true, offset = 0) => describeSchedule({ schedule, recurring }, NOW, offset);
  assert.equal(words('* * * * *'), 'Every minute');
  assert.equal(words('*/30 * * * *'), 'Every 30 minutes');
  assert.equal(words('17,47 * * * *'), 'Every 30 minutes (from :17)');
  assert.equal(words('5 * * * *'), 'Hourly at :05');
  assert.equal(words('5,20,50 * * * *'), 'Hourly at :05, :20, :50');
  assert.match(words('0 9 * * *'), /^Daily at /);
  assert.match(words('30 8 * * 1-5'), /^Weekdays at /);
  assert.equal(words('0 9 1 * *'), '0 9 1 * *');
  assert.equal(words('weird'), 'weird');
  // A one-shot wakeup: its time today.
  assert.match(words('40 19 13 10 *', false), /^Once at /);
});

test('untilText, taskTitle, endText and ranFor', () => {
  assert.equal(untilText(NOW + 20_000, NOW), 'in under a minute');
  assert.equal(untilText(NOW + 12 * 60_000, NOW), 'in 12 min');
  assert.equal(untilText(NOW + 125 * 60_000, NOW), 'in 2 h 5 min');
  assert.equal(untilText(NOW + 50 * 3_600_000, NOW), 'in 2 d');

  assert.equal(taskTitle({ description: 'Count ticks', command: 'seq 3' }), 'Count ticks');
  assert.equal(taskTitle({ command: '\n  tail -f log\nmore' }), 'tail -f log');
  assert.equal(taskTitle({ kind: 'monitor' }), 'Monitor');

  assert.equal(endText({ status: 'completed', exitCode: 0 }), 'Done');
  assert.equal(endText({ status: 'completed' }), 'Done');
  assert.equal(endText({ status: 'failed', exitCode: 2 }), 'Exit 2');
  assert.equal(endText({ status: 'failed' }), 'Failed');
  assert.equal(endText({ status: 'stopped' }), 'Stopped');
  assert.equal(endText({ status: 'ended' }), 'Ended');

  assert.equal(ranFor({ startedAt: 1000, endedAt: 66_000 }), '1m 5s');
  assert.equal(ranFor({ startedAt: 1000 }), '');
});
