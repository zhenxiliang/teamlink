// 服务器入口：`teamlink-server init | add-repo | invite | policy | start`。

import { X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { Server as TlsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PROTOCOL } from '../shared/protocol.ts';
import { createApi, type TlsMaterial } from './api.ts';
import { Store } from './db.ts';
import { DEFAULT_CONFIG, Engine, type EngineConfig } from './engine.ts';
import { loadPolicy, savePolicy } from './policy.ts';

/** 打开数据目录里的库（旧结构会先迁移，失败时抛错）。 */
export function openEngine(dataDir: string, overrides: Partial<Omit<EngineConfig, 'dataDir'>> = {}): Engine {
  mkdirSync(dataDir, { recursive: true });
  const config: EngineConfig = { ...DEFAULT_CONFIG, ...overrides, dataDir };
  const store = new Store(join(dataDir, 'teamlink.db'), { log: config.log });
  return new Engine(store, config);
}

export interface RunningServer {
  url: string;
  engine: Engine;
  /** 立刻关：进行中的请求直接断开（测试用）。 */
  close: () => Promise<void>;
  /** 不再接新请求，等进行中的请求答完。 */
  drain: () => Promise<void>;
}

/** 启动时清理一次过期的会话和通知，之后每小时一次。 */
const PRUNE_INTERVAL_MS = 3600_000;
/** 证书文件每小时看一次：续期后换了内容就重新加载，不用重启服务器。 */
const CERT_RELOAD_MS = 3600_000;
/** 收到停止信号后，最多等这么久让进行中的请求答完。 */
const STOP_GRACE_MS = 5000;

/** HTTPS 的证书和私钥文件（PEM）。 */
export interface TlsFiles {
  cert: string;
  key: string;
}

function readTls(files: TlsFiles): TlsMaterial {
  const read = (path: string, what: string) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(`读不了${what}文件 ${path}：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const tls = { cert: read(files.cert, '证书'), key: read(files.key, '私钥') };
  try {
    new X509Certificate(tls.cert);
  } catch {
    throw new Error(`${files.cert} 不是 PEM 格式的证书`);
  }
  return tls;
}

/** 证书上写的域名（不含通配符的），打印接入命令时用。 */
export function certNames(certPem: string): string[] {
  try {
    const san = new X509Certificate(certPem).subjectAltName ?? '';
    return san
      .split(',')
      .map((s) => /^\s*DNS:(.+)$/.exec(s)?.[1]?.trim() ?? '')
      .filter((n) => n && !n.includes('*'));
  } catch {
    return [];
  }
}

export async function startServer(opts: { engine: Engine; port?: number; host?: string; tls?: TlsFiles }): Promise<RunningServer> {
  const { engine } = opts;
  let tls = opts.tls ? readTls(opts.tls) : undefined;
  const server = createApi(engine, tls);
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 7420, opts.host ?? '127.0.0.1', () => {
      server.off('error', fail);
      ok();
    });
  });
  const prune = () => {
    try {
      const r = engine.prune();
      if (r.sessions > 0 || r.notices > 0) engine.event('pruned', r);
    } catch (e) {
      engine.event('prune_failed', { error: String(e) });
    }
  };
  prune();
  const timer = setInterval(prune, PRUNE_INTERVAL_MS);
  timer.unref();
  // 证书续期：文件内容变了就换上新的；读不了、格式不对时继续用旧的，记一行
  const reload = () => {
    if (!opts.tls || !tls) return;
    try {
      const next = readTls(opts.tls);
      if (next.cert === tls.cert && next.key === tls.key) return;
      (server as TlsServer).setSecureContext(next);
      tls = next;
      engine.event('cert_reloaded', { cert: opts.tls.cert });
    } catch (e) {
      engine.event('cert_reload_failed', { error: String(e) });
    }
  };
  const certTimer = setInterval(reload, CERT_RELOAD_MS);
  certTimer.unref();
  // 停止时：进行中的请求答完就断开它自己的连接。不然连接按 keep-alive 留着，客户端还能在上面发新请求，drain 也一直等不完。
  // 不能用 closeIdleConnections()，server.close() 也要等一等再调（它会顺带调一次）：响应已经 end()、数据还没写完的连接，
  // Node 也当成空闲的直接断开，读得慢的客户端会收到半截响应。所以先等这样的响应写完
  let draining = false;
  let closeWhenFlushed: (() => void) | null = null;
  /** 还没答完的响应 → 它所在的连接。 */
  const open = new Map<ServerResponse, Socket>();
  server.prependListener('request', (req, res) => {
    open.set(res, req.socket);
    if (draining) res.setHeader('connection', 'close');
    res.once('close', () => {
      open.delete(res);
      if (!draining) return;
      // 同一条连接上还有请求没答完（客户端连着发了几个）：等最后一个答完再断
      if (![...open.values()].includes(req.socket)) req.socket.end();
      closeWhenFlushed?.();
    });
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `${tls ? 'https' : 'http'}://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`,
    engine,
    close: async () => {
      clearInterval(timer);
      clearInterval(certTimer);
      await new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      });
    },
    drain: async () => {
      clearInterval(timer);
      clearInterval(certTimer);
      draining = true;
      await new Promise<void>((ok) => {
        closeWhenFlushed = () => {
          if ([...open.keys()].some((res) => res.writableEnded && !res.writableFinished)) return;
          closeWhenFlushed = null;
          server.close(() => ok());
        };
        closeWhenFlushed();
      });
    },
  };
}

