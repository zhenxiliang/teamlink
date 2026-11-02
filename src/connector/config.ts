// 本地配置：成员身份（含设备私钥）存在 $TEAMLINK_HOME（默认 ~/.teamlink），仓库配置存在仓库根目录的 .teamlink.json。

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface Identity {
  server: string;
  memberId: string;
  deviceId: string;
  name: string;
  privateKey: string;
}

export interface RepoConfig {
  server: string;
  repoId: string;
}

export const REPO_CONFIG = '.teamlink.json';

/** 本机的 teamlink 目录：身份、启动脚本、装好的连接器、hook-errors.log 都在这里。 */
export function teamlinkHome(): string {
  return resolve(process.env.TEAMLINK_HOME || join(homedir(), '.teamlink'));
}

const normServer = (s: string) => s.replace(/\/+$/, '');

function identitiesPath() {
  return join(teamlinkHome(), 'identities.json');
}

export function loadIdentities(): Record<string, Identity> {
  const p = identitiesPath();
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, Identity>) : {};
}

export function saveIdentity(id: Identity): void {
  const all = loadIdentities();
  all[normServer(id.server)] = { ...id, server: normServer(id.server) };
  mkdirSync(teamlinkHome(), { recursive: true, mode: 0o700 });
  writeFileSync(identitiesPath(), JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(identitiesPath(), 0o600);
}

export function identityFor(server: string): Identity | undefined {
  return loadIdentities()[normServer(server)];
}

/** 跑一条 git 命令，失败返回 null；输出去掉首尾空白。 */
export function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function repoRoot(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

export function readRepoConfig(root: string): RepoConfig | null {
  const p = join(root, REPO_CONFIG);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as RepoConfig) : null;
}

export function writeRepoConfig(root: string, cfg: RepoConfig): void {
  writeFileSync(join(root, REPO_CONFIG), JSON.stringify({ ...cfg, server: normServer(cfg.server) }, null, 2) + '\n');
}

/** 把一行加进 .git/info/exclude（各 worktree 共用），让本机生成的文件不出现在 git status 里。 */
export function excludeLocally(root: string, pattern: string): void {
  const gitDir = git(root, ['rev-parse', '--git-common-dir']) ?? '.git';
  const infoDir = join(isAbsolute(gitDir) ? gitDir : resolve(root, gitDir), 'info');
  const p = join(infoDir, 'exclude');
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (cur.split('\n').includes(pattern)) return;
  mkdirSync(infoDir, { recursive: true });
  writeFileSync(p, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}
