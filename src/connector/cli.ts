// 本地命令行：AI 常用的 notify、ask、reply；人用的 setup、join、link、install、inbox、status；
// 以及给 AI 工具调用的 hook（不在帮助里列出）。

import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { generateDeviceKeys } from '../shared/crypto.ts';
import type { Basis, Claim, InboxResponse, JoinResponse, NoticeItem, RepoInfo, Tool, WhoamiResponse } from '../shared/protocol.ts';
import { BASIS_LABEL, BASES, CHANGE_TYPES, DEVICE_UNKNOWN, memberNameError, parseBasis } from '../shared/protocol.ts';
import { call, ClientError, message, NetworkError } from './client.ts';
import { git, identityFor, loadIdentities, readRepoConfig, REPO_CONFIG, repoRoot, saveIdentity, writeRepoConfig, type Identity, type RepoConfig } from './config.ts';
import { factLine, FACTS_DIR, recordFact, relatedFacts, searchFacts } from './facts.ts';
import { runHook, type HookEvent } from './hook.ts';
import { ensureLauncher, installClaude, installCodex, installedTools, type Installed } from './install.ts';
import { confirmAnswers, send, sendNotice, WAIT_DEFAULT_S, WAIT_MAX_S, waitForAnswer } from './notify.ts';
import { originOf } from './origin.ts';
import { findItem, latestBatches, NOTICES_FILE, RECEIVED_FILE } from './received.ts';
import { status } from './status.ts';

