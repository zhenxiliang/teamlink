// 本机状态：$(git rev-parse --git-dir)/teamlink/，每个 worktree 各一份（在 .git 里，不会被提交）。
// hook 之间要交接的东西都放这里：last-session.json、members.json、退避标记、待交的补发结果、
// 按“工具+会话”分的会话状态（stop 标记）、每个工具 hook 最近一次运行的时间。
// hook 在 AI 工具的沙箱外运行，读写这里；沙箱里的命令行只读（members.json、退避标记、last-session.json）。
// 所有写入都先写临时文件再 rename：几条 hook 并行时不会读到写了一半的文件。

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tool } from '../shared/protocol.ts';
import { git, teamlinkHome } from './config.ts';

/** 状态目录在哪（只算路径，不创建）。 */
export function stateDirOf(root: string): string | null {
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']);
  return gitDir ? join(gitDir, 'teamlink') : null;
}

/** AI 工具的沙箱里 .git 是只读的：目录已存在时，macOS 沙箱对 mkdir 也会直接报 EPERM，所以先判断是否存在。 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 先写临时文件再 rename 替换。mode 在 rename 之前就设好（启动脚本不能有一瞬间是不可执行的）。 */
export function writeAtomic(path: string, data: string, mode?: number): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    writeFileSync(tmp, data);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** 读一个 JSON 文件；不存在或者坏了都返回 null。 */
export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 用 mkdir 当锁（mkdir 是原子的）。锁比 staleMs 还旧，说明拿锁的进程已经没了，接管过来。拿到返回释放函数，拿不到返回 null。 */
export function tryLock(path: string, staleMs: number): (() => void) | null {
  ensureDir(dirname(path));
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(path);
      return () => rmSync(path, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs <= staleMs) return null;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // 刚好被释放了，再试一次
    }
  }
  return null;
}

/** 读改写一个本地文件时加锁：等不到锁（最多 waitMs）也照做，宁可偶尔丢一次本地记账，也不能卡住 hook。 */
export function withLock<T>(path: string, fn: () => T, waitMs = 300): T {
  const deadline = Date.now() + waitMs;
  let release = tryLock(path, 5000);
  while (!release && Date.now() < deadline) {
    sleepSync(10);
    release = tryLock(path, 5000);
  }
  try {
    return fn();
  } finally {
    release?.();
  }
}

// —— 发消息归属的会话：notify、ask、reply 带上它，服务器按会话限流 ——

export interface SessionRef {
  tool: Tool;
  sessionId: string;
  /** 这个会话最近一次 hook 的时间（同一个会话一分钟内只更新一次）。 */
  at: string;
}

/** last-session.json：这个工作区里还没结束的会话，最近活动的在最前面。 */
interface SessionsFile {
  sessions: SessionRef[];
}

/** 同一个会话的 hook 隔这么久才更新一次时间，免得每次工具调用都写盘。 */
const SEEN_REFRESH_MS = 60_000;
/** 别的会话这么久以内活动过，就算同时开着（崩掉、没跑 SessionEnd 的会话过这么久也就不算了）。 */
const SHARED_MS = 10 * 60_000;
/** 最多记这么多个会话。 */
const MAX_SESSIONS = 8;

const same = (s: SessionRef | undefined, tool: Tool, sessionId: string) => s?.tool === tool && s.sessionId === sessionId;
const validRef = (s: unknown): s is SessionRef => {
  const r = s as SessionRef | null;
  return !!r && (r.tool === 'claude' || r.tool === 'codex') && typeof r.sessionId === 'string' && r.sessionId !== '' && typeof r.at === 'string';
};

/** 读会话列表。旧版写的是单个会话 { tool, sessionId, at }，也认得。 */
function readSessions(path: string): SessionRef[] {
  const raw = readJson<SessionsFile & Partial<SessionRef>>(path);
  if (!raw) return [];
  const list = Array.isArray(raw.sessions) ? raw.sessions : [raw];
  return list.filter(validRef);
}

