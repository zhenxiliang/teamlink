// 发件箱：AI 在沙箱里运行 notify、ask、reply 时常常连不上服务器（例如 Codex 默认断网），
// 先把消息存在工作区的 .team/outbox/，由下一次 hook（在沙箱外运行）补发。服务器按 clientId 去重。

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NoticeType, Presence, SendResponse } from '../shared/protocol.ts';
import { agoText, excerpt, normalizeText } from '../shared/render.ts';
import { call, ClientError, NetworkError } from './client.ts';
import { excludeLocally, type Identity, type RepoConfig } from './config.ts';
import { markAnswer } from './received.ts';
import { clearStuck, noteStuck, tryLock, writeAtomic, type FlushNote } from './state.ts';

export const OUTBOX_DIR = '.team/outbox';
const FAILED_DIR = `${OUTBOX_DIR}/failed`;

export function saveToOutbox(root: string, payload: unknown): string {
  // 没有编号的补上一个，重发时服务器才能去重
  const body = payload && typeof payload === 'object' && !('clientId' in payload) ? { ...payload, clientId: randomUUID() } : payload;
  // 文件名以毫秒时间开头：补发时按名字排序就是发送的先后
  const path = join(root, OUTBOX_DIR, `${Date.now()}-${randomBytes(3).toString('hex')}.json`);
  writeAtomic(path, JSON.stringify(body));
  try {
    excludeLocally(root, '.team/');
  } catch {
    // 沙箱里 .git 可能是只读的；安装时已经加过排除规则
  }
  return path;
}

/** 发件箱里待补发的和 failed/ 里的条数（teamlink status 用）。 */
export function outboxCounts(root: string): { pending: number; failed: number } {
  const count = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).length : 0);
  return { pending: count(join(root, OUTBOX_DIR)), failed: count(join(root, FAILED_DIR)) };
}

// —— 发送结果的文字：命令行的回执和补发结果共用，措辞一致 ——

const LABEL: Record<NoticeType, string> = { question: '提问', answer: '回答', message: '消息' };

/** 多久以前，按本机时钟算（签名校验保证了和服务器差不过 5 分钟）。 */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  return agoText(Number.isFinite(t) ? Math.max(1, Math.floor((now - t) / 60_000)) : 1);
}

const nameOf = (name: string) => normalizeText(name, true);

/** 点名的人不在线时怎么说，按消息类型措辞。 */
export function offlineText(type: NoticeType, p: Presence): string {
  const name = nameOf(p.name);
  if (type === 'answer') return `提问的 ${name} 已下线，他下次开工时会收到。`;
  if (type === 'question') {
    const when = p.lastSeenAt ? `上次活动 ${ago(p.lastSeenAt)}` : '还没开过会话';
    return `${name} 现在不在线（${when}），回答多半要等他下次开工：先做不依赖这条信息的部分。`;
  }
  return `${name} 不在线，下次开工时会收到。`;
}

/** 成功发出后的回执：“已发给 X、Y。”，不在线的人各补一句。 */
export function sentText(type: NoticeType, r: SendResponse): string {
  const offline = (r.presence ?? []).filter((p) => !p.online);
  return [`已发给 ${r.recipients.map(nameOf).join('、')}。`, ...offline.map((p) => offlineText(type, p))].join('');
}

/** 退回原因：服务器 422 的正文以“这条消息没有发出：”开头，和“被退回，对方没有收到”重复，去掉，省下的字数留给原因本身。 */
export function reasonText(reason: string): string {
  return reason.replace(/^这条消息没有发出[：:]\s*/, '');
}

/** 补发结果的本地文字整段最多这么多字节（不算进服务器的 8000）。 */
const NOTES_MAX_BYTES = 800;

/**
 * 补发结果的本地文字，放在服务器文字前面：被退回的排前面，放不下的只写条数。
 * hint：结尾提示被退回的怎么办（收尾检查自己有结尾，不用这句）。
 */