/** 监听 0.0.0.0 时，列出队友能用的局域网地址。 */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => (a as { address: string }).address);
}

const USAGE = `用法：
  teamlink-server init --repo <git 地址> [--data 目录]       登记仓库，打印仓库 ID 和第一个邀请码
  teamlink-server add-repo --repo <git 地址> [--data 目录]   再登记一个仓库（只登记，不 clone）
  teamlink-server invite [--count 5] [--data 目录]          生成邀请码（每人一个，用过就失效）
  teamlink-server policy [--allow-domain 域名] [--remove-domain 域名] [--data 目录]
                                                           查看或修改消息里允许出现的链接域名；不带参数时打印当前名单
  teamlink-server start [--port 7420] [--host 127.0.0.1] [--data 目录] [--cert 证书.pem --key 私钥.pem]
                                                           局域网里给队友用时加 --host 0.0.0.0；
                                                           给了 --cert 和 --key 就开 HTTPS（跨公网时用），证书续期后自动重新加载

仓库地址也可以直接写在命令后面：teamlink-server init <git 地址>。数据目录默认是 ./.teamlink-server。`;

/** --allow-domain 可以写多次，也可以用逗号分隔。 */
function domains(values: string[] | undefined): string[] {
  const out = (values ?? []).flatMap((v) => v.split(',')).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const bad = out.filter((d) => !/^[a-z0-9.-]+$/.test(d));
  if (bad.length > 0) throw new Error(`域名格式不对：${bad.join('、')}（只写域名，比如 example.com，不带 https:// 和路径）`);
  return out;
}