/** 这个会话的 hook 运行了：把它放到最前面，更新时间；顺手去掉 10 分钟没活动的别的会话。 */
export function saveLastSession(dir: string, tool: Tool, sessionId: string): void {
  const path = join(dir, 'last-session.json');
  // 大多数 hook 走这条：最前面就是这个会话、一分钟内更新过，不用拿锁
  const first = readSessions(path)[0];
  if (same(first, tool, sessionId) && Date.now() - Date.parse(first.at) < SEEN_REFRESH_MS) return;
  withLock(`${path}.lock`, () => {
    const now = Date.now();
    const list = readSessions(path);
    if (same(list[0], tool, sessionId) && now - Date.parse(list[0].at) < SEEN_REFRESH_MS) return;
    const others = list.filter((s) => !same(s, tool, sessionId) && now - Date.parse(s.at) < SHARED_MS);
    const sessions = [{ tool, sessionId, at: new Date(now).toISOString() }, ...others].slice(0, MAX_SESSIONS);
    writeAtomic(path, JSON.stringify({ sessions } satisfies SessionsFile));
  });
}

/** 会话结束：从 last-session.json 里去掉它。 */
export function forgetLastSession(dir: string, tool: Tool, sessionId: string): void {
  const path = join(dir, 'last-session.json');
  withLock(`${path}.lock`, () => {
    const list = readSessions(path);
    const sessions = list.filter((s) => !same(s, tool, sessionId));
    if (sessions.length === list.length) return;
    if (sessions.length === 0) rmSync(path, { force: true });
    else writeAtomic(path, JSON.stringify({ sessions } satisfies SessionsFile));
  });
}

/** 这个工作区里还没结束的会话，最近活动的在最前面（只读，命令行在沙箱里调用它）。 */
export function openSessions(root: string): SessionRef[] {
  const dir = stateDirOf(root);
  return dir ? readSessions(join(dir, 'last-session.json')) : [];
}

/**
 * notify、ask、reply 归属的会话：最近活动的那个。同一个工作区里还有别的会话 10 分钟内活动过时分不清是哪一个，返回 null：
 * 按成员限流，回答也不留给某一个会话（谁先来给谁），免得锁给了没提问的那个。只读，不创建目录：命令行在沙箱里调用它。
 */
export function loadLastSession(root: string): SessionRef | null {
  const [first, ...others] = openSessions(root);
  if (!first) return null;
  const now = Date.now();
  return others.some((s) => now - Date.parse(s.at) < SHARED_MS) ? null : first;
}

// —— 成员名单：每次送达类 hook 服务器都给，命令行据此当场校验 --to ——

interface MembersFile {
  server: string;
  members: string[];
  at: string;
}

export function saveMembers(dir: string, server: string, members: string[]): void {
  const path = join(dir, 'members.json');
  const cur = readJson<MembersFile>(path);
  if (cur?.server === server && JSON.stringify(cur.members) === JSON.stringify(members)) return;
  writeAtomic(path, JSON.stringify({ server, members, at: new Date().toISOString() } satisfies MembersFile));
}

/** 没有名单（还没开过工，或者是别的服务器的名单）时返回 null：交给服务器判断。 */
export function loadMembers(root: string, server: string): string[] | null {
  const dir = stateDirOf(root);
  const m = dir ? readJson<MembersFile>(join(dir, 'members.json')) : null;
  return m && m.server === server && Array.isArray(m.members) ? m.members.filter((x) => typeof x === 'string') : null;
}

// —— 退避：hook 连不上服务器（连接失败、超时）以后 60 秒内不联网。只有 hook 写，命令行只读 ——

export const BACKOFF_MS = 60_000;

interface Backoff {
  until: number;
  at: string;
  reason: string;
}