const USAGE = `teamlink —— 团队成员各自的 AI 之间互相传话

AI 常用
  teamlink notify --to <成员名> --summary "<改了什么、为什么>" [--claim 文件#符号:变更类型]
        告诉队友他用得上、又读不到的东西。--to 必填、可写多次；--claim 可选、可写多次，
        变更类型是 added、removed、signature_changed、behavior_changed
  teamlink ask <成员名> "<问题>" [--wait]   问队友只有他知道的事，回答会自动送回。--wait：对方在线时就在这条命令里等回答
        （默认最多 ${WAIT_DEFAULT_S} 秒，--wait=300 改成 300 秒），到了直接打印；没等到的照常自动送回。
        问的就是某条团队事实的主题时先不发、把它打印出来；它答不了你的问题时加 --anyway 再发
  teamlink reply <通知号> "<回答>" --basis 本人确认|查证过|推测
        回答收到的提问（可以再答一次来更正）。--basis 是依据：本人确认＝你的用户亲口说的，
        查证过＝你在本机或系统里查到的，推测＝你猜的；AI 回答必须写，本人在终端里回答可以不写
  teamlink facts [关键词…]                 查团队事实（${FACTS_DIR}/）：问队友之前先查，有了就不用问
  teamlink fact "<主题>" ["<事实>"] [--from <通知号>] [--basis 本人确认|查证过]
        把长期有效的事实（限额、口径、错误码、环境约定）记进团队事实，跟着改动一起提交。--from：从哪条回答或消息记，
        事实不写就用它的原文，依据和来源都以它为准（推测的回答不能当出处）。--basis：你自己确认或查证过的才写，
        不带 --from、或者那条消息没写依据时用。同一个主题再记一次就是更正。推测不记，临时进度和代码里读得到的不记

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
  ask: 'teamlink ask <成员名> "<问题>" [--wait | --wait=秒数] [--anyway]',
  fact: 'teamlink fact "<主题>" ["<事实>"] [--from <通知号>] [--basis 本人确认|查证过]',
  facts: 'teamlink facts [关键词…]',
  reply: 'teamlink reply <通知号> "<回答>" --basis 本人确认|查证过|推测',
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

/**
 * ask 的 --wait：单独一个参数，写成 --wait（等默认的秒数）或 --wait=秒数；从参数里拿掉，其余的照旧是成员名和问题。
 * 返回 0 表示不等。
 */
export function takeWait(args: string[]): { waitSeconds: number; args: string[] } {
  let waitSeconds = 0;
  const others: string[] = [];
  for (const a of args) {
    const m = /^--wait(?:=(.*))?$/.exec(a);
    if (!m) {
      others.push(a);
      continue;
    }
    const n = m[1] === undefined ? WAIT_DEFAULT_S : Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > WAIT_MAX_S) throw new Error(`--wait 的秒数要是 1 到 ${WAIT_MAX_S} 之间的整数，收到：${m[1]}\n用法：${USAGE_OF.ask}`);
    waitSeconds = n;
  }
  return { waitSeconds, args: others };
}

/** 从参数里拿掉 --名字 值 或 --名字=值（问题、回答是自由文字，不能整个交给 parseArgs），返回值和剩下的参数。 */
export function takeOption(args: string[], name: string, usage: string): { value: string | undefined; args: string[] } {
  let value: string | undefined;
  const others: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const m = new RegExp(`^--${name}(?:=(.*))?$`).exec(args[i]);
    if (!m) {
      others.push(args[i]);
      continue;
    }
    value = m[1] ?? args[++i];
    if (value === undefined || value.trim() === '') throw new Error(`--${name} 后面要写值\n用法：${usage}`);
  }
  return { value, args: others };
}

/** 从参数里拿掉一个开关（--名字），返回有没有写。 */
export function takeFlag(args: string[], name: string): { on: boolean; args: string[] } {
  const others = args.filter((a) => a !== `--${name}`);
  return { on: others.length !== args.length, args: others };
}

/**
 * fact --from 的那条消息：先在本机存档（.team/notices.json）里找，沙箱里也能用；找不到再问服务器
 * （别的 worktree、别的电脑上收到的，存档滚掉了的，以及自己发的）。
 */
async function sourceOf(root: string, cfg: RepoConfig, identity: Identity, id: string): Promise<NoticeItem> {
  const local = findItem(root, id);
  if (local) return local;
  const manual = '把事实内容直接写在主题后面，再加 --basis 本人确认 或 查证过';
  try {
    return await call<NoticeItem>(cfg.server, identity, 'GET', `/api/v2/notice?${new URLSearchParams({ repoId: cfg.repoId, id })}`, undefined, 8000);
  } catch (e) {
    if (e instanceof NetworkError) throw new Error(`本机存档（${NOTICES_FILE}）里没有 ${id}，又连不上服务器（在 AI 工具的沙箱里这很正常）：${manual}`);
    if (e instanceof ClientError && e.status === 404 && e.message.includes('没有这个接口')) throw new Error(`服务器还不支持按通知号查（请管理员升级服务器）：${manual}`);
    throw e;
  }
}

/** reply 的 --basis：写了就要认得；AI 回答必须写（本人在终端里写的就是最强的依据，可以不写）。 */
export function replyBasis(word: string | undefined, via: 'ai' | 'person'): Basis | undefined {
  const choices = BASES.map((b) => BASIS_LABEL[b]).join('、');
  if (word === undefined) {
    if (via === 'person') return undefined;
    throw new Error(
      `回答要写明依据：加 --basis ${choices} 之一。本人确认＝你的用户亲口说的，查证过＝你在本机或系统里查到的，推测＝你猜的。只有你的用户知道的，先在对话里问他，不要替他猜。\n用法：${USAGE_OF.reply}`,
    );
  }
  const basis = parseBasis(word);
  if (!basis) throw new Error(`--basis 只能是 ${choices}，收到：${word}\n用法：${USAGE_OF.reply}`);
  return basis;
}

/** 等标准输出里排着的内容都写出去。 */
function flushed(): Promise<void> {
  return new Promise((ok) => process.stdout.write('', () => ok()));
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

/** 服务器已经不认这台设备了；连不上、别的错误（比如本机时间不对导致的 401）都不算。 */
async function revoked(server: string, identity: Identity): Promise<boolean> {
  try {
    await call<WhoamiResponse>(server, identity, 'GET', '/api/v2/whoami');
    return false;
  } catch (e) {
    return e instanceof ClientError && e.status === 401 && e.message.startsWith(DEVICE_UNKNOWN);
  }
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

    case 'ask': {
      const waited = takeWait(rest);
      const { on: anyway, args } = takeFlag(waited.args, 'anyway');
      const { waitSeconds } = waited;
      const [target, ...words] = args;
      const text = words.join(' ').trim();
      if (!target || !text) throw new Error(`用法：${USAGE_OF[cmd]}`);
      const { root, cfg, identity } = context(cwd);
      // 先查团队事实：已经有答案的，不必打断队友。拿不准时（它答不了这个问题、或者要确认它还对不对）加 --anyway 照样问
      const known = anyway ? [] : relatedFacts(root, text);
      if (known.length > 0) {
        out(
          [
            `没有发出：团队事实里已经有相关的记录，先看能不能直接用（全文在对应的文件里）：`,
            ...known.map((f) => `${factLine(f)}\n    ${f.file}`),
            `它答不了你的问题、或者你要确认它现在还对，加 --anyway 再问：teamlink ask ${target} "…" --anyway`,
          ].join('\n'),
        );
        return 0;
      }
      const sent = await send(root, cfg, identity, { type: 'question', summary: text, claims: [], to: [target] });
      // 只在提问真的发出去了、对方又在线时等：暂存进发件箱的（沙箱里连不上服务器）、对方不在线的，回执里已经说了什么时候能收到
      const online = sent.response?.presence?.some((p) => p.online) ?? false;
      if (waitSeconds === 0 || !sent.response || !online) {
        out(sent.text);
        return 0;
      }
      out(`${sent.text}正在等回答（最多 ${waitSeconds} 秒）……`);
      const got = await waitForAnswer(root, cfg, identity, sent.response.id, sent.response.recipients[0] ?? target, waitSeconds * 1000);
      out(got.text);
      if (got.ids.length > 0) {
        // 打印出去了才向服务器确认：命令在这之前被杀、确认没带到，回答会由 hook 再送一次，不会丢
        await flushed();
        await confirmAnswers(cfg, identity, got.ids);
      }
      return 0;
    }

    case 'reply': {
      const { value, args } = takeOption(rest, 'basis', USAGE_OF.reply);
      const [target, ...words] = args;
      const text = words.join(' ').trim();
      if (!target || !text) throw new Error(`用法：${USAGE_OF[cmd]}`);
      const via = originOf();
      const basis = replyBasis(value, via);
      const { root, cfg, identity } = context(cwd);
      out(await sendNotice(root, cfg, identity, { type: 'answer', summary: text, claims: [], to: [], replyTo: target, via, basis }));
      return 0;
    }

    case 'fact': {
      const from = takeOption(rest, 'from', USAGE_OF.fact);
      const basisOpt = takeOption(from.args, 'basis', USAGE_OF.fact);
      const [title, ...words] = basisOpt.args;
      if (!title) throw new Error(`用法：${USAGE_OF.fact}`);
      let basis: Basis | undefined;
      if (basisOpt.value !== undefined) {
        const b = parseBasis(basisOpt.value);
        if (!b) throw new Error(`--basis 只能是 本人确认、查证过，收到：${basisOpt.value}\n用法：${USAGE_OF.fact}`);
        basis = b;
      }
      const { root, cfg, identity } = context(cwd);
      const source = from.value ? await sourceOf(root, cfg, identity, from.value.trim()) : null;
      const r = recordFact(root, { title, body: words.join(' '), from: source, basis, recorder: identity.name });
      const where = `${r.fact.file}（依据：${r.fact.basis}，来源：${r.fact.source.split('，')[0]}）`;
      if (r.action === 'unchanged') out(`团队事实里已经有这一条，内容一样，没有改动：${where}`);
      else {
        out(r.action === 'created' ? `已记进团队事实：${where}` : `已更正团队事实：${where}，原来的内容挪到了“以前”`);
        out('跟着你的改动一起提交；合并以后，队友的 AI 问之前会先查到它。');
      }
      return 0;
    }

    case 'facts': {
      const root = repoRoot(cwd);
      if (!root) throw new Error('当前目录不在 git 仓库里');
      const { exact, facts } = searchFacts(root, rest);
      if (facts.length === 0) {
        out(
          rest.length > 0
            ? `团队事实（${FACTS_DIR}/）里没有和「${rest.join(' ')}」相关的记录。只有队友知道的，用 teamlink ask 问。`
            : `还没有团队事实（${FACTS_DIR}/）。收到本人确认、查证过的长期有效的事实时，用 teamlink fact "主题" --from 通知号 记下来。`,
        );
        return 0;
      }
      const head = rest.length === 0 ? `团队事实（${FACTS_DIR}/，共 ${facts.length} 条）：` : exact ? `团队事实里含「${rest.join(' ')}」的：` : `团队事实里没有含「${rest.join(' ')}」的，可能相关的：`;
      out([head, ...facts.map(factLine), `全文在 ${FACTS_DIR}/<主题>.md。`].join('\n'));
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
      } else if (values.invite && values.name && (await revoked(server, identity))) {
        // 这台设备被吊销了（或者成员被移出了），又带着新的邀请码：重新加入，换一把新密钥
        out(`本机原来在 ${server} 的身份（${identity.name}）已经失效，用这个邀请码重新加入。`);
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
      // 管理员给改过名：本机记的名字跟着改（notify 用它去掉点名里的自己）
      if (who.member.name !== identity.name) saveIdentity({ ...identity, name: who.member.name });
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
        const text = await runHook(event, tool, await readStdin(), cwd, async (s) => {
          emitted = true;
          print(s);
          await flushed();
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
