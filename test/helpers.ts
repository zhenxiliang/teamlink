// 端到端测试共用的部分：真实的 git 远程仓库 + 服务器（startServer({ port: 0 })，默认策略）+ 几个成员的本地连接器。
// 命令行和 hook 直接在本进程里调用（runCli、runHook）；启动脚本、一键接入、服务器命令用子进程真跑。
// 每个 e2e-*.test.ts 是一个进程，各有自己的一套（before 里建）；每个用例开头用 fresh() 把前面用例留下的会话和没送达的消息清掉，互不影响。

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/connector/cli.ts';
import { runHook, type HookEvent } from '../src/connector/hook.ts';
import { signRequest } from '../src/shared/crypto.ts';
import { PROTOCOL, PROTOCOL_HEADER, type Tool } from '../src/shared/protocol.ts';
import type { Engine } from '../src/server/engine.ts';
import { openEngine, startServer, type RunningServer } from '../src/server/main.ts';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const BIN = join(ROOT, 'bin/teamlink.js');
export const SERVER_BIN = join(ROOT, 'bin/teamlink-server.js');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const tmp = mkdtempSync(join(tmpdir(), 'teamlink-e2e-'));
export const remote = join(tmp, 'remote.git');
export let server: RunningServer;
export let engine: Engine;
export let repoId: string;
/** 服务器事件（以前写进审计表，现在打到 stderr）：测试里收进数组。 */
export const serverLog: string[] = [];

export const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function write(dir: string, path: string, content: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

export interface Dev {
  name: string;
  dir: string;
  home: string;
}
export const devs: Record<string, Dev> = {};

/** 以某个成员的身份运行 teamlink 命令。抛错时 code 为 1、out 带上错误信息（和 bin/teamlink.js 打印的一样）。 */
export async function cli(dev: Dev, ...argv: string[]): Promise<{ code: number; out: string }> {
  process.env.TEAMLINK_HOME = dev.home;
  let out = '';
  try {
    const code = await runCli(argv, dev.dir, (s) => (out += s));
    return { code, out };
  } catch (e) {
    return { code: 1, out: out + (e instanceof Error ? e.message : String(e)) };
  }
}

/** 应该成功的命令：返回输出。 */
export async function as(dev: Dev, ...argv: string[]): Promise<string> {
  const r = await cli(dev, ...argv);
  assert.equal(r.code, 0, `teamlink ${argv.join(' ')} 失败：${r.out}`);
  return r.out;
}

/** 应该失败的命令：返回错误信息。 */
export async function fails(dev: Dev, ...argv: string[]): Promise<string> {
  const r = await cli(dev, ...argv);
  assert.equal(r.code, 1, `teamlink ${argv.join(' ')} 应该失败：${r.out}`);
  return r.out;
}

/** hook 的原始输出（JSON 字符串，空串表示什么都不输出）。 */
export async function hookRaw(dev: Dev, event: HookEvent, tool: Tool, data: Record<string, unknown> = {}): Promise<string> {
  process.env.TEAMLINK_HOME = dev.home;
  return runHook(event, tool, JSON.stringify({ cwd: dev.dir, ...data }), dev.dir);
}

/** 能输出给 AI 的 hook（session-start、prompt、post-tool）：返回注入的文字。 */
export async function hook(dev: Dev, event: HookEvent, tool: Tool, data: Record<string, unknown> = {}): Promise<string> {
  const raw = await hookRaw(dev, event, tool, data);
  return raw ? (JSON.parse(raw).hookSpecificOutput.additionalContext as string) : '';
}

export interface StopOutput {
  decision: string;
  reason: string;
}

/** 收尾检查：拦下时返回 { decision, reason }，不拦返回 null。 */
export async function stop(dev: Dev, tool: Tool, session: string, extra: Record<string, unknown> = {}): Promise<StopOutput | null> {
  const raw = await hookRaw(dev, 'stop', tool, { session_id: session, ...extra });
  return raw ? (JSON.parse(raw) as StopOutput) : null;
}

export const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
export const postTool = (dev: Dev, session: string, tool: Tool = 'claude') => hook(dev, 'post-tool', tool, { session_id: session, ...bash('ls') });

export const gitDir = (dev: Dev) => sh(dev.dir, 'rev-parse', '--absolute-git-dir');
/** 本机状态目录：$(git rev-parse --git-dir)/teamlink/，每个 worktree 一份。 */
export const stateDir = (dev: Dev) => join(gitDir(dev), 'teamlink');
export const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
export const received = (dev: Dev) => readText(join(dev.dir, '.team/received.md'));
export const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);
export const outbox = (dev: Dev) => jsonFiles(join(dev.dir, '.team/outbox'));
export const failed = (dev: Dev) => jsonFiles(join(dev.dir, '.team/outbox/failed'));
export const hookLog = (dev: Dev) => readText(join(dev.home, 'hook-errors.log'));
export const hasBackoff = (dev: Dev) => existsSync(join(stateDir(dev), 'backoff.json'));
export const clearBackoff = (dev: Dev) => rmSync(join(stateDir(dev), 'backoff.json'), { force: true });

