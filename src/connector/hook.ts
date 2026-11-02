// hook 处理：Claude Code 和 Codex 的 hook 事件名和输出格式几乎相同，共用这一套。
// 注入的文字由服务器选好条目、渲染好，这里原样转交；本地只在前面拼上补发结果（最多 800 字节）。
// 任何错误都吞掉、返回空输出（记进 $TEAMLINK_HOME/hook-errors.log）：协作平台出问题时不能卡住 AI 的正常工作。

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliveryResponse, NoticeType, Tool } from '../shared/protocol.ts';
import { TOOLS } from '../shared/protocol.ts';
import { call, ClientError, message, NetworkError } from './client.ts';
import { git, identityFor, readRepoConfig, teamlinkHome, type Identity, type RepoConfig } from './config.ts';
import { flushOutbox, renderNotes } from './outbox.ts';
import { saveReceived } from './received.ts';
import {
  backoffActive,
  clearBackoff,
  clearSession,
  clearStopMarker,
  forgetLastSession,
  keepRejected,
  logHookError,
  noteHookRun,
  readStopMarker,
  saveLastSession,
  saveMembers,
  saveNotes,
  setBackoff,
  setStopMarker,
  takeNotes,
  type FlushNote,
} from './state.ts';

export type HookEvent = 'session-start' | 'prompt' | 'post-tool' | 'stop' | 'session-end';

const EVENT_NAME: Record<HookEvent, string> = {
  'session-start': 'SessionStart',
  prompt: 'UserPromptSubmit',
  'post-tool': 'PostToolUse',
  stop: 'Stop',
  'session-end': 'SessionEnd',
};

/** 每次 hook 的总时限，session-end 是 2 秒（Codex 给 SessionEnd 的上限是 3 秒）。每个请求的超时取剩下的时间。 */
const LIMIT_MS = 3500;
const END_LIMIT_MS = 2000;
/** 补发最多花这么久；退避期间 session-start、stop 只试一次主请求，超时也是这么久。 */
const SHORT_MS = 1500;
/** 拿到响应以后，输出和本地记账留的时间。 */
const MARGIN_MS = 100;

interface HookInput {
  session_id?: unknown;
  cwd?: unknown;
  /** 这次结束本身就是被 Stop hook 拦下后的继续，不要再拦。 */
  stop_hook_active?: unknown;
}

interface Ctx {
  event: HookEvent;
  tool: Tool;
  data: HookInput;
  root: string;
  cfg: RepoConfig;
  identity: Identity;
  sessionId: string;
  /** 本机状态目录（每个 worktree 一份）。 */
  dir: string;
  deadline: number;
  /** 开始时退避标记有效：只有 session-start、stop 各试一次主请求，session-end 照常。 */
  backoff: boolean;
  /** 这次 hook 里已经连不上过一次：不再发别的请求。 */
  down: boolean;
  /** 补发结果存不进本地状态时，留在手里这次交出。 */
  unsaved: FlushNote[];
}

/** output 立即交给 AI 工具；after 是输出之后才做的本地记账。 */
interface Outcome {
  output: string;
  after?: () => void;
}

