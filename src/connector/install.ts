// 安装：启动脚本、Claude Code 和 Codex 的 hook 配置、AGENTS.md 里的使用说明。

import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, type Tool } from '../shared/protocol.ts';
import { excludeLocally, git, teamlinkHome } from './config.ts';
import { writeAtomic } from './state.ts';

/** 这份连接器所在的目录（里面有 bin/teamlink.js）：install.sh 装的是 $TEAMLINK_HOME/app，从仓库直接运行时是仓库目录。 */
const APP_DIR = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** 双引号里的 shell 写法。 */
const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
/** 单引号里的 shell 写法。 */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function launcherPath(): string {
  return join(teamlinkHome(), 'bin', 'teamlink');
}

/**
 * 启动脚本（sh）：hook 命令和 AI 在沙箱里用的 teamlink 命令都走它，里面不写死 node 的路径，升级 Node 后不会失效。
 * 不查 Node 版本（免得每次 hook 多起一个进程），由 bin/teamlink.js 自己查。
 * 变量后面紧跟中文时都加了花括号：macOS 的 /bin/sh（bash 3.2）在 UTF-8 环境下会把中文当成变量名的一部分。
 */
export function launcherScript(appDir: string): string {
  return [
    '#!/bin/sh',
    '# teamlink 启动脚本：由 install.sh 或 teamlink install 生成，重新安装会覆盖，不要手改。',
    '# hook 命令和 AI 用的 teamlink 命令都走这里。找 node 的顺序：',
    '#   $TEAMLINK_NODE → $TEAMLINK_HOME/node-path 里记的路径 → $TEAMLINK_HOME/node/bin/node → PATH 里的 node',
    'if [ -z "${TEAMLINK_HOME:-}" ]; then',
    '  TEAMLINK_HOME=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)',
    'fi',
    'export TEAMLINK_HOME',
    `APP=${shq(appDir)}`,
    'NODE=',
    'if [ -n "${TEAMLINK_NODE:-}" ] && [ -f "$TEAMLINK_NODE" ] && [ -x "$TEAMLINK_NODE" ]; then',
    '  NODE=$TEAMLINK_NODE',
    'fi',
    'if [ -z "$NODE" ] && [ -f "$TEAMLINK_HOME/node-path" ]; then',
    '  p=$(cat "$TEAMLINK_HOME/node-path")',
    '  if [ -n "$p" ] && [ -f "$p" ] && [ -x "$p" ]; then NODE=$p; fi',
    'fi',
    'if [ -z "$NODE" ] && [ -x "$TEAMLINK_HOME/node/bin/node" ]; then',
    '  NODE=$TEAMLINK_HOME/node/bin/node',
    'fi',
    'if [ -z "$NODE" ]; then',
    '  NODE=$(command -v node 2>/dev/null) || NODE=',
    'fi',
    '# teamlink status 用：在模拟的图形界面环境里看能不能找到 node',
    'if [ "${1:-}" = "--probe-node" ]; then',
    '  echo "node=${NODE}"',
    '  if [ -n "$NODE" ]; then echo "version=$("$NODE" -v 2>/dev/null)"; fi',
    '  exit 0',
    'fi',
    'if [ -z "$NODE" ] || [ ! -f "$APP/bin/teamlink.js" ]; then',
    '  if [ -z "$NODE" ]; then',
    '    why="找不到 node（试过 TEAMLINK_NODE、${TEAMLINK_HOME}/node-path、${TEAMLINK_HOME}/node/bin/node、PATH）"',
    '  else',
    '    why="找不到连接器 ${APP}/bin/teamlink.js"',
    '  fi',
    '  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${why}，teamlink ${1:-} ${2:-} 没有运行" >> "$TEAMLINK_HOME/hook-errors.log" 2>/dev/null',
    '  # hook 不能打断 AI：不输出，退出码 0；其他命令要让人知道没有运行',
    '  if [ "${1:-}" = "hook" ]; then exit 0; fi',
    '  echo "teamlink：${why}。重新运行安装脚本，或者把 node 的路径写进 ${TEAMLINK_HOME}/node-path" >&2',
    '  exit 1',
    'fi',
    'exec "$NODE" "$APP/bin/teamlink.js" "$@"',
    '',
  ].join('\n');
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 记进 node-path 的 node：按启动时的写法找（比如 /opt/homebrew/bin/node 这种不带版本号的链接），
 * 不用 process.execPath（解析过链接，带版本号，升级 Node 后就没了）。
 */
function nodePath(): string {
  const a = process.argv0;
  const candidates = a.includes('/') ? [resolve(a)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, a));
  return candidates.find(isExecutable) ?? process.execPath;
}

