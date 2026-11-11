// The expanded detail of a tool call: picks the renderer for the tool family and
// adds "Load full output" when the pushed copy was truncated.
import { isMcpTool } from '../../lib/tools.js';
import { unwrapToolError } from '../../lib/toolOutput.js';
import { AgentDetail } from './Agent.jsx';
import { BashDetail, ShellDetail } from './Bash.jsx';
import { EditDetail, NotebookDetail, WriteDetail } from './Edit.jsx';
import { GenericDetail, McpDetail } from './Generic.jsx';
import { ApplyPatchDetail } from './Patch.jsx';
import { PlanDetail, QuestionDetail, SkillDetail, TaskToolDetail, TodoDetail } from './Misc.jsx';
import { ReadDetail } from './Read.jsx';
import { SearchDetail } from './Search.jsx';
import { CheckAgentsDetail, MessageAgentDetail, StopAgentDetail } from './Workers.jsx';
import { WebFetchDetail, WebSearchDetail } from './Web.jsx';
import { LoadFullOutput, useToolOutput } from './shared.jsx';
import './tools.css';

const RENDERERS = {
  Bash: BashDetail,
  Monitor: BashDetail,
  BashOutput: ShellDetail,
  TaskOutput: ShellDetail,
  KillShell: ShellDetail,
  KillBash: ShellDetail,
  TaskStop: ShellDetail,
  Read: ReadDetail,
  Edit: EditDetail,
  MultiEdit: EditDetail,
  Write: WriteDetail,
  NotebookEdit: NotebookDetail,
  ApplyPatch: ApplyPatchDetail,
  Grep: SearchDetail,
  Glob: SearchDetail,
  WebFetch: WebFetchDetail,
  WebSearch: WebSearchDetail,
  mcp__meshy__web_search: WebSearchDetail,
  Agent: AgentDetail,
  Task: AgentDetail,
  mcp__meshy__delegate: AgentDetail,
  mcp__meshy__message_agent: MessageAgentDetail,
  mcp__meshy__stop_agent: StopAgentDetail,
  mcp__meshy__check_agents: CheckAgentsDetail,
  Skill: SkillDetail,
  TodoWrite: TodoDetail,
  TaskCreate: TaskToolDetail,
  TaskUpdate: TaskToolDetail,
  TaskList: TaskToolDetail,
  TaskGet: TaskToolDetail,
  AskUserQuestion: QuestionDetail,
  ExitPlanMode: PlanDetail,
};

export function rendererFor(tool) {
  return RENDERERS[tool] || (isMcpTool(tool) ? McpDetail : GenericDetail);
}

// `Children` renders a subagent's nested nodes (passed in to avoid an import cycle
// with the activity rows).
export function ToolDetail({ node, cwd, Children }) {
  const { message } = node;
  const full = useToolOutput(message);
  const Renderer = rendererFor(message.tool);
  return (
    <div class={`tool-detail ${message.state === 'error' ? 'is-error' : ''}`}>
      <Renderer message={message} output={message.state === 'error' ? unwrapToolError(full.output) : full.output} node={node} cwd={cwd} Children={Children} />
      {full.truncated && <LoadFullOutput {...full} />}
    </div>
  );
}