export async function runServerCli(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        data: { type: 'string', default: '.teamlink-server' },
        repo: { type: 'string' },
        // 以下三个照收、忽略：已经部署的启动脚本和 crontab 循环还带着它们
        branch: { type: 'string' },
        poll: { type: 'string' },
        'no-dashboard-auth': { type: 'boolean' },
        port: { type: 'string', default: '7420' },
        host: { type: 'string', default: '127.0.0.1' },
        'allow-domain': { type: 'string', multiple: true },
        'remove-domain': { type: 'string', multiple: true },
        cert: { type: 'string' },
        key: { type: 'string' },
        count: { type: 'string', default: '1' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    const option = e instanceof Error ? /'(-[^']*)'/.exec(e.message)?.[1] : undefined;
    throw new Error(`${option ? `不认识的参数 ${option}` : e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(USAGE);
    return;
  }
  if (!['init', 'add-repo', 'invite', 'policy', 'start'].includes(cmd)) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  if (values.poll !== undefined) console.log('已忽略 --poll：服务器不再同步仓库。');
  if (values['no-dashboard-auth']) console.log('已忽略 --no-dashboard-auth：看板已经删掉了。');
  const dataDir = resolve(values.data);
  const engine = openEngine(dataDir);
  switch (cmd) {
    case 'init':
    case 'add-repo': {
      const url = (values.repo ?? positionals[1] ?? '').trim();
      if (!url) throw new Error(`需要仓库地址：teamlink-server ${cmd} --repo <git 地址>`);
      const existed = engine.store.repoByUrl(url);
      const repo = engine.addRepo(url);
      console.log(existed ? `仓库已经登记过：${repo.url}` : `已登记仓库 ${repo.url}`);
      console.log(`  仓库 ID：${repo.id}`);
      if (cmd === 'init') console.log(`  邀请码：${engine.store.createInvite()}`);
      break;
    }
    case 'invite': {
      const count = Number(values.count);
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('--count 要是 1 到 1000 之间的整数');
      for (let i = 0; i < count; i++) console.log(engine.store.createInvite());
      break;
    }
    case 'policy': {
      const p = loadPolicy(dataDir);
      const add = domains(values['allow-domain']);
      const remove = domains(values['remove-domain']);
      const changed = add.length > 0 || remove.length > 0;
      if (changed) {
        p.allowDomains = [...new Set([...p.allowDomains, ...add])].filter((d) => !remove.includes(d));
        savePolicy(dataDir, p);
      }
      console.log(`消息里的链接只允许指向这些域名（含子域名）：${p.allowDomains.join('、') || '（无）'}`);
      if (changed) console.log('已保存，下一条消息起按新名单审核。');
      break;
    }
    case 'start': {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 要是 0 到 65535 之间的整数');
      if (Boolean(values.cert) !== Boolean(values.key)) throw new Error('--cert 和 --key 要一起给：证书文件和它的私钥文件（PEM 格式）');
      const tls = values.cert && values.key ? { cert: resolve(values.cert), key: resolve(values.key) } : undefined;
      const s = await startServer({ engine, port, host: values.host, tls });
      // 收到停止信号：不再接新请求，等手上的请求答完再退出；5 秒还没答完就直接退
      let stopping = false;
      const stop = (signal: NodeJS.Signals) => {
        if (stopping) return;
        stopping = true;
        engine.event('stopping', { signal });
        setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
        void s.drain().then(() => process.exit(0));
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
      const actual = new URL(s.url).port;
      console.log(`teamlink 服务器已启动，监听 ${values.host}:${actual}（协议版本 ${PROTOCOL}${tls ? '，HTTPS' : ''}）`);
      if (tls) {
        // 证书是签给域名的：接入命令里要写证书上的域名，写 IP 的话 curl 和连接器都会因为证书对不上而拒绝
        const names = certNames(readFileSync(tls.cert, 'utf8'));
        for (const h of names.length > 0 ? names : ['<证书上的域名>']) {
          console.log(`  队友在团队仓库目录里运行：curl -fsSL https://${h}${actual === '443' ? '' : `:${actual}`}/install.sh | bash -s -- --invite 邀请码 --name 名字`);
        }
        console.log('  证书要是队友的电脑信任的（Let’s Encrypt、tailscale cert 这类）；自签证书要在每台电脑上设 NODE_EXTRA_CA_CERTS。');
      } else {
        const hosts = values.host === '0.0.0.0' ? lanAddresses() : [new URL(s.url).hostname];
        for (const h of hosts) console.log(`  队友在团队仓库目录里运行：curl -fsSL http://${h}:${actual}/install.sh | bash -s -- --invite 邀请码 --name 名字`);
      }
      if (values.host === '127.0.0.1' || values.host === 'localhost') console.log('  现在只有本机能连；局域网里给队友用时加 --host 0.0.0.0。');
      break;
    }
  }
}