/** 排查用：设置 TEAMLINK_HOOK_LOG=文件路径 后，每次 hook 调用的开始和结束各记一行。 */
function trace(line: string): void {
  const path = process.env.TEAMLINK_HOOK_LOG;
  if (!path) return;
  try {
    appendFileSync(path, `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
  } catch {
    // 排查日志写不了就算了
  }
}

function safely(ctx: Ctx, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    logHookError(`${ctx.tool} ${ctx.event} ${ctx.root} 本地记账失败：${message(e)}`);
  }
}

/**
 * 跑一次 hook，返回交给 AI 工具的输出（空串表示什么都不输出）。
 * emit：拿到输出就立即调用（命令行用它写 stdout），本地记账放在之后做。
 */
export async function runHook(event: HookEvent, tool: Tool, stdin: string, fallbackCwd: string, emit?: (out: string) => void): Promise<string> {
  const started = Date.now();
  trace(`${event} ${tool} 开始`);
  let outcome: Outcome = { output: '' };
  try {
    outcome = await handle(event, tool, stdin, fallbackCwd, started);
  } catch (e) {
    logHookError(`${tool} ${event} ${fallbackCwd} ${message(e)}`);
  }
  if (outcome.output) emit?.(outcome.output);
  try {
    outcome.after?.();
  } catch (e) {
    logHookError(`${tool} ${event} ${message(e)}`);
  }
  const tags = [...new Set([...outcome.output.matchAll(/team-notices-([0-9a-f]{8})>/g)].map((m) => m[1]))];
  trace(`${event} 结束：${Date.now() - started} ms，输出 ${Buffer.byteLength(outcome.output)} 字节${tags.length ? `，边界 ${tags.join(' ')}` : ''}`);
  return outcome.output;
}

async function handle(event: HookEvent, tool: Tool, stdin: string, fallbackCwd: string, started: number): Promise<Outcome> {
  // 不认识的事件直接返回，不联网。包括旧版装的 PreToolUse 条目（hook pre-tool，没重装的仓库里还有）
  if (!Object.hasOwn(EVENT_NAME, event) || !TOOLS.includes(tool)) return { output: '' };
  const parsed = (stdin.trim() ? JSON.parse(stdin) : {}) as unknown;
  const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as HookInput;
  const cwd = typeof data.cwd === 'string' && data.cwd ? data.cwd : fallbackCwd;
  const loc = git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])?.split('\n');
  if (!loc || loc.length < 2) return { output: '' }; // 不在 git 仓库里
  const [root, gitDir] = loc;
  const cfg = readRepoConfig(root);
  if (!cfg) return { output: '' }; // 这个仓库没接入 teamlink
  const dir = join(gitDir, 'teamlink');
  const sessionId = typeof data.session_id === 'string' ? data.session_id : '';
  if (!sessionId) {
    // 不能用占位的会话号：服务器按“工具:会话号”记会话，两个人都用同一个占位值就会撞上
    throw new Error('hook 输入里没有 session_id');
  }
  try {
    noteHookRun(dir, tool, event);
  } catch {
    // 只是给 teamlink status 看的，写不了不影响送消息
  }
  const identity = identityFor(cfg.server);
  if (!identity) throw new Error(`本机还没有加入 ${cfg.server}（TEAMLINK_HOME=${teamlinkHome()}），先运行 teamlink setup`);
  const ctx: Ctx = {
    event,
    tool,
    data,
    root,
    cfg,
    identity,
    sessionId,
    dir,
    deadline: started + (event === 'session-end' ? END_LIMIT_MS : LIMIT_MS),
    backoff: backoffActive(dir),
    down: false,
    unsaved: [],
  };

  switch (event) {
    case 'session-start': {
      safely(ctx, () => saveLastSession(dir, tool, sessionId));
      if (!ctx.backoff) await flush(ctx);
      return delivered(ctx, await post<DeliveryResponse>(ctx, '/api/v2/sessions/start', sessionBody(ctx), ctx.backoff ? SHORT_MS : Infinity));
    }
    case 'prompt': {
      // 新的一回合：收尾检查可以再拦一次。本地动作，退避期间也要做
      safely(ctx, () => clearStopMarker(dir, tool, sessionId));
      safely(ctx, () => saveLastSession(dir, tool, sessionId));
      if (ctx.backoff) return delivered(ctx, null);
      await flush(ctx);
      return delivered(ctx, await post<DeliveryResponse>(ctx, '/api/v2/activity', sessionBody(ctx)));
    }
    case 'post-tool': {
      safely(ctx, () => saveLastSession(dir, tool, sessionId));
      // 退避期间不联网，只交出已经存下的补发结果
      if (ctx.backoff) return delivered(ctx, null);
      await flush(ctx);
      return delivered(ctx, await post<DeliveryResponse>(ctx, '/api/v2/activity', sessionBody(ctx)));
    }
    case 'stop':
      return stop(ctx);
    case 'session-end': {
      // 先清本地标记，再报下线（不受退避限制），用剩下的时间补发
      safely(ctx, () => clearSession(dir, tool, sessionId));
      safely(ctx, () => forgetLastSession(dir, tool, sessionId));
      await post(ctx, '/api/v2/sessions/end', { tool, sessionId });
      await flush(ctx);
      // 被退回的留到下次开工交给 AI；只是告知的直接丢掉，不留到下一个会话
      safely(ctx, () => keepRejected(dir, takeAll(ctx)));
      return { output: '' };
    }
  }
  return { output: '' };
}

/** 能联网了：清掉退避标记。 */
function reachable(ctx: Ctx): void {
  if (!ctx.backoff) return;
  ctx.backoff = false;
  safely(ctx, () => clearBackoff(ctx.dir));
}

/** 连不上或超时：设退避（60 秒内的 hook 不联网），这次 hook 也不再发别的请求。HTTP 错误不算。 */
function unreachable(ctx: Ctx, reason: string): void {
  ctx.down = true;
  safely(ctx, () => setBackoff(ctx.dir, reason));
  logHookError(`${ctx.tool} ${ctx.event} ${ctx.root} ${reason}`);
}

/** 发一个请求，超时取剩下的时间（capMs 再设个上限）。出错都返回 null：连不上就设退避，HTTP 错误记日志。 */
async function post<T>(ctx: Ctx, path: string, body: unknown, capMs = Infinity): Promise<T | null> {
  if (ctx.down) return null;
  const timeout = Math.min(capMs, ctx.deadline - MARGIN_MS - Date.now());
  if (timeout < 50) return null;
  try {
    const res = await call<T>(ctx.cfg.server, ctx.identity, 'POST', path, body, timeout);
    reachable(ctx);
    return res;
  } catch (e) {
    if (e instanceof NetworkError) {
      unreachable(ctx, e.message);
      return null;
    }
    if (e instanceof ClientError) reachable(ctx);
    logHookError(`${ctx.tool} ${ctx.event} ${ctx.root} ${path}：${message(e)}`);
    return null;
  }
}

/** 补发发件箱，最多 1.5 秒；结果先存进本地状态，由这次或之后能输出给 AI 的 hook 交出。 */
async function flush(ctx: Ctx): Promise<void> {
  if (ctx.down) return;
  let r: Awaited<ReturnType<typeof flushOutbox>>;
  try {
    r = await flushOutbox(ctx.root, ctx.cfg, ctx.identity, Math.min(Date.now() + SHORT_MS, ctx.deadline - MARGIN_MS), ctx.dir);
  } catch (e) {
    // 补发出了意外的错：这次不补发，主请求照常
    logHookError(`${ctx.tool} ${ctx.event} ${ctx.root} 补发失败：${message(e)}`);
    return;
  }
  try {
    saveNotes(ctx.dir, r.notes);
  } catch {
    ctx.unsaved.push(...r.notes);
  }
  if (r.networkError) unreachable(ctx, r.networkError);
  else if (r.stopped) logHookError(`${ctx.tool} ${ctx.event} ${ctx.root} ${r.stopped}`);
}

/** 取走全部待交的补发结果（包括之前的 hook 存下的）。 */
function takeAll(ctx: Ctx): FlushNote[] {
  const notes = ctx.unsaved.splice(0);
  try {
    notes.push(...takeNotes(ctx.dir));
  } catch (e) {
    logHookError(`${ctx.tool} ${ctx.event} ${ctx.root} 读补发结果失败：${message(e)}`);
  }
  return notes;
}

/** 送达类请求的请求体。 */
function sessionBody(ctx: Ctx): Record<string, unknown> {
  return { repoId: ctx.cfg.repoId, tool: ctx.tool, sessionId: ctx.sessionId };
}

/** session-start、prompt、post-tool 的输出：补发结果在前，服务器的文字在后。 */
function delivered(ctx: Ctx, resp: DeliveryResponse | null): Outcome {
  const text = [renderNotes(takeAll(ctx), true), resp?.text ?? ''].filter(Boolean).join('\n\n');
  return {
    output: text ? JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT_NAME[ctx.event], additionalContext: text } }) : '',
    after: () => remember(ctx, resp),
  };
}

/** 输出之后的本地记账：缓存成员名单；送到了消息就存进 received.md（只有队友段、或者只有“已连接”那一句时不存）。 */
function remember(ctx: Ctx, resp: DeliveryResponse | null): void {
  if (!resp) return;
  if (Array.isArray(resp.members)) safely(ctx, () => saveMembers(ctx.dir, ctx.cfg.server, resp.members as string[]));
  if (resp.hasMessages) safely(ctx, () => saveReceived(ctx.root, resp.messagesText ?? '', resp.ids?.length ?? 0));
}

/** 收尾检查拦下时的结尾：按这批里有什么给出动作。 */
function stopEnding(types: NoticeType[], rejected: boolean): string {
  const todo: string[] = [];
  if (types.includes('question')) todo.push('有提问，先 teamlink reply 再结束');
  if (types.includes('answer')) todo.push('有回答，按回答落实');
  if (types.includes('message')) todo.push('有消息，检查要不要据此调整当前的改动');
  if (rejected) todo.push('有被退回的，按原因改写后重发，或者告诉你的用户');
  return `结束之前：${todo.join('；')}。`;
}

/**
 * 收尾检查：先补发；被 Stop hook 拦下后的继续（stop_hook_active）或者本回合已经拦过，就什么都不输出。
 * 否则查一次服务器，有没送到的消息、或者有被退回的补发，就拦下一次（decision: block）。
 */
async function stop(ctx: Ctx): Promise<Outcome> {
  const { dir, tool, sessionId } = ctx;
  if (!ctx.backoff) await flush(ctx);
  // 本回合已经拦过：两种工具的标记都由 prompt hook（新的一回合）清掉
  const blocked = readStopMarker(dir, tool, sessionId) !== null;
  if (ctx.data.stop_hook_active === true || blocked) {
    safely(ctx, () => keepRejected(dir, takeAll(ctx)));
    return { output: '' };
  }
  const resp = await post<DeliveryResponse>(ctx, '/api/v2/sessions/stop-check', sessionBody(ctx), ctx.backoff ? SHORT_MS : Infinity);
  const notes = takeAll(ctx);
  const rejected = notes.some((n) => n.kind === 'rejected');
  const batch = resp?.hasMessages ? resp : null;
  // 没有消息、也没有被退回的：不拦。只是告知的补发结果直接丢掉，不留到下一个会话
  if (!batch && !rejected) return { output: '', after: () => remember(ctx, resp) };
  // types 和 ids 一一对应；万一没带，就按普通消息给结尾
  const types: NoticeType[] = batch ? (Array.isArray(batch.types) && batch.types.length > 0 ? batch.types : ['message']) : [];
  const reason = [renderNotes(notes, false), batch?.text ?? '', stopEnding(types, rejected)].filter(Boolean).join('\n\n');
  return {
    output: JSON.stringify({ decision: 'block', reason }),
    after: () => {
      safely(ctx, () => setStopMarker(dir, tool, sessionId));
      remember(ctx, resp);
    },
  };
}