export function renderNotes(notes: FlushNote[], hint: boolean): string {
  const unique = [...new Map(notes.map((n) => [`${n.kind}:${n.text}`, n])).values()];
  if (unique.length === 0) return '';
  const ordered = [...unique.filter((n) => n.kind === 'rejected'), ...unique.filter((n) => n.kind !== 'rejected')];
  const head = 'teamlink 补发结果（你之前暂存的消息）：';
  const tail = hint && ordered[0].kind === 'rejected' ? '被退回的：按原因改写后重发，或者告诉你的用户。' : '';
  const more = (n: number) => `（另有 ${n} 条没列出，被退回的原件在 ${FAILED_DIR}/）`;
  const size = (lines: string[]) => Buffer.byteLength([head, ...lines, tail].filter(Boolean).join('\n'));
  const lines: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const line = `- ${excerpt(ordered[i].text, 200)}`;
    const rest = ordered.length - i - 1;
    if (size([...lines, line, ...(rest > 0 ? [more(rest)] : [])]) > NOTES_MAX_BYTES) {
      lines.push(more(ordered.length - i));
      break;
    }
    lines.push(line);
  }
  return [head, ...lines, tail].filter(Boolean).join('\n');
}

// —— 补发 ——

/** 这些状态码说明消息本身有问题（格式、收件人、长度、审核）：补发时移进 failed/，告诉 AI 被退回了。 */
export const REJECTED = new Set([400, 403, 404, 413, 422]);

/** 发件箱里存的就是发给 /api/v2/notices 的请求体（旧版本存的也照发，服务器认得）。 */
interface Payload {
  type?: unknown;
  summary?: unknown;
  replyTo?: unknown;
  clientId?: unknown;
}

const typeOf = (p: Payload): NoticeType => (typeof p.replyTo === 'string' && p.replyTo ? 'answer' : p.type === 'question' || p.type === 'answer' ? p.type : 'message');

export interface FlushResult {
  /** 这一轮的结果：调用方先存进本地状态，由下一次能输出给 AI 的 hook 交出。 */
  notes: FlushNote[];
  /** 连不上服务器或者超时：本轮停了，调用方要设退避。这一轮服务器回过话以后才超时的不算（是补发的时间用完了）。 */
  networkError?: string;
  /** 401、426、429、5xx 这类和消息本身无关的错误：消息留着，本轮停了。 */
  stopped?: string;
  /** 本轮停在哪个状态码上（0 表示不是 HTTP 错误），和原因（不带文件名，给 AI 看）。 */
  status?: number;
  reason?: string;
}

function moveToFailed(root: string, name: string): void {
  mkdirSync(join(root, FAILED_DIR), { recursive: true });
  try {
    renameSync(join(root, OUTBOX_DIR, name), join(root, FAILED_DIR, name));
  } catch {
    // 文件已经不在了（比如用户手动删了）：结果照记
  }
}

/** 旧版连接器补发到一半进程没了留下的 .sending-<pid> 文件：一分钟前的放回去重发，服务器按编号去重。 */
function restoreClaimed(dir: string): void {
  for (const name of readdirSync(dir)) {
    const m = /^(.+\.json)\.sending-\d+$/.exec(name);
    if (!m) continue;
    try {
      if (Date.now() - statSync(join(dir, name)).mtimeMs > 60_000) renameSync(join(dir, name), join(dir, m[1]));
    } catch {
      // 被别人处理掉了
    }
  }
}

/**
 * 按存进去的先后补发，最晚到 deadline 为止（每个请求的超时取剩下的时间）。按状态码处理：
 * 2xx 删掉，点名的人不在线时记一条“对方不在线”；400、403、404、413、422 和坏掉的文件移进 failed/，记“被退回”；
 * 401、426、429、5xx 留着，本轮停止（后面的也不发，顺序不乱），一直卡着的由 noteRound 记账、告诉 AI；连不上也留着、本轮停止，由调用方设退避
 * （这一轮服务器已经回过话、后面的请求才超时的，是补发的时间用完了：本轮停止，不设退避，主请求照发）。
 */
