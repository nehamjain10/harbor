// Subagent transcripts as Claude Code writes them (`<claude home>/projects/<project>/
// <session>/subagents/agent-<id>.jsonl` + `.meta.json`): "Survey the repo" (Agent call
// toolu_01RootAgent: thinking, text, Bash, a nested agent, a message sent to it, Read,
// its report), the "Read the README" agent it started (toolu_01NestedAgent) and an
// unrelated one (toolu_01OtherAgent). Copied with `__CWD__` replaced by the project folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const AGENT_SESSION = '66666666-6666-4666-8666-666666666666';
export const ROOT_AGENT = 'toolu_01RootAgent';
export const NESTED_AGENT = 'toolu_01NestedAgent';
export const OTHER_AGENT = 'toolu_01OtherAgent';

/**
 * Writes the transcripts under `<claudeHome>/projects/<project>/<sessionId>/subagents`;
 * `project` defaults to Claude Code's folder name for `cwd`. Returns that folder.
 */
export function copyAgentFixtures(claudeHome, { cwd, sessionId = AGENT_SESSION, project = cwd.replace(/[^a-zA-Z0-9]/g, '-') }) {
  const dir = path.join(claudeHome, 'projects', project, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(path.join(HERE, 'subagents'))) {
    fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(HERE, 'subagents', name), 'utf8').replaceAll('__CWD__', cwd));
  }
  return dir;
}