/** 模拟 hook 刚连不上服务器：写一个 60 秒的退避标记（hook 写，命令行只读）。 */
export function setBackoff(dev: Dev) {
  write(stateDir(dev), 'backoff.json', JSON.stringify({ until: Date.now() + MINUTE, at: new Date().toISOString(), reason: '测试' }));
}

export interface Identity {
  memberId: string;
  deviceId: string;
  privateKey: string;
}
export const identity = (dev: Dev, url = server.url): Identity => JSON.parse(readFileSync(join(dev.home, 'identities.json'), 'utf8'))[url];
export const memberId = (name: string) => engine.store.memberByName(name)?.id ?? assert.fail(`没有成员 ${name}`);

export interface NoticeRow {
  id: string;
  type: string;
  summary: string;
  to_names: string;
  sender_session_id: string | null;
  client_id: string | null;
}
export const latestNotice = () => engine.store.get<NoticeRow>('SELECT * FROM notices ORDER BY rowid DESC LIMIT 1') ?? assert.fail('还没有通知');
export const noticeCount = () => engine.store.get<{ c: number }>('SELECT COUNT(*) AS c FROM notices')?.c ?? 0;
/** 某人收没收到某条：已送达时返回送达时间。 */
export const delivered = (noticeId: string, name: string) =>
  engine.store.get<{ delivered_at: string | null }>('SELECT delivered_at FROM recipients WHERE notice_id = ? AND member_id = ?', noticeId, memberId(name))?.delivered_at ?? null;

/** 每个用例开头调用：前面用例留下的会话都挪到 8 天前（不在线，也不再算队友），没送达的消息都记成已送达。 */
export function fresh() {
  const old = new Date(Date.now() - 8 * DAY).toISOString();
  engine.store.run('UPDATE sessions SET last_seen_at = ?, ended_at = COALESCE(ended_at, ?)', old, old);
  const now = new Date().toISOString();
  // 交出去了、还没确认的也都算确认过：不会在后面的用例里被重发
  engine.store.run("UPDATE recipients SET delivered_at = COALESCE(delivered_at, ?), delivered_session = COALESCE(delivered_session, 'test:fresh'), acked_at = ? WHERE acked_at IS NULL", now, now);
  // 本地记着、还没回传的送达确认也清掉
  for (const dev of Object.values(devs)) rmSync(join(stateDir(dev), 'acks'), { recursive: true, force: true });
  // 本地也一样：前面的用例留下的会话都算结束了（不然会被当成同一个工作区里还开着另一个会话）
  for (const dev of Object.values(devs)) rmSync(join(stateDir(dev), 'last-session.json'), { force: true });
}

export let lastTs = 0;
/**
 * 不经过连接器、直接发签名请求。protocol 是协议头的值，null 表示不带（模拟没升级的旧连接器）。
 * ed25519 签名是确定的，同一毫秒里同样的请求会被当成重放，所以时间戳不重复。
 */
export async function signedAt(url: string, id: Pick<Identity, 'deviceId' | 'privateKey'>, method: 'GET' | 'POST', path: string, body?: unknown, protocol: string | null = String(PROTOCOL)) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  lastTs = Math.max(Date.now(), lastTs + 1);
  const ts = String(lastTs);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-tl-device': id.deviceId, 'x-tl-ts': ts, 'x-tl-sig': signRequest(id.privateKey, method, path, ts, raw) };
  if (protocol !== null) headers[PROTOCOL_HEADER] = protocol;
  const res = await fetch(url + path, { method, headers, body: method === 'GET' ? undefined : raw });
  return { status: res.status, protocol: res.headers.get(PROTOCOL_HEADER), body: (await res.json()) as any };
}
export const signed = (dev: Dev, method: 'GET' | 'POST', path: string, body?: unknown, protocol: string | null = String(PROTOCOL)) =>
  signedAt(server.url, identity(dev), method, path, body, protocol);

/** 记下 fn 运行期间本进程发出的 HTTP 请求（client.ts 用的是全局 fetch），用来确认“不联网”。 */
export async function fetchesDuring<T>(fn: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return original(input, init);
  }) as typeof fetch;
  try {
    return { result: await fn(), urls };
  } finally {
    globalThis.fetch = original;
  }
}

/** 模拟 AI 工具的沙箱断网：fn 运行期间本进程的请求都失败（EPERM）。hook 在沙箱外运行，不要放在 fn 里调。 */
export async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('connect EPERM'), { code: 'EPERM' }) }))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** 子进程跑命令（服务器在本进程里，子进程必须异步启动，否则服务器没法响应）。until：输出里出现它就结束进程（用于 start）。 */
export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string; until?: RegExp } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((ok) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? tmp, env: opts.env ?? process.env });
    let out = '';
    let err = '';
    const check = () => {
      if (opts.until?.test(out + err)) child.kill();
    };
    child.stdout.on('data', (d) => {
      out += d;
      check();
    });
    child.stderr.on('data', (d) => {
      err += d;
      check();
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      ok({ code, out, err });
    });
    child.stdin.end(opts.input ?? '');
  });
}

