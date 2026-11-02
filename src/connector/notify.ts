// notify、ask、reply：先当场校验（--to、成员名、长度、声明格式），不对直接报错、不存发件箱；
// hook 的退避标记有效时、或者发件箱里还有待补发的（又有会话开着、马上有 hook 来补发）时直接存进发件箱；
// 否则直连发送（超时 8 秒），连不上再存发件箱，由 hook 补发。

import { randomUUID } from 'node:crypto';
import type { Claim, NoticeType, SendResponse } from '../shared/protocol.ts';
import { claimError, MAX_CLAIMS, MAX_SUMMARY_CHARS, TOOLS } from '../shared/protocol.ts';
import { call, ClientError, NetworkError } from './client.ts';
import type { Identity, RepoConfig } from './config.ts';
import { installedTools } from './install.ts';
import { OUTBOX_DIR, outboxCounts, reasonText, REJECTED, saveToOutbox, sentText } from './outbox.ts';
import { markAnswer, type AnswerState } from './received.ts';
import { backoffActive, lastHookRun, loadLastSession, loadMembers, openSessions, stateDirOf, stuckReason } from './state.ts';

export interface Outgoing {
  type: NoticeType;
  summary: string;
  claims: Claim[];
  /** 收件人（成员名）；回答不用写，收件人是提问的人。 */
  to: string[];
  /** 回答哪一条提问。 */
  replyTo?: string;
}

const SEND_TIMEOUT_MS = 8000;

export const QUEUED_TEXT = '暂时连不上服务器：已暂存，hook 会自动补发，不用重试。';
/**
 * 暂存的只有这个工作区的 hook 会补发：没装（比如新建的 worktree，hook 配置不提交，带不过去），
 * 或者装了但最近没运行（多半是还没信任），都没人补发，回执要说清楚。
 */
export const NO_HOOK_TEXT = `暂时连不上服务器：已暂存在 ${OUTBOX_DIR}/，但这个工作区没装 teamlink 的 hook，不会自动补发，队友的消息和回答也送不到这里。请你的用户在这个目录运行 teamlink install。`;
export const IDLE_HOOK_TEXT = '暂时连不上服务器：已暂存，但这个工作区最近没有 teamlink 的 hook 在运行（多半是 Codex 还没在 /hooks 里信任），暂存的消息没人补发。请你的用户运行 teamlink status。';
/** hook 补发时服务器一直回 401、426、5xx：暂存的发不出去，要人处理。 */
export const stuckText = (reason: string) => `暂时连不上服务器：已暂存，但这个工作区的发件箱现在补发不出去（${reason}），对方还没收到。请你的用户运行 teamlink status。`;

/** 排在暂存的后面时用的回执：没有试过连接，是为了顺序（更正的回答不会比原回答先到）。 */
export const BEHIND_TEXT = '前面还有暂存的消息没补发完：这条也先暂存，排在它们后面，hook 会按顺序补发，不用重试。';

/** 这么久以内有 hook 运行过，才算这个工作区装好的 hook 在工作（回执用）。 */
const HOOK_RECENT_MS = 30 * 60_000;
/** 有会话还开着、这么久以内它的 hook 运行过，才算马上就有 hook 来补发（排在暂存的后面时用）。 */
const HOOK_ACTIVE_MS = 5 * 60_000;

/** 这个工作区（每个 worktree 各算各的状态目录）30 分钟内有 hook 运行过。 */
function hooksRunning(dir: string | null): boolean {
  return dir !== null && TOOLS.some((t) => Date.now() - Date.parse(lastHookRun(dir, t)?.at ?? '') < HOOK_RECENT_MS);
}

/**
 * 有会话还开着、它的 hook 5 分钟内运行过：暂存的马上会被补发。按会话看（last-session.json，会话结束时去掉）：
 * 同一个工具的另一个会话结束了，不影响还开着的这个。
 */
function sessionActive(root: string): boolean {
  return openSessions(root).some((s) => Date.now() - Date.parse(s.at) < HOOK_ACTIVE_MS);
}

