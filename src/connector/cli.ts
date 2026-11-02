// 本地命令行：AI 常用的 notify、ask、reply；人用的 setup、join、link、install、inbox、status；
// 以及给 AI 工具调用的 hook（不在帮助里列出）。

import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { generateDeviceKeys } from '../shared/crypto.ts';
import type { Claim, InboxResponse, JoinResponse, RepoInfo, Tool, WhoamiResponse } from '../shared/protocol.ts';
import { CHANGE_TYPES, memberNameError } from '../shared/protocol.ts';
import { call, message, NetworkError } from './client.ts';
import { git, identityFor, loadIdentities, readRepoConfig, REPO_CONFIG, repoRoot, saveIdentity, writeRepoConfig, type Identity, type RepoConfig } from './config.ts';
import { runHook, type HookEvent } from './hook.ts';
import { ensureLauncher, installClaude, installCodex, installedTools, type Installed } from './install.ts';
import { sendNotice } from './notify.ts';
import { latestBatches, RECEIVED_FILE } from './received.ts';
import { status } from './status.ts';

const USAGE = `teamlink —— 团队成员各自的 AI 之间互相传话

AI 常用
  teamlink notify --to <成员名> --summary "<改了什么、为什么>" [--claim 文件#符号:变更类型]
        告诉队友他用得上、又读不到的东西。--to 必填、可写多次；--claim 可选、可写多次，
        变更类型是 added、removed、signature_changed、behavior_changed
  teamlink ask <成员名> "<问题>"            问队友只有他知道的事，回答会自动送回
  teamlink reply <通知号> "<回答>"          回答收到的提问（可以再答一次来更正）

人用
  teamlink setup --server <服务器地址> --invite <邀请码> --name <名字> [--claude]
        一键接入：加入团队、关联当前仓库、装 Codex 的 hook（用 Claude Code 的加 --claude，两个都要写 --codex --claude）
  teamlink join <服务器地址> --invite <邀请码> --name <名字>
  teamlink link [--repo-id <仓库 ID>] [--server <服务器地址>]   在仓库根目录写 ${REPO_CONFIG}（团队共用，可以提交）
  teamlink install [codex|claude]          装 hook 和 AGENTS.md 里的说明；不写就两个都装
  teamlink inbox [--all]                   看还没送到的消息；--all 看最近 7 天的全部（只看，不算送达）
  teamlink status                          检查身份、服务器、hook、node、发件箱`;

const USAGE_OF: Record<string, string> = {
  notify: 'teamlink notify --to <成员名> --summary "<说明>" [--claim 文件#符号:变更类型]',
  ask: 'teamlink ask <成员名> "<问题>"',
  reply: 'teamlink reply <通知号> "<回答>"',
  setup: 'teamlink setup --server <服务器地址> --invite <邀请码> --name <名字> [--claude]',
  join: 'teamlink join <服务器地址> --invite <邀请码> --name <名字>',
  link: 'teamlink link [--repo-id <仓库 ID>] [--server <服务器地址>]',
  install: 'teamlink install [codex|claude]',
  inbox: 'teamlink inbox [--all]',
};

const UNSUPPORTED = '已不支持，用 teamlink install codex 或 teamlink install claude';

/**
 * parseArgs 是严格模式：参数名写错时报中文，其余的错（比如 --summary 的值以 - 开头）照原文报，原文里写了正确的写法；
 * 都附上这个命令的用法。
 */
function parse<T>(cmd: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const option = (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? /'(-[^']*)'/.exec(message(e))?.[1] : undefined;
    throw new Error(`${option ? `不认识的参数 ${option}` : message(e)}\n用法：${USAGE_OF[cmd] ?? `teamlink ${cmd}`}`);
  }
}

interface Ctx {
  root: string;
  cfg: RepoConfig;
  identity: Identity;
}

function context(cwd: string): Ctx {
  const root = repoRoot(cwd);
  if (!root) throw new Error('当前目录不在 git 仓库里');
  const cfg = readRepoConfig(root);
  if (!cfg) throw new Error(`仓库根目录没有 ${REPO_CONFIG}，先运行 teamlink link`);
  const identity = identityFor(cfg.server);
  if (!identity) throw new Error(`本机还没有加入 ${cfg.server}，先运行 teamlink setup`);
  return { root, cfg, identity };
}

