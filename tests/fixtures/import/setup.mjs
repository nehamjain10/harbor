// Copies the session import fixtures (a Claude Code config folder and a Codex home) into
// `base`, with `__CWD__` replaced by the sessions' project folder (by default `proj` in a
// fake home folder under `base`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';
export const CLAUDE_PROGRAMMATIC = '22222222-2222-4222-8222-222222222222';
export const CLAUDE_OUTSIDE = '33333333-3333-4333-8333-333333333333';
export const CLAUDE_GONE = '44444444-4444-4444-8444-444444444444';
export const CODEX_SESSION = '019a0000-0000-7000-8000-000000000001';
export const CODEX_SUBAGENT = '019a0000-0000-7000-8000-000000000002';
export const CODEX_ARCHIVED = '019a0000-0000-7000-8000-000000000003';

function copyTree(from, to, cwd) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, cwd);
    else fs.writeFileSync(target, fs.readFileSync(source, 'utf8').replaceAll('__CWD__', cwd));
  }
}

/** `{home, cwd, claudeHome, codexHome}`. */
export function copyImportFixtures(base, { cwd = path.join(base, 'home', 'proj') } = {}) {
  const home = path.dirname(cwd);
  fs.mkdirSync(cwd, { recursive: true });
  const claudeHome = path.join(base, 'claude');
  const codexHome = path.join(base, 'codex');
  copyTree(path.join(HERE, 'claude'), claudeHome, cwd);
  copyTree(path.join(HERE, 'codex'), codexHome, cwd);
  return { home, cwd, claudeHome, codexHome };
}

/** A transcript file of the copied fixtures. */
export function claudeTranscript(claudeHome, id, project = '-proj') {
  return path.join(claudeHome, 'projects', project, `${id}.jsonl`);
}
