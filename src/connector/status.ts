// teamlink status：一次查清真实出现过的几种故障——身份和仓库关联、服务器能不能连上（两边的协议版本）、
// hook 装没装、从图形界面启动的 AI 工具能不能找到 node、hook 最近有没有跑（配置改过以后还没跑过，多半是 Codex 还没信任）、
// 发件箱积压、hook 的错误日志。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HealthResponse, Tool, WhoamiResponse } from '../shared/protocol.ts';
import { PROTOCOL } from '../shared/protocol.ts';
import { call, message } from './client.ts';
import { identityFor, loadIdentities, readRepoConfig, REPO_CONFIG, repoRoot, teamlinkHome, type RepoConfig } from './config.ts';
import { CLAUDE_HOOKS, CODEX_HOOKS, hookCommand, isTeamlinkEntry, launcherPath, readHookConfig, type HookConfig, type WantedHook } from './install.ts';
import { ago, outboxCounts, OUTBOX_DIR } from './outbox.ts';
import { localTime } from './received.ts';
import { hookErrorLog, lastHookRun, stateDirOf } from './state.ts';

/** 配置文件里的一条 teamlink hook。 */
interface Found {
  event: string;
  command: string;
}

function teamlinkEntries(cfg: HookConfig): Found[] {
  const found: Found[] = [];
  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups as { hooks?: unknown }[]) {
      if (!Array.isArray(g?.hooks)) continue;
      for (const h of g.hooks as { command?: string }[]) if (isTeamlinkEntry(h)) found.push({ event, command: String(h.command) });
    }
  }
  return found;
}

interface ToolHooks {
  label: string;
  tool: Tool;
  path: string;
  wanted: WantedHook[];
  /** 装没装（至少有一条 teamlink 的条目）。 */
  installed: boolean;
}

function hooksStatus(root: string, out: (s: string) => void): ToolHooks[] {
  const tools: ToolHooks[] = [
    { label: 'Claude Code', tool: 'claude', path: join(root, '.claude', 'settings.local.json'), wanted: CLAUDE_HOOKS, installed: false },
    { label: 'Codex', tool: 'codex', path: join(root, '.codex', 'hooks.json'), wanted: CODEX_HOOKS, installed: false },
  ];
  for (const t of tools) {
    let found: Found[];
    try {
      found = teamlinkEntries(readHookConfig(t.path));
    } catch (e) {
      out(`${t.label} 的 hook：${message(e)}`);
      continue;
    }
    const fix = `运行 teamlink install ${t.tool}`;
    if (found.length === 0) {
      out(`${t.label} 的 hook：没装（要用的话${fix}）`);
      continue;
    }
    t.installed = true;
    const missing = t.wanted.filter((w) => !found.some((f) => f.event === w.event && f.command === hookCommand(w.arg, t.tool)));
    const extra = [...new Set(found.filter((f) => !t.wanted.some((w) => w.event === f.event)).map((f) => f.event))];
    const problems = [
      ...(missing.length > 0 ? [`${missing.map((w) => w.event).join('、')} 没装或者还是旧版本的命令`] : []),
      ...(extra.length > 0 ? [`多了已经不需要的 ${extra.join('、')}`] : []),
    ];
    out(problems.length === 0 ? `${t.label} 的 hook：${t.wanted.length} 条都装好了（${t.path}）` : `${t.label} 的 hook：${problems.join('；')}，${fix}`);
  }
  return tools;
}

