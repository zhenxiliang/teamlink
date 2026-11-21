// HTTP 接口。除了健康检查、安装脚本、连接器包和加入团队，所有请求都要用设备私钥签名，并带协议头。
// 这一版的连接器只用 /api/v2/ 下的路径：旧服务器没有这些路径，验签之前就回 404，不会记送达、建成员。
// 旧路径只给没带协议头（或版本更低）的旧连接器：不执行处理逻辑、不记送达，按接口给出升级提示；带着协议头来的返回 404。

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { verifyRequest } from '../shared/crypto.ts';
import { DEVICE_UNKNOWN, FEATURES_BASIS, FEATURES_HEADER, PROTOCOL, PROTOCOL_HEADER, TOOLS, type LegacyInboxResponse, type Tool } from '../shared/protocol.ts';
import type { DeviceRow, MemberRow } from './db.ts';
import { ApiError, type Engine } from './engine.ts';

const MAX_BODY = 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60_000;

interface Ctx {
  member: MemberRow;
  device: DeviceRow;
  body: Record<string, unknown>;
  query: URLSearchParams;
  /** 这个连接器认不认得 reply --basis 和 teamlink fact（按它报的功能版本）：不认得的，注入里按 0.2 的写法提示。 */
  basisHints: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, '请求体太大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 每个响应都带协议版本头，连接器据此知道服务器是哪一版。 */
function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', [PROTOCOL_HEADER]: String(PROTOCOL) });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const str = (v: unknown, name: string): string => {
  if (v === undefined || v === null || v === '') throw new ApiError(400, `缺少 ${name}`);
  if (typeof v !== 'string') throw new ApiError(400, `${name} 必须是字符串`);
  return v;
};

const optStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const tool = (v: unknown): Tool => {
  if (!TOOLS.includes(v as Tool)) throw new ApiError(400, `tool 必须是 ${TOOLS.join(' / ')}`);
  return v as Tool;
};

/** 会话号来自 AI 工具（一般是 UUID），会存成会话表的主键。 */
const sessionId = (v: unknown): string => {
  const s = str(v, 'sessionId');
  if (s.length > 256) throw new ApiError(400, 'sessionId 太长');
  return s;
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/** 送达确认：数组里的通知号；没带这个字段（旧连接器）返回 undefined，服务器据此不等确认。 */
const acksOf = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 64) : undefined);

const INSTALL_SCRIPT = fileURLToPath(new URL('./install.sh', import.meta.url));
const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** 安装脚本里的服务器地址来自 Host 头，会写进 shell 脚本，所以只接受主机名或 IP 加端口。 */
const SAFE_HOST = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?$/;

/** 请求是不是走 HTTPS 来的：服务器自己开着 HTTPS，或者经过 HTTPS 反向代理。这个头只会让地址从 http 变成 https，伪造了也没有好处。 */
const httpsVia = (req: IncomingMessage) => (req.socket as Partial<TLSSocket>).encrypted === true || req.headers['x-forwarded-proto'] === 'https';

/** 这台服务器在请求方眼里的地址；Host 不合法时返回 null。 */
function serverAddress(req: IncomingMessage): string | null {
  const host = req.headers.host ?? '';
  return SAFE_HOST.test(host) ? `${httpsVia(req) ? 'https' : 'http'}://${host}` : null;
}

/** 升级时让用户在仓库目录重跑的接入命令。 */
const installCommand = (req: IncomingMessage) => `curl -fsSL ${serverAddress(req) ?? '<服务器地址>'}/install.sh | bash`;

/** 开工、收尾检查和 426 共用的升级提示。 */
function upgradeText(req: IncomingMessage): string {
  return `本机的 teamlink 连接器太旧，消息先在服务器上排队。请你的用户在仓库目录运行 ${installCommand(req)} 升级；用 Codex 的，升级后在 /hooks 里重新信任一次。`;
}

/**
 * 旧连接器的请求，按接口分别处理：
 * 开工、收尾检查返回旧结构，旧版 renderInbox 能原样渲染出升级提示；每次操作的 activity 返回空的旧结构，免得每次都插一遍；
 * 发消息返回 429（旧发件箱会留着文件，升级后由新连接器补发；旧命令行把正文打给 AI，所以正文要说清楚没发出、升级后重发）；其余接口返回 426。
 */