export interface Stub {
  url: string;
  /** 收到的请求：“方法 路径”。 */
  hits: string[];
  /** 怎么回应（hit 是这个请求的“方法 路径”）；不调用 res.end 就是挂住不回。 */
  respond: (res: ServerResponse, hit: string) => void;
  close: () => Promise<void>;
}

export function reply(res: ServerResponse, status: number, body: unknown, protocol = true) {
  res.writeHead(status, { 'content-type': 'application/json', ...(protocol ? { [PROTOCOL_HEADER]: String(PROTOCOL) } : {}) });
  res.end(JSON.stringify(body));
}

/** 假服务器：用来造 401、426、5xx、没有协议头、挂住不回这些真服务器不会给的情况。 */
export async function startStub(): Promise<Stub> {
  const stub: Stub = { url: '', hits: [], respond: (res) => reply(res, 500, { error: '假服务器' }), close: async () => {} };
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const hit = `${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`;
      stub.hits.push(hit);
      stub.respond(res, hit);
    });
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  stub.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((ok) => {
      srv.close(() => ok());
      srv.closeAllConnections();
    });
  return stub;
}

/** 一个没人监听的地址：连上去立即失败（ECONNREFUSED）。 */
export async function closedPort(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const { port } = srv.address() as AddressInfo;
  await new Promise((ok) => srv.close(ok));
  return `http://127.0.0.1:${port}`;
}

/** 另一份克隆，.teamlink.json 指向 url，身份借用 alice 的登记在这个地址下（假服务器不验签）。再调一次就是改指向。 */
export function devAt(name: string, url: string): Dev {
  const dev = { name, dir: join(tmp, name), home: join(tmp, `home-${name}`) };
  if (!existsSync(dev.dir)) {
    sh(tmp, 'clone', '-q', remote, dev.dir);
    sh(dev.dir, 'config', 'user.email', `${name}@example.com`);
    sh(dev.dir, 'config', 'user.name', name);
  }
  writeFileSync(join(dev.dir, '.teamlink.json'), JSON.stringify({ server: url, repoId }));
  const ids = existsSync(join(dev.home, 'identities.json')) ? JSON.parse(readFileSync(join(dev.home, 'identities.json'), 'utf8')) : {};
  ids[url] = { ...identity(devs.alice), server: url, name };
  write(dev.home, 'identities.json', JSON.stringify(ids));
  return dev;
}

/** 同一个远程仓库的一份新克隆，身份用 owner 的（还没有 .teamlink.json，也没装 hook）。 */
export function cloneAs(owner: Dev, name: string): Dev {
  const dir = join(tmp, name);
  sh(tmp, 'clone', '-q', remote, dir);
  sh(dir, 'config', 'user.email', `${owner.name}@example.com`);
  sh(dir, 'config', 'user.name', owner.name);
  return { ...owner, dir };
}

/** 用 git worktree add 给 dev 再建一个工作区：.teamlink.json 拷过去（像提交过一样）；hook 配置不提交，带不过去。 */
export function worktreeOf(dev: Dev, name: string): Dev {
  const dir = join(tmp, name);
  sh(dev.dir, 'worktree', 'add', '-q', '-b', name, dir);
  copyFileSync(join(dev.dir, '.teamlink.json'), join(dir, '.teamlink.json'));
  return { ...dev, dir };
}

before(async () => {
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(tmp, 'seed');
  sh(tmp, 'clone', '-q', remote, seed);
  sh(seed, 'config', 'user.email', 'seed@example.com');
  sh(seed, 'config', 'user.name', 'seed');
  sh(seed, 'checkout', '-q', '-b', 'main');
  write(seed, 'src/user.ts', 'export function getUser(id: string) {\n  return { id };\n}\n');
  write(seed, 'py/users.py', 'def load_user(uid):\n    return {"id": uid}\n');
  write(seed, 'web/profile.ts', 'export const profile = (id: string) => id;\n');
  write(seed, 'README.md', '# demo\n');
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'init');
  sh(seed, 'push', '-q', 'origin', 'main');

  engine = openEngine(join(tmp, 'server'), { log: (line) => serverLog.push(line) });
  repoId = engine.addRepo(remote).id;
  server = await startServer({ engine, port: 0 });

  for (const name of ['alice', 'bob', 'carol', 'dave']) {
    const dev = { name, dir: join(tmp, name), home: join(tmp, `home-${name}`) };
    devs[name] = dev;
    sh(tmp, 'clone', '-q', remote, dev.dir);
    sh(dev.dir, 'config', 'user.email', `${name}@example.com`);
    sh(dev.dir, 'config', 'user.name', name);
    // --handle、--email 照收、忽略：管理员发出去的接入命令和旧脚本还带着它们
    await as(dev, 'join', server.url, '--invite', engine.store.createInvite(), '--name', name, '--handle', name, '--email', `${name}@example.com`);
    await as(dev, 'link');
    // 装上两个工具的 hook 配置（和真实的成员一样）：暂存进发件箱时，回执才是“hook 会自动补发”
    await as(dev, 'install');
  }
});

after(async () => {
  await server?.close();
  delete process.env.TEAMLINK_HOME;
  rmSync(tmp, { recursive: true, force: true });
});