/** 内容没变就不写。 */
function writeIfChanged(path: string, content: string, mode?: number): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  writeAtomic(path, content, mode);
  return true;
}

/** 写启动脚本和 node-path（install.sh 的最后一步 setup、teamlink install 都调用它，写法一样，可以重复运行）。 */
export function ensureLauncher(): string {
  const path = launcherPath();
  writeIfChanged(path, launcherScript(APP_DIR), 0o755);
  writeIfChanged(join(teamlinkHome(), 'node-path'), `${nodePath()}\n`);
  return path;
}

/** hook 命令：启动脚本的绝对路径。里面保留 “ hook ”，新旧两种条目都能认出来。 */
export function hookCommand(event: string, tool: string): string {
  return `${q(launcherPath())} hook ${event} --tool ${tool}`;
}

export interface WantedHook {
  /** hook 配置里的事件名。 */
  event: string;
  /** teamlink hook 的事件参数。 */
  arg: string;
  matcher?: string;
  timeout: number;
}

/** Codex 装 5 条（不再装 PreToolUse）。从这一版起 matcher 和 timeout 不再改：Codex 按位置记信任，哈希也不只覆盖命令。 */
export const CODEX_HOOKS: WantedHook[] = [
  { event: 'SessionStart', arg: 'session-start', matcher: 'startup|resume', timeout: 10 },
  { event: 'UserPromptSubmit', arg: 'prompt', timeout: 10 },
  { event: 'PostToolUse', arg: 'post-tool', matcher: 'apply_patch|Bash|mcp__.*', timeout: 10 },
  { event: 'Stop', arg: 'stop', timeout: 10 },
  { event: 'SessionEnd', arg: 'session-end', timeout: 3 }, // Codex 的上限就是 3 秒
];

/** Claude Code 也装 5 条（旧版装的 PreToolUse 重装时删掉）。 */
export const CLAUDE_HOOKS: WantedHook[] = [
  { event: 'SessionStart', arg: 'session-start', timeout: 10 },
  { event: 'UserPromptSubmit', arg: 'prompt', timeout: 10 },
  { event: 'PostToolUse', arg: 'post-tool', matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|WebFetch|WebSearch|mcp__.*', timeout: 10 },
  { event: 'Stop', arg: 'stop', timeout: 10 },
  { event: 'SessionEnd', arg: 'session-end', timeout: 3 },
];

type HookGroup = { matcher?: unknown; hooks?: unknown } & Record<string, unknown>;
export type HookConfig = { hooks?: Record<string, unknown> } & Record<string, unknown>;

/** teamlink 的条目：命令里同时有 teamlink 和 “ hook ”（旧版写的是 node 路径加 bin/teamlink.js，也认得）。 */
export function isTeamlinkEntry(h: unknown): boolean {
  const c = (h as { command?: unknown } | null)?.command;
  return typeof c === 'string' && c.includes('teamlink') && c.includes(' hook ');
}

const entryOf = (tool: string, w: WantedHook) => ({ type: 'command', command: hookCommand(w.arg, tool), timeout: w.timeout });
const groupOf = (tool: string, w: WantedHook): HookGroup => ({ ...(w.matcher ? { matcher: w.matcher } : {}), hooks: [entryOf(tool, w)] });

/**
 * 合并进已有配置，原位替换：teamlink 的条目原来在哪个组、第几条，就还放在哪里，找不到才追加到这个事件的最后。
 * 删掉已经不需要的 teamlink 条目（旧版装的 PreToolUse）和重复的；别人的 hook 一律不动。
 * 组里只有 teamlink 的条目时 matcher 按这一版的来；组里还有别人的 hook 就不改 matcher，免得影响别人。
 */
export function mergeHooks(cfg: HookConfig, tool: string, wanted: WantedHook[]): HookConfig {
  const want = new Map(wanted.map((w) => [w.event, w]));
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    const w = want.get(event);
    const ours = Array.isArray(groups) && groups.some((g: HookGroup) => Array.isArray(g?.hooks) && g.hooks.some(isTeamlinkEntry));
    if (!Array.isArray(groups) || (!ours && !w)) {
      hooks[event] = groups;
      continue;
    }
    let placed = false;
    const next: unknown[] = [];
    for (const g of groups as HookGroup[]) {
      const list = Array.isArray(g?.hooks) ? (g.hooks as unknown[]) : null;
      if (!list || !list.some(isTeamlinkEntry)) {
        next.push(g);
        continue;
      }
      const onlyOurs = list.every(isTeamlinkEntry);
      const kept = list.flatMap((h) => {
        if (!isTeamlinkEntry(h)) return [h];
        if (w && !placed) {
          placed = true;
          return [entryOf(tool, w)];
        }
        return []; // 已经不需要的、或者重复的 teamlink 条目
      });
      if (kept.length === 0) continue;
      const group: HookGroup = { ...g, hooks: kept };
      if (onlyOurs && w) {
        if (w.matcher) group.matcher = w.matcher;
        else delete group.matcher;
      }
      next.push(group);
    }
    if (w && !placed) next.push(groupOf(tool, w));
    if (next.length > 0) hooks[event] = next;
  }
  for (const w of wanted) if (!(w.event in hooks)) hooks[w.event] = [groupOf(tool, w)];
  return { ...cfg, hooks };
}