export function setBackoff(dir: string, reason: string): void {
  writeAtomic(join(dir, 'backoff.json'), JSON.stringify({ until: Date.now() + BACKOFF_MS, at: new Date().toISOString(), reason } satisfies Backoff));
}

export function clearBackoff(dir: string): void {
  rmSync(join(dir, 'backoff.json'), { force: true });
}

/** 退避标记还有效吗（比现在晚 60 秒以上的不算：本机时间往回调过）。 */
export function backoffActive(dir: string | null): boolean {
  const b = dir ? readJson<Backoff>(join(dir, 'backoff.json')) : null;
  const left = typeof b?.until === 'number' ? b.until - Date.now() : 0;
  return left > 0 && left <= BACKOFF_MS;
}

// —— 发件箱卡住：补发时服务器一直回 401、426、5xx（身份失效、版本不对、服务器出错），要人去处理 ——

interface Stuck {
  reason: string;
  /** 401、426 这种不会自己好的；5xx 可能只是服务器偶尔出错。 */
  persistent: boolean;
  /** 从什么时候开始一直补发不出去（中间成功过一次就清掉重来）。 */
  since: number;
  /** 最近一次补发卡住的时间。 */
  at: number;
  /** 最近一次告诉 AI 的时间（0 表示还没说过）。 */
  reportedAt: number;
}

/** 卡住的情况这么久告诉 AI 一次；5xx 连续这么久才算卡住；这么久以内卡住过，命令行的回执就照实说。 */
const STUCK_REPORT_MS = 10 * 60_000;
const STUCK_TRANSIENT_MS = 2 * 60_000;
const STUCK_FRESH_MS = 30 * 60_000;

/** 真算卡住了：401、426 当场算，5xx 连续 2 分钟以上才算。 */
const due = (s: Stuck, now: number) => s.persistent || now - s.since >= STUCK_TRANSIENT_MS;

/** 记下这一轮补发卡住了；返回这次要不要告诉 AI（真算卡住以后，同一个原因 10 分钟说一次）。 */
export function noteStuck(dir: string, reason: string, persistent: boolean): boolean {
  const path = join(dir, 'stuck.json');
  const cur = readJson<Stuck>(path);
  const now = Date.now();
  const next: Stuck = { reason, persistent, since: typeof cur?.since === 'number' ? cur.since : now, at: now, reportedAt: cur?.reason === reason ? cur.reportedAt : 0 };
  const report = due(next, now) && !(now - next.reportedAt < STUCK_REPORT_MS);
  if (report) next.reportedAt = now;
  writeAtomic(path, JSON.stringify(next));
  return report;
}

export function clearStuck(dir: string): void {
  rmSync(join(dir, 'stuck.json'), { force: true });
}

/** 发件箱真卡住了、并且 30 分钟内还卡着：返回原因（命令行只读）。 */
export function stuckReason(dir: string | null): string | null {
  const s = dir ? readJson<Stuck>(join(dir, 'stuck.json')) : null;
  const now = Date.now();
  return s && typeof s.reason === 'string' && typeof s.since === 'number' && now - s.at < STUCK_FRESH_MS && due(s, now) ? s.reason : null;
}

// —— 待交的补发结果：补发的 hook 先存下，由下一次能输出给 AI 的 hook 交出 ——

export interface FlushNote {
  /** rejected：被退回，要 AI 处理（会让 stop 拦下）；offline：只是告知，stop 和 session-end 时直接丢掉。 */
  kind: 'rejected' | 'offline';
  text: string;
}

/** 每次存成一个新文件，几条 hook 同时存也不会互相覆盖。 */
export function saveNotes(dir: string, notes: FlushNote[]): void {
  if (notes.length === 0) return;
  writeAtomic(join(dir, 'results', `${Date.now()}-${process.pid}-${randomBytes(3).toString('hex')}.json`), JSON.stringify(notes));
}

