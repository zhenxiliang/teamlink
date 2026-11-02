// 服务器入口：`teamlink-server init | add-repo | invite | policy | start`。

import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PROTOCOL } from '../shared/protocol.ts';
import { createApi } from './api.ts';
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
  close: () => Promise<void>;
}

/** 启动时清理一次过期的会话和通知，之后每小时一次。 */
const PRUNE_INTERVAL_MS = 3600_000;

export async function startServer(opts: { engine: Engine; port?: number; host?: string }): Promise<RunningServer> {
  const { engine } = opts;
  const server = createApi(engine);
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
  const addr = server.address() as AddressInfo;
  return {
    url: `http://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`,
    engine,
    close: async () => {
      clearInterval(timer);
      await new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
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
  teamlink-server start [--port 7420] [--host 127.0.0.1] [--data 目录]
                                                           局域网里给队友用时加 --host 0.0.0.0

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
      const s = await startServer({ engine, port, host: values.host });
      const actual = new URL(s.url).port;
      console.log(`teamlink 服务器已启动，监听 ${values.host}:${actual}（协议版本 ${PROTOCOL}）`);
      const hosts = values.host === '0.0.0.0' ? lanAddresses() : [new URL(s.url).hostname];
      for (const h of hosts) console.log(`  队友在团队仓库目录里运行：curl -fsSL http://${h}:${actual}/install.sh | bash -s -- --invite 邀请码 --name 名字`);
      if (values.host === '127.0.0.1' || values.host === 'localhost') console.log('  现在只有本机能连；局域网里给队友用时加 --host 0.0.0.0。');
      break;
    }
  }
}