function legacy(req: IncomingMessage, res: ServerResponse, route: string) {
  const text = upgradeText(req);
  switch (route) {
    case 'POST /api/sessions/start':
    case 'POST /api/sessions/stop-check':
      return send(res, 200, { notices: [], retractions: [], overflow: [{ id: 'teamlink', title: text }] } satisfies LegacyInboxResponse);
    case 'POST /api/activity':
      return send(res, 200, { notices: [], retractions: [], overflow: [] } satisfies LegacyInboxResponse);
    case 'POST /api/notices':
      return send(res, 429, { error: `这条消息没有发出：本机的 teamlink 连接器太旧。请你的用户在仓库目录运行 ${installCommand(req)} 升级，升级后重发这条。` });
    default:
      return send(res, 426, { error: text });
  }
}

/** HTTPS 用的证书和私钥（PEM 文本）。 */
export interface TlsMaterial {
  cert: string;
  key: string;
}

/** 给了证书就开 HTTPS（Node 自带的 https，同一套处理逻辑），没给就是 HTTP。 */
export function createApi(engine: Engine, tls?: TlsMaterial): Server {
  const store = engine.store;
  // 防重放：签名在有效期内只能用一次
  const seen = new Map<string, number>();

  function authenticate(req: IncomingMessage, path: string, raw: string): { member: MemberRow; device: DeviceRow } {
    const deviceId = req.headers['x-tl-device'];
    const ts = req.headers['x-tl-ts'];
    const sig = req.headers['x-tl-sig'];
    if (typeof deviceId !== 'string' || typeof ts !== 'string' || typeof sig !== 'string') throw new ApiError(401, '缺少签名');
    // 只接受纯数字：别的写法转成 NaN，下面的比较永远不成立，等于不查过期
    if (!/^\d{1,15}$/.test(ts) || Math.abs(store.clock() - Number(ts)) > CLOCK_SKEW_MS) throw new ApiError(401, '签名已过期，检查本机时间');
    // 只接受标准写法的 base64：Buffer 解码时会忽略空白和多余的补位，换种写法就能绕过下面的防重放
    if (Buffer.from(sig, 'base64').toString('base64') !== sig) throw new ApiError(401, '签名格式不对');
    const device = store.device(deviceId);
    // 设备被吊销、成员被移出以后走到这里：说清楚，不然只看到“签名无效”，不知道要重新加入
    if (!device) throw new ApiError(401, `${DEVICE_UNKNOWN}：找管理员要一个邀请码，重新运行接入命令`);
    if (!verifyRequest(device.public_key, req.method ?? 'GET', path, ts, raw, sig)) throw new ApiError(401, '签名无效');
    const now = store.clock();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (seen.has(sig)) throw new ApiError(401, '重复的请求');
    seen.set(sig, now + 2 * CLOCK_SKEW_MS);
    const member = store.member(device.member_id);
    if (!member) throw new ApiError(401, '成员不存在');
    return { member, device };
  }

  /** 送达类请求的会话标识，和连接器带来的送达确认。 */
  const sessionOf = (body: Record<string, unknown>) => ({
    repoId: str(body.repoId, 'repoId'),
    tool: tool(body.tool),
    sessionId: sessionId(body.sessionId),
    acks: acksOf(body.acks),
  });

  /** 发消息、取回答时带的会话（可选）：没带、工具不认识（旧版的 generic）就返回 null。 */
  const sessionKeyOf = (body: Record<string, unknown>): string | null => {
    const sid = optStr(body.sessionId);
    return TOOLS.includes(body.tool as Tool) && sid && sid.length <= 256 ? `${body.tool as Tool}:${sid}` : null;
  };

  type Handler = (ctx: Ctx) => unknown;
  const routes: Record<string, Handler> = {
    'GET /api/v2/whoami': ({ member }) => ({ member: { id: member.id, name: member.name } }),

    'GET /api/v2/repos': () => store.repos().map(({ id, url }) => ({ id, url })),

    'POST /api/v2/sessions/start': ({ member, body, basisHints }) => engine.deliver(member, { ...sessionOf(body), kind: 'start', basisHints }),

    'POST /api/v2/activity': ({ member, body, basisHints }) => engine.deliver(member, { ...sessionOf(body), kind: 'activity', basisHints }),

    'POST /api/v2/sessions/stop-check': ({ member, body, basisHints }) => engine.deliver(member, { ...sessionOf(body), kind: 'stop', basisHints }),

    'POST /api/v2/acks': ({ member, body }) => {
      engine.ack(member, acksOf(body.acks));
      return { ok: true };
    },

    'POST /api/v2/sessions/end': ({ member, body }) => {
      engine.endSession(member, tool(body.tool), sessionId(body.sessionId), acksOf(body.acks));
      return { ok: true };
    },

    // 旧发件箱里的 payload 也走这里：branch、base、head 这些多出来的字段不读
    'POST /api/v2/notices': ({ member, body }) =>
      engine.send(member, {
        repoId: str(body.repoId, 'repoId'),
        // 会话用来限流、把回答留给提问的会话：没带就按成员限流
        sessionKey: sessionKeyOf(body),
        type: body.type,
        summary: body.summary,
        claims: body.claims,
        to: strings(body.to),
        replyTo: optStr(body.replyTo),
        clientId: optStr(body.clientId),
        via: body.via,
        basis: body.basis,
      }),

    'POST /api/v2/answers/take': ({ member, body, basisHints }) =>
      engine.takeAnswers(member, { repoId: str(body.repoId, 'repoId'), question: str(body.question, 'question'), basisHints }),

    'GET /api/v2/notice': ({ member, query }) => engine.lookup(member, str(query.get('repoId'), 'repoId'), str(query.get('id'), 'id')),

    'GET /api/v2/inbox': ({ member, query, basisHints }) => engine.inbox(member, str(query.get('repoId'), 'repoId'), ['1', 'true'].includes(query.get('all') ?? ''), basisHints),
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // 请求行里的地址解析不了（比如 GET //[）：直接 400。不能抛到 try 外面，async 回调里没接住的异常会让进程退出
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return send(res, 400, { error: '请求地址不合法' });
    }
    try {
      const path = url.pathname + url.search;
      const raw = req.method === 'GET' ? '' : await readBody(req);

      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, protocol: PROTOCOL });
      if (req.method === 'GET' && url.pathname === '/install.sh') {
        const server = serverAddress(req);
        if (!server) throw new ApiError(400, 'Host 不合法');
        // 在 HTTPS 反向代理后面时，安装脚本里也写 https，不降级
        const script = readFileSync(INSTALL_SCRIPT, 'utf8').replaceAll('__TEAMLINK_SERVER__', server);
        return send(res, 200, script, 'text/x-shellscript; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/download/teamlink.tar.gz') {
        // 本地连接器只需要 bin、src 和 package.json，不需要任何 npm 依赖
        const tar = spawn('tar', ['-czf', '-', '--exclude', '.DS_Store', '-C', APP_ROOT, 'bin', 'src', 'package.json'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, COPYFILE_DISABLE: '1' },
        });
        res.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'no-store', [PROTOCOL_HEADER]: String(PROTOCOL) });
        tar.stdout.pipe(res);
        tar.on('error', () => res.destroy());
        return;
      }
      const current = Number(req.headers[PROTOCOL_HEADER]) >= PROTOCOL;
      // 带协议头的是这一版的连接器，它只用 /api/v2/：旧路径带着协议头来，说明地址写错了
      if (current && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/v2/')) throw new ApiError(404, '没有这个接口');
      // /api/join 只剩没带协议头的旧连接器会来：照常加入
      if (req.method === 'POST' && (url.pathname === '/api/v2/join' || url.pathname === '/api/join')) {
        const parsed = JSON.parse(raw || '{}') as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, '请求体必须是 JSON 对象');
        const body = parsed as Record<string, unknown>;
        return send(
          res,
          200,
          engine.join({ invite: str(body.invite, 'invite'), name: str(body.name, 'name'), publicKey: str(body.publicKey, 'publicKey'), deviceName: optStr(body.deviceName) }),
        );
      }
      if (!url.pathname.startsWith('/api/')) throw new ApiError(404, '没有这个接口');

      const { member, device } = authenticate(req, path, raw);
      const route = `${req.method} ${url.pathname}`;
      if (!current) return legacy(req, res, route);
      const handler = routes[route];
      if (!handler) throw new ApiError(404, '没有这个接口');
      const body = raw ? (JSON.parse(raw) as unknown) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, '请求体必须是 JSON 对象');
      // 送达类接口在这里同步地选条目、记送达，然后才写响应：中间没有 await
      // 功能版本头只影响注入里的命令写法（不在签名里也无妨）：没带、不是数字的都当 0.2
      const basisHints = Number(req.headers[FEATURES_HEADER]) >= FEATURES_BASIS;
      send(res, 200, handler({ member, device, body: body as Record<string, unknown>, query: url.searchParams, basisHints }));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (status === 500) engine.event('server_error', { path: url.pathname, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      if (res.headersSent) return void res.destroy();
      send(res, status, { error: e instanceof SyntaxError ? `请求体不是合法的 JSON：${e.message}` : e instanceof Error ? e.message : String(e) });
    }
  };
  return tls ? createTlsServer({ cert: tls.cert, key: tls.key }, handle) : createServer(handle);
}