/** 用几乎是空的环境（模拟从图形界面启动的 Codex、Claude Code）以探测模式跑一次启动脚本。 */
function launcherStatus(out: (s: string) => void): void {
  const path = launcherPath();
  if (!existsSync(path)) {
    out(`启动脚本：${path} 不存在，hook 不会运行。运行 teamlink install`);
    return;
  }
  const r = spawnSync('env', ['-i', `HOME=${process.env.HOME ?? homedir()}`, 'PATH=/usr/bin:/bin', path, '--probe-node'], { encoding: 'utf8', timeout: 5000 });
  const node = /^node=(.*)$/m.exec(r.stdout ?? '')?.[1] ?? '';
  const version = /^version=(.*)$/m.exec(r.stdout ?? '')?.[1] ?? '';
  if (!node) {
    out(`启动脚本：从图形界面启动的 AI 工具里找不到 node，hook 不会运行。重新运行安装脚本，或者把 node 的路径写进 ${join(teamlinkHome(), 'node-path')}`);
    return;
  }
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  const tooOld = !(major > 23 || (major === 23 && minor >= 6));
  out(`启动脚本：${path}，从图形界面启动时用的 node 是 ${node}（${version || '版本未知'}）${tooOld ? '。版本太旧，teamlink 需要 23.6 以上' : ''}`);
}

function lastRuns(root: string, tools: ToolHooks[], out: (s: string) => void): void {
  const dir = stateDirOf(root);
  for (const t of tools.filter((x) => x.installed)) {
    const run = dir ? lastHookRun(dir, t.tool) : null;
    const since = existsSync(t.path) ? statSync(t.path).mtimeMs : 0;
    const label = `${t.label} 的 hook 最近一次运行`;
    const trust = t.tool === 'codex' ? '在这个仓库里打开 Codex，运行 /hooks 确认这几条都已信任' : '在这个仓库里打开 Claude Code 试一下';
    if (!run) out(`${label}：还没运行过。${trust}`);
    else if (Date.parse(run.at) < since) out(`${label}：${localTime(new Date(run.at))}（${run.event}），在 hook 配置更新之前；更新以后还没运行过。${trust}`);
    else out(`${label}：${localTime(new Date(run.at))}（${run.event}，${ago(run.at)}）`);
  }
}

async function serverStatus(cfg: RepoConfig, out: (s: string) => void): Promise<void> {
  let health: HealthResponse;
  try {
    health = await call<HealthResponse>(cfg.server, null, 'GET', '/healthz', undefined, 5000);
  } catch (e) {
    out(`服务器：${message(e)}`);
    return;
  }
  const v = health.protocol;
  const match = v === PROTOCOL ? '' : v > PROTOCOL ? '。服务器比本机新：重新运行安装脚本升级本机的连接器' : '。服务器比本机旧：请管理员升级服务器';
  out(`服务器：能连上 ${cfg.server}，协议版本：服务器 ${v}，本机 ${PROTOCOL}${match}`);
  const identity = identityFor(cfg.server);
  if (!identity) {
    out(`  本机还没有加入 ${cfg.server}：先运行 teamlink setup`);
    return;
  }
  try {
    const who = await call<WhoamiResponse>(cfg.server, identity, 'GET', '/api/v2/whoami', undefined, 5000);
    out(`  身份：${who.member.name}`);
  } catch (e) {
    out(`  身份校验失败：${message(e)}`);
  }
}

export async function status(cwd: string, out: (s: string) => void): Promise<void> {
  const ids = Object.values(loadIdentities());
  out(`本机身份：${ids.map((i) => `${i.name} @ ${i.server}`).join('；') || '无（先运行 teamlink setup）'}`);
  const root = repoRoot(cwd);
  const cfg = root ? readRepoConfig(root) : null;
  out(`当前仓库：${root ?? '不在 git 仓库里'}${cfg ? `，关联 ${cfg.repoId} @ ${cfg.server}` : root ? `，没有 ${REPO_CONFIG}（先运行 teamlink link）` : ''}`);
  if (cfg) await serverStatus(cfg, out);
  const tools = root ? hooksStatus(root, out) : [];
  launcherStatus(out);
  if (root) {
    lastRuns(root, tools, out);
    const n = outboxCounts(root);
    out(`发件箱：${n.pending} 条待补发，${OUTBOX_DIR}/failed/ 里 ${n.failed} 条被退回的${n.failed > 0 ? '（原件，看过可以删掉）' : ''}`);
  }
  const log = hookErrorLog();
  const tail = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(-3) : [];
  out(tail.length > 0 ? `hook 错误日志（${log}）最后 ${tail.length} 行：\n${tail.map((l) => `  ${l}`).join('\n')}` : 'hook 错误日志：没有');
}