export function readHookConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return cfg as HookConfig;
  } catch {
    // 下面统一报错
  }
  throw new Error(`${path} 不是合法的 JSON 对象，先修好再装`);
}

/** 合并后内容没变就不写盘（重装不改动文件，Codex 的信任记录也不受影响）。这是用户的文件，原地写，是链接的话照样写到链接指向的文件。 */
function writeHooks(path: string, tool: string, wanted: WantedHook[]): boolean {
  const cur = readHookConfig(path);
  const next = mergeHooks(cur, tool, wanted);
  if (existsSync(path) && JSON.stringify(next) === JSON.stringify(cur)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return true;
}

export interface Installed {
  path: string;
  /** 这次改了文件。 */
  changed: boolean;
  /** 要提醒用户的事，安装输出里每条一行。 */
  notes: string[];
}

/** 各工具的 hook 配置文件（相对工作区根目录）。 */
const HOOK_FILE: Record<Tool, string> = { claude: '.claude/settings.local.json', codex: '.codex/hooks.json' };

/** 这个工作区里已经装了 teamlink 条目的工具（配置文件不存在、或者 JSON 坏了都算没装）。 */
export function installedTools(root: string): Tool[] {
  return TOOLS.filter((tool) => {
    try {
      const cfg = readHookConfig(join(root, HOOK_FILE[tool]));
      return Object.values(cfg.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some((g: HookGroup) => Array.isArray(g?.hooks) && g.hooks.some(isTeamlinkEntry)));
    } catch {
      return false;
    }
  });
}

/** Codex 默认只读 AGENTS.md 的前 32 KiB（project_doc_max_bytes），后面的截掉。 */
const CODEX_DOC_MAX_BYTES = 32 * 1024;

// AGENTS.md、CLAUDE.md 先写：它们可能报错（段落没有结束标记），报错时 hook 配置还没动，
// 用户补好以后重跑，配置照样算“有改动”，Codex 的信任提示不会被跳过
export function installClaude(root: string): Installed {
  ensureLauncher();
  ensureAgentsSection(root);
  ensureClaudeImportsAgents(root);
  const path = join(root, HOOK_FILE.claude);
  const changed = writeHooks(path, 'claude', CLAUDE_HOOKS);
  excludeLocally(root, HOOK_FILE.claude);
  excludeLocally(root, '.team/');
  return { path, changed, notes: [] };
}

export function installCodex(root: string): Installed {
  ensureLauncher();
  const end = sectionEnd(ensureAgentsSection(root));
  const path = join(root, HOOK_FILE.codex);
  const changed = writeHooks(path, 'codex', CODEX_HOOKS);
  const notes: string[] = [];
  // 团队提交过这个文件时 .git/info/exclude 管不了它（Codex 只认这一个位置）：只能提醒别把本机的改动提交上去
  if (git(root, ['ls-files', '--error-unmatch', HOOK_FILE.codex]) === null) excludeLocally(root, HOOK_FILE.codex);
  else notes.push('这个文件团队提交过，teamlink 的条目带本机路径，不要提交这些改动。');
  excludeLocally(root, '.team/');
  if (end > CODEX_DOC_MAX_BYTES) {
    notes.push(`AGENTS.md 里 teamlink 这一段结束在第 ${end} 字节，Codex 默认只读 AGENTS.md 的前 32 KiB，读不全它：请把这一段挪到文件前面（重装时会留在原位）。`);
  }
  return { path, changed, notes };
}

const START = '<!-- teamlink:start -->';
const END = '<!-- teamlink:end -->';

const AGENTS_SECTION = `${START}
## 团队协作（teamlink）

- 队友的消息会在你运行命令时自动转给你（包在 \`<team-notices-…>\` 标签里），不用去查。怀疑漏了（比如在等的回答一直没到），看 \`.team/received.md\`（可以 grep 通知号或队友的名字）。
- 能从代码里读到的直接读代码，不要问人。只有对方知道的才问：他做到哪了、他和他的用户定了什么、他电脑上的情况，用 \`teamlink ask 成员名 "问题"\`，回答会自动送回。成员名见开工时转来的队友列表。
- 你这边有队友用得上、他又读不到的东西（还没合并的接口改动、给他做好的功能、你的用户刚定的决定），告诉他：
  \`teamlink notify --to 成员名 --summary "改了什么、为什么" --claim 文件#符号:变更类型\`
  \`--to\` 必填、可写多次；\`--claim\` 可选、可写多次，变更类型是 added、removed、signature_changed、behavior_changed；不必先提交。只写事实，不带命令和链接。
${END}`;

/** 独占一行的标记从 from 起第一次出现在哪（行首、行尾可以有空白）。 */
function markerLine(text: string, marker: string, from: number): { at: number; end: number } | null {
  const re = new RegExp(`^[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'gm');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? { at: m.index, end: m.index + m[0].length } : null;
}

/**
 * teamlink 这一段的位置：开始、结束标记都要独占一行（装的时候就是这么写的），正文里提到它们的字样
 * （比如“不要手改 `<!-- teamlink:end -->` 前面那一段”）不算；结束标记从开始标记之后找。
 * 有开始标记、后面却没有结束标记时返回 'open'。
 */
function findSection(text: string): { at: number; end: number } | 'open' | null {
  const start = markerLine(text, START, 0);
  if (!start) return null;
  const end = markerLine(text, END, start.end);
  return end ? { at: start.at, end: end.end } : 'open';
}

function upsertSection(path: string, section: string) {
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const found = findSection(cur);
  // 有开始标记、后面却没有结束标记：不知道这一段到哪里为止，猜错会删掉团队自己的内容，文件不动，让用户先补上
  if (found === 'open') throw new Error(`${path} 里有 ${START}，后面却没有结束标记 ${END}：先在 teamlink 这一段的末尾补上它（单独一行），再重新运行`);
  const next = found ? cur.slice(0, found.at) + section + cur.slice(found.end) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${section}\n`;
  if (next !== cur) writeFileSync(path, next);
}

export function ensureAgentsSection(root: string): string {
  const path = join(root, 'AGENTS.md');
  upsertSection(path, AGENTS_SECTION);
  return path;
}

/** teamlink 这一段结束在第几个字节；没有这一段时返回 -1。 */
function sectionEnd(path: string): number {
  const text = readFileSync(path, 'utf8');
  const found = findSection(text);
  return found && found !== 'open' ? Buffer.byteLength(text.slice(0, found.end)) : -1;
}

/** 两个路径是不是同一个文件：比较设备号和 inode（statSync 跟着符号链接走），符号链接、硬链接都认得。 */
function sameFile(a: string, b: string): boolean {
  const x = statSync(a);
  const y = statSync(b);
  return x.dev === y.dev && x.ino === y.ino;
}

/** Claude Code 读 CLAUDE.md，不读 AGENTS.md；用 @ 引用把它带进来。 */
function ensureClaudeImportsAgents(root: string) {
  const path = join(root, 'CLAUDE.md');
  const agents = join(root, 'AGENTS.md');
  // 两个是同一个文件（符号链接或硬链接）：Claude Code 读到的就是 AGENTS.md，再写引用会把里面的 teamlink 段落换成一行 @AGENTS.md
  if (existsSync(path) && existsSync(agents) && sameFile(path, agents)) return;
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (cur.includes('@AGENTS.md')) return;
  upsertSection(path, `${START}\n@AGENTS.md\n${END}`);
}