/** 和服务器一样的检查，在存进发件箱之前做：沙箱里连不上服务器时，错了也能当场知道。 */
function check(input: Outgoing, summary: string): void {
  const length = [...summary].length;
  if (length > MAX_SUMMARY_CHARS) throw new Error(`说明最多 ${MAX_SUMMARY_CHARS} 字，这条有 ${length} 字：请精简后重发`);
  if (input.claims.length > MAX_CLAIMS) throw new Error(`声明最多 ${MAX_CLAIMS} 条，这条有 ${input.claims.length} 条：只列最要紧的`);
  for (const c of input.claims) {
    const why = claimError(c);
    if (why) throw new Error(why);
  }
  // 只带声明、不写说明的消息服务器也收（旧发件箱里有这种），提问和回答必须有内容
  if (summary.trim() === '' && (input.type !== 'message' || input.claims.length === 0)) throw new Error(input.type === 'message' ? '缺少说明：--summary "改了什么、为什么"' : '缺少内容');
}

/** 收件人：必须写；hook 存下的成员名单里没有的名字当场报错；写了自己就去掉自己。 */
function recipients(root: string, cfg: RepoConfig, identity: Identity, names: string[]): string[] {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) throw new Error('没写发给谁：用 --to 成员名 点名（可以写多次）');
  const members = loadMembers(root, cfg.server);
  const unknown = members ? wanted.filter((n) => !members.includes(n)) : [];
  if (members && unknown.length > 0) throw new Error(`找不到成员：${unknown.join('、')}。现有成员：${members.join('、')}`);
  const to = wanted.filter((n) => n !== identity.name);
  if (to.length === 0) throw new Error('不能只发给你自己');
  return to;
}

function mark(root: string, input: Outgoing, state: AnswerState, summary: string, reason?: string): void {
  if (input.type !== 'answer' || !input.replyTo) return;
  try {
    markAnswer(root, input.replyTo, state, summary, reason);
  } catch {
    // 标记只是方便 AI 回看，写不了就算了
  }
}

/** 发一条消息，返回打印给 AI 的回执。格式不对、名字不对都当场抛错，不存发件箱。 */
export async function sendNotice(root: string, cfg: RepoConfig, identity: Identity, input: Outgoing): Promise<string> {
  const summary = input.summary.trimEnd();
  check(input, summary);
  const to = input.type === 'answer' ? [] : recipients(root, cfg, identity, input.to);
  // 归属的会话由 hook 记下（只用来按会话限流），没有就按成员限流
  const last = loadLastSession(root);
  const payload = {
    repoId: cfg.repoId,
    ...(last ? { tool: last.tool, sessionId: last.sessionId } : {}),
    type: input.type,
    summary,
    claims: input.claims,
    ...(input.type === 'answer' ? { replyTo: input.replyTo } : { to }),
    // 直连超时、改存发件箱后再补发时，服务器可能其实已经收到了：凭这个编号去重
    clientId: randomUUID(),
  };
  const dir = stateDirOf(root);
  const stuck = stuckReason(dir);
  const queue = (behind = false) => {
    saveToOutbox(root, payload);
    mark(root, input, 'queued', summary);
    if (behind) return BEHIND_TEXT;
    if (installedTools(root).length === 0) return NO_HOOK_TEXT;
    if (stuck) return stuckText(stuck);
    return hooksRunning(dir) ? QUEUED_TEXT : IDLE_HOOK_TEXT;
  };
  // hook 刚连不上服务器（退避中）：直接存，不用再等 8 秒超时
  if (backoffActive(dir)) return queue();
  // 发件箱里还有待补发的、又有会话开着（马上有 hook 来补发）：也存进去排在后面，更正的回答不会比原回答先到。
  // 会话都结束了、或者补发卡住了（服务器一直回 401、426、5xx）时照旧直连，不然会一直排在后面；直连出错时 AI 当场就能看到原因
  if (!stuck && outboxCounts(root).pending > 0 && sessionActive(root)) return queue(true);
  let res: SendResponse;
  try {
    res = await call<SendResponse>(cfg.server, identity, 'POST', '/api/v2/notices', payload, SEND_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof NetworkError) return queue();
    if (e instanceof ClientError && REJECTED.has(e.status)) mark(root, input, 'rejected', summary, reasonText(e.message));
    throw e;
  }
  mark(root, input, 'sent', summary);
  return sentText(input.type, res);
}