/** --claim 文件#符号:变更类型。格式细节（路径、符号名、变更类型）发送前统一用 claimError 再查一遍。 */
export function parseClaim(s: string): Claim {
  const hash = s.indexOf('#');
  const colon = s.lastIndexOf(':');
  if (hash <= 0 || colon <= hash + 1) throw new Error(`--claim 格式应为 文件#符号:变更类型，收到：${s}`);
  const change = s.slice(colon + 1) as Claim['change'];
  if (!CHANGE_TYPES.includes(change)) throw new Error(`变更类型必须是 ${CHANGE_TYPES.join('、')} 之一，收到：${change}`);
  return { file: s.slice(0, hash), symbol: s.slice(hash + 1, colon), change };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 把各种写法的 git 地址规范成 “主机/路径”，用来判断是不是同一个仓库。 */
export function normalizeGitUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u); // git@host:team/repo
  if (scp && !u.includes('://')) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, '')}`;
  try {
    const p = new URL(u);
    if (p.protocol === 'file:') return p.pathname;
    return `${p.hostname.toLowerCase()}${p.pathname}`.replace(/\/+$/, '');
  } catch {
    return u; // 本地路径
  }
}

async function joinServer(server: string, opts: { invite: string; name: string; device?: string }, out: (s: string) => void): Promise<Identity> {
  const why = memberNameError(opts.name);
  if (why) throw new Error(why);
  const keys = generateDeviceKeys();
  const res = await call<JoinResponse>(server, null, 'POST', '/api/v2/join', {
    invite: opts.invite,
    name: opts.name,
    publicKey: keys.publicKey,
    deviceName: opts.device ?? hostname(),
  });
  const identity = { server, memberId: res.memberId, deviceId: res.deviceId, name: opts.name, privateKey: keys.privateKey };
  saveIdentity(identity);
  out(`已以 ${opts.name} 的身份加入 ${server}。私钥只保存在本机。`);
  return identity;
}

/** 在仓库根目录写 .teamlink.json；没指定仓库 ID 时按 origin 地址匹配服务器上登记的仓库。 */
async function linkRepo(root: string, server: string, identity: Identity, repoId: string | undefined, out: (s: string) => void): Promise<string> {
  if (!repoId) {
    const repos = await call<RepoInfo[]>(server, identity, 'GET', '/api/v2/repos');
    if (repos.length === 0) throw new Error('服务器上还没有登记任何仓库，请管理员先运行 teamlink-server add-repo --repo <仓库地址>');
    const origin = git(root, ['remote', 'get-url', 'origin']);
    const match = (origin ? repos.find((r) => normalizeGitUrl(r.url) === normalizeGitUrl(origin)) : undefined) ?? (repos.length === 1 ? repos[0] : undefined);
    if (!match) throw new Error(`服务器上找不到和 origin（${origin ?? '未设置'}）对应的仓库，请用 --repo-id 指定：\n${repos.map((r) => `  ${r.id}  ${r.url}`).join('\n')}`);
    repoId = match.id;
  }
  const cur = readRepoConfig(root);
  if (cur?.server !== server.replace(/\/+$/, '') || cur?.repoId !== repoId) writeRepoConfig(root, { ...(cur ?? {}), server, repoId });
  out(`已关联仓库 ${repoId}（${REPO_CONFIG}，团队共用，可以提交）。`);
  return repoId;
}

const CODEX_TRUST = '在 Codex 里运行 /hooks，信任 teamlink 的 5 条 hook（SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd）后才会生效。';

function installed(label: string, r: Installed): string {
  return [`${label}：${r.changed ? '已写入' : '已是最新，没有改动'} ${r.path}`, ...r.notes.map((n) => `  注意：${n}`)].join('\n');
}

export async function runCli(argv: string[], cwd = process.cwd(), print: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const out = (s: string) => print(s.endsWith('\n') ? s : `${s}\n`);

  switch (cmd) {
    case 'notify': {
      const { values } = parse(cmd, () =>
        parseArgs({
          args: rest,
          options: {
            to: { type: 'string', multiple: true, default: [] },
            summary: { type: 'string', default: '' },
            claim: { type: 'string', multiple: true, default: [] },
            // 照收、忽略：旧的 AGENTS.md 让 AI 写 --type interface_change 这类
            type: { type: 'string' },
          },
        }),
      );
      const { root, cfg, identity } = context(cwd);
      out(await sendNotice(root, cfg, identity, { type: 'message', summary: values.summary, claims: values.claim.map(parseClaim), to: values.to }));
      return 0;
    }

    case 'ask':
    case 'reply': {
      const [target, ...words] = rest;
      const text = words.join(' ').trim();
      if (!target || !text) throw new Error(`用法：${USAGE_OF[cmd]}`);
      const { root, cfg, identity } = context(cwd);
      out(
        await sendNotice(
          root,
          cfg,
          identity,
          cmd === 'ask' ? { type: 'question', summary: text, claims: [], to: [target] } : { type: 'answer', summary: text, claims: [], to: [], replyTo: target },
        ),
      );
      return 0;
    }

    case 'join': {
      const { values, positionals } = parse(cmd, () =>
        parseArgs({
          args: rest,
          allowPositionals: true,
          // --email、--handle 照收、忽略：管理员发出去的一键接入命令和旧脚本还带着它们
          options: { invite: { type: 'string' }, name: { type: 'string' }, device: { type: 'string' }, email: { type: 'string' }, handle: { type: 'string' } },
        }),
      );
      const server = positionals[0]?.replace(/\/+$/, '');
      if (!server || !values.invite || !values.name) throw new Error(`用法：${USAGE_OF.join}`);
      await joinServer(server, { invite: values.invite, name: values.name, device: values.device }, out);
      out('下一步：进入仓库目录，运行 teamlink link，再运行 teamlink install。');
      return 0;
    }

    case 'link': {
      const { values } = parse(cmd, () => parseArgs({ args: rest, options: { 'repo-id': { type: 'string' }, server: { type: 'string' } } }));
      const root = repoRoot(cwd);
      if (!root) throw new Error('当前目录不在 git 仓库里');
      const servers = Object.keys(loadIdentities());
      const server = values.server?.replace(/\/+$/, '') ?? (servers.length === 1 ? servers[0] : undefined);
      if (!server) throw new Error(servers.length === 0 ? '先运行 teamlink join' : `本机加入了多个服务器，请用 --server 指定：${servers.join('、')}`);
      const identity = identityFor(server);
      if (!identity) throw new Error(`本机还没有加入 ${server}，先运行 teamlink join`);
      await linkRepo(root, server, identity, values['repo-id'], out);
      return 0;
    }

    case 'setup': {
      // 一键接入（install.sh 最后一步调用的也是它）：写启动脚本 → 加入团队 → 关联当前仓库 → 安装 hook。重复运行没有副作用。
      // 启动脚本最先写：后面哪一步出错，PATH 里的 teamlink 也已经能用
      ensureLauncher();
      const { values } = parse(cmd, () =>
        parseArgs({
          args: rest,
          options: {
            server: { type: 'string' },
            invite: { type: 'string' },
            name: { type: 'string' },
            device: { type: 'string' },
            'repo-id': { type: 'string' },
            codex: { type: 'boolean' },
            claude: { type: 'boolean' },
            mcp: { type: 'boolean' },
            email: { type: 'string' },
            handle: { type: 'string' },
          },
        }),
      );
      if (values.mcp) throw new Error(UNSUPPORTED);
      const server = values.server?.replace(/\/+$/, '');
      if (!server) throw new Error(`用法：${USAGE_OF.setup}`);
      let identity = identityFor(server);
      if (!identity) {
        if (!values.invite || !values.name) {
          out(`teamlink 已安装。加入团队需要管理员给的邀请码，在团队仓库目录里运行：\n  teamlink setup --server ${server} --invite <邀请码> --name <你的名字>`);
          return 0;
        }
        identity = await joinServer(server, { invite: values.invite, name: values.name, device: values.device }, out);
      } else {
        out(`本机已经以 ${identity.name} 的身份加入过 ${server}。`);
      }
      const root = repoRoot(cwd);
      if (!root) {
        out(`当前目录不是 git 仓库。进入团队仓库目录后再运行一次：\n  teamlink setup --server ${server}`);
        return 0;
      }
      await linkRepo(root, server, identity, values['repo-id'], out);
      // 这个工作区已经装过的工具一起更新（重跑这一条就是升级）；什么都没装过、也没写工具时装 Codex
      const have = installedTools(root);
      const claude = values.claude || have.includes('claude');
      const codex = values.codex || have.includes('codex') || !claude;
      const codexHooks = codex ? installCodex(root) : null;
      if (codexHooks) out(installed('Codex', codexHooks));
      if (claude) out(installed('Claude Code', installClaude(root)));
      const who = await call<WhoamiResponse>(server, identity, 'GET', '/api/v2/whoami');
      out(`服务器连接正常，身份 ${who.member.name}。`);
      if (git(root, ['status', '--porcelain', '--', REPO_CONFIG, 'AGENTS.md', 'CLAUDE.md'])) {
        out(`\n${REPO_CONFIG} 和 AGENTS.md 有改动，请提交一次（全队只需要一个人提交）。`);
      }
      // Codex 的 hook 配置真的改了才要去信任（没改动时，之前的信任照样有效）
      if (codexHooks?.changed) {
        out(
          [
            '',
            '最后一步，在 Codex 里完成：',
            '  1. 在这个仓库目录里打开 Codex。第一次会问是否信任这个目录，选信任。',
            '  2. 运行 /hooks，信任 teamlink 的 5 条 hook（SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd）。',
            '之后队友发给你的消息会在 Codex 操作时自动转给它；要告诉队友什么、问队友什么，Codex 会按 AGENTS.md 用 teamlink notify、ask。',
          ].join('\n'),
        );
      }
      return 0;
    }

    case 'install': {
      const { values, positionals } = parse(cmd, () =>
        parseArgs({
          args: rest,
          allowPositionals: true,
          // 旧写法 --claude、--codex 照收；--generic、--mcp 两种已经删掉了
          options: { claude: { type: 'boolean' }, codex: { type: 'boolean' }, generic: { type: 'boolean' }, mcp: { type: 'boolean' } },
        }),
      );
      if (values.generic || values.mcp || positionals.some((p) => p === 'generic' || p === 'mcp')) throw new Error(UNSUPPORTED);
      const unknown = positionals.filter((p) => p !== 'claude' && p !== 'codex');
      if (unknown.length > 0) throw new Error(`不认识的工具：${unknown.join('、')}\n用法：${USAGE_OF.install}`);
      const root = repoRoot(cwd);
      if (!root) throw new Error('当前目录不在 git 仓库里');
      const claude = values.claude || positionals.includes('claude');
      const codex = values.codex || positionals.includes('codex');
      if (claude || !codex) out(installed('Claude Code', installClaude(root)));
      if (codex || !claude) {
        const r = installCodex(root);
        out(installed('Codex', r));
        if (r.changed) out(`  ${CODEX_TRUST}`);
      }
      out(`启动脚本：${ensureLauncher()}（hook 命令和 AI 用的 teamlink 命令都走它）`);
      if (git(root, ['status', '--porcelain', '--', 'AGENTS.md', 'CLAUDE.md'])) out('AGENTS.md 里加了一段使用说明，建议提交，让团队所有 AI 都能看到。');
      return 0;
    }

    case 'hook': {
      // 永远以 0 退出、不报错：旧版本装的 hook 命令也走这里，出了问题也不能打断 AI
      try {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: false, options: { tool: { type: 'string' } } });
        const event = String(positionals[0] ?? '') as HookEvent;
        const tool = (typeof values.tool === 'string' ? values.tool : 'claude') as Tool;
        let emitted = false;
        const text = await runHook(event, tool, await readStdin(), cwd, (s) => {
          emitted = true;
          print(s);
        });
        if (text && !emitted) print(text);
      } catch {
        // runHook 自己会记错误日志
      }
      return 0;
    }

    case 'inbox': {
      const { values } = parse(cmd, () => parseArgs({ args: rest, options: { all: { type: 'boolean' } } }));
      const { root, cfg, identity } = context(cwd);
      const q = new URLSearchParams({ repoId: cfg.repoId, ...(values.all ? { all: '1' } : {}) });
      try {
        out((await call<InboxResponse>(cfg.server, identity, 'GET', `/api/v2/inbox?${q}`, undefined, 8000)).text);
      } catch (e) {
        if (!(e instanceof NetworkError)) throw e;
        const batches = latestBatches(root, 2);
        out(`连不上服务器（在 AI 工具的沙箱里这很正常）。消息由 hook 自动送到，已送到的全文在 ${RECEIVED_FILE}。`);
        out(batches.length > 0 ? `以下是最新的 ${batches.length} 批：\n\n${batches.join('\n\n---\n\n')}` : '还没有收到过消息。');
      }
      return 0;
    }

    case 'status':
      await status(cwd, out);
      return 0;

    default:
      out(USAGE);
      return cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' ? 1 : 0;
  }
}