export async function flushOutbox(root: string, cfg: RepoConfig, identity: Identity, deadline: number, stateDir?: string): Promise<FlushResult> {
  const dir = join(root, OUTBOX_DIR);
  const result: FlushResult = { notes: [] };
  // 没有待补发的：之前记下的“卡住”也不作数了
  const empty = () => {
    if (stateDir) quietly(() => clearStuck(stateDir));
    return result;
  };
  if (!existsSync(dir)) return empty();
  restoreClaimed(dir);
  const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (names.length === 0) return empty();
  // 一次只让一个 hook 补发（Codex 会并行跑几条 hook）：同一会话的消息按顺序到，更正的回答不会比原回答先到
  const release = tryLock(join(dir, '.flushing'), 10_000);
  if (!release) return result;
  try {
    // 这一轮服务器回过话：之后再超时，不算连不上
    let answered = false;
    let sent = 0;
    for (const name of names) {
      const left = deadline - Date.now();
      if (left < 50) break; // 时间用完了，剩下的下次再发
      const path = join(dir, name);
      let payload: Payload;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是 JSON 对象');
        payload = parsed as Payload;
      } catch {
        if (!existsSync(path)) continue;
        moveToFailed(root, name);
        result.notes.push({ kind: 'rejected', text: `暂存的 ${name} 坏了（不是合法的 JSON），没有发出，已移到 ${FAILED_DIR}/` });
        continue;
      }
      if (typeof payload.clientId !== 'string') {
        // 老版本存的没有编号：补上并写回，再重发时服务器才能去重
        payload = { ...payload, clientId: randomUUID() };
        writeAtomic(path, JSON.stringify(payload));
      }
      const type = typeOf(payload);
      const summary = typeof payload.summary === 'string' ? payload.summary : '';
      const what = `暂存的${LABEL[type]}「${excerpt(summary, 40)}」`;
      const mark = (state: 'sent' | 'rejected', reason?: string) => {
        if (type !== 'answer') return;
        try {
          markAnswer(root, String(payload.replyTo), state, summary, reason);
        } catch {
          // 标记只是方便 AI 查，写不了就算了
        }
      };
      let res: SendResponse;
      try {
        res = await call<SendResponse>(cfg.server, identity, 'POST', '/api/v2/notices', payload, left);
      } catch (e) {
        if (e instanceof NetworkError) {
          if (!answered) result.networkError = e.message;
          break;
        }
        answered = true;
        const status = e instanceof ClientError ? e.status : 0;
        const reason = reasonText(e instanceof Error ? e.message : String(e));
        if (REJECTED.has(status)) {
          moveToFailed(root, name);
          mark('rejected', reason);
          result.notes.push({ kind: 'rejected', text: `${what}被退回，对方没有收到：${excerpt(reason, 60)}` });
          continue;
        }
        result.stopped = `补发 ${name} 时服务器返回 ${status || '错误'}：${reason}`;
        result.status = status;
        result.reason = `服务器返回 ${status || '错误'}：${excerpt(reason, 80)}`;
        break;
      }
      answered = true;
      sent++;
      rmSync(path, { force: true });
      mark('sent');
      const offline = Array.isArray(res.presence) && res.presence.some((p) => !p.online);
      if (offline && Array.isArray(res.recipients)) result.notes.push({ kind: 'offline', text: `${what}${sentText(type, res)}` });
    }
    // 还拿着补发的锁时记账：并行的 hook 不会把已经恢复的旧故障写回去
    if (stateDir) quietly(() => noteRound(stateDir, result, sent, readdirSync(dir).filter((f) => f.endsWith('.json')).length));
  } finally {
    release();
  }
  return result;
}

/**
 * 补发卡住的记账（hook 用）：这一轮发出去过，之前的“卡住”就不作数（5xx 的连续计时从这次重新算）；
 * 停在 401、426（当场算）或 5xx（连续 2 分钟才算）上，记下来，同一个原因 10 分钟告诉 AI 一次（429 只是太频繁，不算）；
 * 没停下、发件箱也空了，清掉。没来得及发（时间用完）就什么都不动。
 */
function noteRound(stateDir: string, r: FlushResult, sent: number, left: number): void {
  if (sent > 0) clearStuck(stateDir);
  if (r.stopped && r.status !== 429) {
    const reason = r.reason ?? r.stopped;
    if (noteStuck(stateDir, reason, r.status === 401 || r.status === 426)) {
      r.notes.push({ kind: 'offline', text: `暂存的消息补发不出去（${reason}），对方还没收到：请告诉你的用户，让他运行 teamlink status 看看。` });
    }
  } else if (!r.stopped && left === 0) clearStuck(stateDir);
}

/** 本地记账出错不影响补发。 */
function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // 写不了就算了，下一轮再记
  }
}