/** 取走全部待交的结果：先 rename 抢到手再读，读完删掉，同一份结果不会交两次。 */
export function takeNotes(dir: string): FlushNote[] {
  const sub = join(dir, 'results');
  if (!existsSync(sub)) return [];
  const notes: FlushNote[] = [];
  for (const name of readdirSync(sub).filter((f) => f.endsWith('.json')).sort()) {
    const taken = join(sub, `${name}.taking-${process.pid}`);
    try {
      renameSync(join(sub, name), taken);
    } catch {
      continue; // 被别的 hook 抢走了
    }
    const list = readJson<FlushNote[]>(taken);
    rmSync(taken, { force: true });
    if (Array.isArray(list)) notes.push(...list.filter((n) => n && typeof n.text === 'string'));
  }
  return notes;
}

/** 把需要处理的（被退回）留给下一次能输出的 hook，只是告知的直接丢掉（stop、session-end 用）。 */
export function keepRejected(dir: string, notes: FlushNote[]): void {
  saveNotes(dir, notes.filter((n) => n.kind === 'rejected'));
}

// —— 按“工具+会话”分的会话状态：sessions/<工具>-<会话号>/ 下的 stop.json ——

/** 会话号里不安全的字符换掉；换过的再加一段哈希，免得两个会话撞名。 */
function sessionKey(tool: Tool, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return safe === sessionId ? `${tool}-${safe}` : `${tool}-${safe}-${createHash('sha256').update(sessionId).digest('hex').slice(0, 8)}`;
}

function sessionDir(dir: string, tool: Tool, sessionId: string): string {
  return join(dir, 'sessions', sessionKey(tool, sessionId));
}

/** 收尾检查拦过一次的标记：同一回合不再拦，prompt hook（新的一回合）清掉。 */
export interface StopMarker {
  at: string;
}

export function setStopMarker(dir: string, tool: Tool, sessionId: string): void {
  writeAtomic(join(sessionDir(dir, tool, sessionId), 'stop.json'), JSON.stringify({ at: new Date().toISOString() } satisfies StopMarker));
}

export function readStopMarker(dir: string, tool: Tool, sessionId: string): StopMarker | null {
  return readJson<StopMarker>(join(sessionDir(dir, tool, sessionId), 'stop.json'));
}

export function clearStopMarker(dir: string, tool: Tool, sessionId: string): void {
  rmSync(join(sessionDir(dir, tool, sessionId), 'stop.json'), { force: true });
}

/** 会话结束：清掉这个会话的全部本地状态（stop 标记）。 */
export function clearSession(dir: string, tool: Tool, sessionId: string): void {
  rmSync(sessionDir(dir, tool, sessionId), { recursive: true, force: true });
}

// —— 每个工具的 hook 最近一次运行的时间（teamlink status 用）——

export interface HookRun {
  event: string;
  at: string;
}

export function noteHookRun(dir: string, tool: Tool, event: string): void {
  writeAtomic(join(dir, `last-hook-${tool}.json`), JSON.stringify({ event, at: new Date().toISOString() } satisfies HookRun));
}

export function lastHookRun(dir: string, tool: Tool): HookRun | null {
  return readJson<HookRun>(join(dir, `last-hook-${tool}.json`));
}

// —— 错误日志：$TEAMLINK_HOME/hook-errors.log，启动脚本、版本检查和 hook 都写这里 ——

export function hookErrorLog(): string {
  return join(teamlinkHome(), 'hook-errors.log');
}

const MAX_LOG_BYTES = 1024 * 1024;

export function logHookError(line: string): void {
  try {
    const path = hookErrorLog();
    ensureDir(dirname(path));
    // 一直出错时别让日志无限变大：超过 1 MB 就换一个新文件，旧的留一份
    if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${new Date().toISOString()} ${line.replace(/\s*\n\s*/g, ' ')}\n`);
  } catch {
    // 连日志都写不了就算了
  }
}
