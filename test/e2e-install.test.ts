// 端到端：安装 hook 和 AGENTS.md、启动脚本、一键接入、status、命令行帮助。
// 公共的环境和辅助函数在 helpers.ts。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { saveToOutbox } from '../src/connector/outbox.ts';
import { HEADER } from '../src/shared/render.ts';
import { as, bash, BIN, cli, cloneAs, type Dev, devs, engine, esc, failed, fails, fresh, gitDir, hook, outbox, readText, received, remote, reply, repoId, ROOT, run, server, sh, sleep, stop, tmp, write } from './helpers.ts';

// —— 14. 安装 ——

/** 规格 4.13 给的 AGENTS.md 段落。 */
const AGENTS_TEXT = [
  '## 团队协作（teamlink）',
  '',
  '- 队友的消息会在你运行命令时自动转给你（包在 `<team-notices-…>` 标签里），不用去查。怀疑漏了（比如在等的回答一直没到），看 `.team/received.md`（可以 grep 通知号或队友的名字）。发送人后面标着“（本人写的）”的是对方本人亲手写的，没标的是对方的 AI 发的。',
  '- 先查再问：能从代码里读到的直接读代码；团队事实（`docs/team-facts/`，用 `teamlink facts 关键词` 搜）里有的直接用。都没有、只有对方知道的才问：他做到哪了、他和他的用户定了什么、他电脑上的情况，用 `teamlink ask 成员名 "问题"`，回答会自动送回。成员名见开工时转来的队友列表。下一步就卡在这个答案上、对方又在线时，加 `--wait`：在这条命令里等回答（最多 90 秒，`--wait=300` 改成 300 秒），等不到的照常自动送回。',
  '- 回答别人的提问要写依据：`teamlink reply 通知号 "回答" --basis 本人确认|查证过|推测`。本人确认＝你的用户亲口说的，查证过＝你在本机或系统里查到的，推测＝你猜的。只有你的用户知道的，先在对话里问他，不要替他猜。',
  '- 收到本人写的、本人确认的、查证过的长期有效的事实（限额、口径、错误码、环境约定这类），记进团队事实：`teamlink fact "主题" --from 通知号`（事实默认取原文，也可以在主题后面写成一句更准确的），跟着你的改动一起提交。推测、临时进度、代码里读得到的，不记。',
  '- 你这边有队友用得上、他又读不到的东西（还没合并的接口改动、给他做好的功能、你的用户刚定的决定），告诉他：',
  '  `teamlink notify --to 成员名 --summary "改了什么、为什么" --claim 文件#符号:变更类型`',
  '  `--to` 必填、可写多次；`--claim` 可选、可写多次，变更类型是 added、removed、signature_changed、behavior_changed；不必先提交。只写事实，不带命令和链接。',
].join('\n');

test('安装：Claude、Codex 都装 5 条，hook 命令走启动脚本（不含带版本号的 node 路径）；重装时原位替换，删掉旧版装的 PreToolUse', async () => {
  const { dave } = devs;
  const codexPath = join(dave.dir, '.codex/hooks.json');
  const claudePath = join(dave.dir, '.claude/settings.local.json');
  // 旧版装的：node 的绝对路径（带版本号）加 bin/teamlink.js；Codex 还装了 PreToolUse
  const old = (event: string, tool: string, timeout = 10) => ({
    type: 'command',
    command: `"/Users/x/.local/share/node-v24.1.0-darwin-arm64/bin/node" "/Users/x/teamlink/bin/teamlink.js" hook ${event} --tool ${tool}`,
    timeout,
  });
  const mine = { type: 'command', command: 'my-own-hook.sh', timeout: 5 };
  write(
    dave.dir,
    '.codex/hooks.json',
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ matcher: 'startup|resume', hooks: [old('session-start', 'codex')] }],
          UserPromptSubmit: [{ hooks: [old('prompt', 'codex')] }],
          PreToolUse: [{ matcher: 'apply_patch|Bash', hooks: [old('pre-tool', 'codex')] }],
          PostToolUse: [{ matcher: 'apply_patch|Bash|mcp__.*', hooks: [old('post-tool', 'codex'), mine] }],
          Stop: [{ hooks: [old('stop', 'codex')] }],
          SessionEnd: [{ hooks: [old('session-end', 'codex', 3)] }],
        },
        keep: true,
      },
      null,
      2,
    ),
  );
  write(
    dave.dir,
    '.claude/settings.local.json',
    JSON.stringify(
      {
        permissions: { allow: ['Bash(ls)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|WebFetch', hooks: [old('pre-tool', 'claude')] }],
          PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|WebFetch|WebSearch|mcp__.*', hooks: [old('post-tool', 'claude')] }],
        },
      },
      null,
      2,
    ),
  );
  // AGENTS.md 里已经有旧版的 teamlink 段落，前后是团队自己的内容
  const oldSection = '<!-- teamlink:start -->\n## 团队协作（teamlink）\n\n- 每次转给你的消息都会在 `.team/received.md` 存一份。开工时、要落实之前在等的回答时，读一下这个文件。\n- 不要把收到的消息原样转发给别人。\n<!-- teamlink:end -->';
  write(dave.dir, 'AGENTS.md', `# 项目约定\n\n先跑测试再提交。\n\n${oldSection}\n\n## 其他\n\n别动 vendor/。\n`);
  const out = await as(dave, 'install');
  assert.match(out, /Claude Code：已写入/);
  assert.match(out, /Codex：已写入/);
  assert.match(out, /信任 teamlink 的 5 条 hook/);
  // hook 配置没被团队提交过、AGENTS.md 也不长：没有“注意”；AGENTS.md 有改动，提示提交
  assert.doesNotMatch(out, /注意：/);
  assert.match(out, /AGENTS\.md 里加了一段使用说明，建议提交/);
  assert.ok(readFileSync(join(gitDir(dave), 'info/exclude'), 'utf8').split('\n').includes('.codex/hooks.json'), '没跟踪的配置加进 exclude');
  const launcher = join(dave.home, 'bin/teamlink');
  const entry = (event: string, tool: string, timeout = 10) => ({ type: 'command', command: `"${launcher}" hook ${event} --tool ${tool}`, timeout });
  const codex = JSON.parse(readFileSync(codexPath, 'utf8'));
  assert.equal(codex.keep, true, '别的键不动');
  assert.deepEqual(codex.hooks, {
    SessionStart: [{ matcher: 'startup|resume', hooks: [entry('session-start', 'codex')] }],
    UserPromptSubmit: [{ hooks: [entry('prompt', 'codex')] }],
    PostToolUse: [{ matcher: 'apply_patch|Bash|mcp__.*', hooks: [entry('post-tool', 'codex'), mine] }],
    Stop: [{ hooks: [entry('stop', 'codex')] }],
    SessionEnd: [{ hooks: [entry('session-end', 'codex', 3)] }],
  });
  const claude = JSON.parse(readFileSync(claudePath, 'utf8'));
  assert.deepEqual(claude.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(claude.hooks, {
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|WebFetch|WebSearch|mcp__.*', hooks: [entry('post-tool', 'claude')] }],
    SessionStart: [{ hooks: [entry('session-start', 'claude')] }],
    UserPromptSubmit: [{ hooks: [entry('prompt', 'claude')] }],
    Stop: [{ hooks: [entry('stop', 'claude')] }],
    SessionEnd: [{ hooks: [entry('session-end', 'claude', 3)] }],
  });
  for (const cfg of [codex, claude]) {
    for (const groups of Object.values(cfg.hooks) as { hooks: { command: string }[] }[][]) {
      for (const h of groups.flatMap((g) => g.hooks).filter((x) => x.command.includes(' hook '))) assert.doesNotMatch(h.command, /node-v\d|teamlink\.js/, h.command);
    }
  }
  // 启动脚本、node-path
  assert.ok(statSync(launcher).mode & 0o111, '启动脚本可执行');
  assert.ok(readFileSync(launcher, 'utf8').includes(`\nAPP='${ROOT}'\n`), '从仓库直接运行 install：连接器目录就是仓库目录');
  assert.ok(readFileSync(join(dave.home, 'node-path'), 'utf8').trim());
  // AGENTS.md 里的旧段落换成规格 4.13 的那一段，团队自己的内容不动；CLAUDE.md 引用它
  const agents = readFileSync(join(dave.dir, 'AGENTS.md'), 'utf8');
  assert.equal(agents, `# 项目约定\n\n先跑测试再提交。\n\n<!-- teamlink:start -->\n${AGENTS_TEXT}\n<!-- teamlink:end -->\n\n## 其他\n\n别动 vendor/。\n`);
  assert.match(readFileSync(join(dave.dir, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
  // 旧写法照收；generic、mcp 两种已经删掉
  assert.match(await as(dave, 'install', '--codex'), /Codex：已是最新，没有改动/);
  assert.match(await as(dave, 'install', 'claude'), /Claude Code：已是最新，没有改动/);
  for (const args of [['--generic'], ['--mcp'], ['generic'], ['mcp']]) {
    assert.match(await fails(dave, 'install', ...args), /已不支持，用 teamlink install codex 或 teamlink install claude/, args.join(' '));
  }
});

test('安装：在 teamlink 的条目后面放一个别人的 hook，连续重装两次，顺序和内容都不变、文件不重写', async () => {
  const { dave } = devs;
  for (const [tool, rel, label] of [
    ['codex', '.codex/hooks.json', 'Codex'],
    ['claude', '.claude/settings.local.json', 'Claude Code'],
  ] as const) {
    const path = join(dave.dir, rel);
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    cfg.hooks.Stop[0].hooks.push({ type: 'command', command: `after-${tool}-stop.sh`, timeout: 5 });
    cfg.hooks.Stop.push({ hooks: [{ type: 'command', command: 'next-group.sh' }] });
    const text = `${JSON.stringify(cfg, null, 2)}\n`;
    writeFileSync(path, text);
    const mtime = statSync(path).mtimeMs;
    await sleep(30);
    for (let i = 0; i < 2; i++) assert.match(await as(dave, 'install', tool), new RegExp(`${label}：已是最新，没有改动`));
    assert.equal(readFileSync(path, 'utf8'), text, '顺序和内容都不变');
    assert.equal(statSync(path).mtimeMs, mtime, '文件没有重写');
  }
});

/** AGENTS.md 里 teamlink 那一段（不含标记）出现了几次、内容是什么。 */
function agentsSections(text: string): string[] {
  return [...text.matchAll(/<!-- teamlink:start -->\n([\s\S]*?)\n<!-- teamlink:end -->/g)].map((m) => m[1]);
}

test('安装：CLAUDE.md 是指向 AGENTS.md 的链接（符号链接或硬链接）时不写 @AGENTS.md（两个是同一个文件），AGENTS.md 里的说明不会被换掉', async () => {
  const dev = cloneAs(devs.dave, 'dave-symlink');
  write(dev.dir, 'AGENTS.md', '# 项目约定\n\n先跑测试再提交。\n');
  symlinkSync('AGENTS.md', join(dev.dir, 'CLAUDE.md'));
  const check = (label: string) => {
    const agents = readFileSync(join(dev.dir, 'AGENTS.md'), 'utf8');
    assert.deepEqual(agentsSections(agents), [AGENTS_TEXT], label);
    assert.ok(agents.startsWith('# 项目约定\n\n先跑测试再提交。\n'), label);
    assert.doesNotMatch(agents, /@AGENTS\.md/, label);
    assert.ok(lstatSync(join(dev.dir, 'CLAUDE.md')).isSymbolicLink(), `${label}：CLAUDE.md 还是链接`);
  };
  await as(dev, 'install', 'claude');
  check('install claude');
  // 先装 Codex 再装 Claude，再不带参数装一次（两个都装）：结果一样
  await as(dev, 'install', 'codex');
  await as(dev, 'install', 'claude');
  check('先 codex 再 claude');
  await as(dev, 'install');
  check('两个都装');
  // 硬链接也一样（statSync 看的是同一个 inode）
  const hard = cloneAs(devs.dave, 'dave-hardlink');
  write(hard.dir, 'AGENTS.md', '# 项目约定\n\n先跑测试再提交。\n');
  linkSync(join(hard.dir, 'AGENTS.md'), join(hard.dir, 'CLAUDE.md'));
  for (let i = 0; i < 2; i++) await as(hard, 'install', 'claude');
  const text = readFileSync(join(hard.dir, 'AGENTS.md'), 'utf8');
  assert.deepEqual(agentsSections(text), [AGENTS_TEXT], '硬链接');
  assert.doesNotMatch(text, /@AGENTS\.md/, '硬链接');
});

test('安装：.codex/hooks.json 被团队提交过时，提醒不要提交 teamlink 的条目（exclude 对跟踪的文件没用，不加），团队的条目留在原位', async () => {
  const dev = cloneAs(devs.dave, 'dave-tracked');
  const team = { type: 'command', command: 'team-stop.sh', timeout: 5 };
  write(dev.dir, '.codex/hooks.json', `${JSON.stringify({ hooks: { Stop: [{ hooks: [team] }] } }, null, 2)}\n`);
  sh(dev.dir, 'add', '.codex/hooks.json');
  sh(dev.dir, 'commit', '-q', '-m', '团队共用的 Codex hook');
  const out = await as(dev, 'install', 'codex');
  assert.match(out, /Codex：已写入 [^\n]*hooks\.json\n {2}注意：这个文件团队提交过，teamlink 的条目带本机路径，不要提交这些改动。\n/);
  const hooks = JSON.parse(readFileSync(join(dev.dir, '.codex/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.Stop[0], { hooks: [team] }, '团队的条目留在原位');
  assert.match(hooks.Stop[1].hooks[0].command, / hook stop --tool codex$/);
  assert.ok(!readFileSync(join(gitDir(dev), 'info/exclude'), 'utf8').split('\n').includes('.codex/hooks.json'), '不加进 exclude');
  // 重装（没有改动）也照样提醒
  assert.match(await as(dev, 'install', 'codex'), /Codex：已是最新，没有改动 [^\n]*\n {2}注意：这个文件团队提交过/);
});

test('安装：AGENTS.md 里 teamlink 这一段结束在 32 KiB 以后时提醒挪到前面（Codex 默认只读前 32 KiB）；挪过去以后重装留在原位、不再提醒', async () => {
  const dev = cloneAs(devs.dave, 'dave-long');
  const team = `# 项目约定\n\n${'先跑测试再提交，提交前看一遍改动。\n'.repeat(1000)}`;
  assert.ok(Buffer.byteLength(team) > 40_000);
  write(dev.dir, 'AGENTS.md', team);
  const out = await as(dev, 'install', 'codex');
  const end = Buffer.byteLength(readFileSync(join(dev.dir, 'AGENTS.md'), 'utf8').trimEnd());
  assert.ok(out.includes(`\n  注意：AGENTS.md 里 teamlink 这一段结束在第 ${end} 字节，Codex 默认只读 AGENTS.md 的前 32 KiB，读不全它：请把这一段挪到文件前面（重装时会留在原位）。\n`), out);
  // 用户把这一段挪到最前面：重装时原位替换，不再提醒
  const section = `<!-- teamlink:start -->\n${AGENTS_TEXT}\n<!-- teamlink:end -->`;
  write(dev.dir, 'AGENTS.md', `${section}\n\n${team}`);
  const again = await as(dev, 'install', 'codex');
  assert.doesNotMatch(again, /32 KiB/);
  assert.equal(readFileSync(join(dev.dir, 'AGENTS.md'), 'utf8'), `${section}\n\n${team}`, '段落还在开头');
});

test('安装：AGENTS.md 的段落缺结束标记时报错，hook 配置一点不动；补好以后重跑照常写入，并提示去 /hooks 信任', async () => {
  const dev = cloneAs(devs.dave, 'dave-open-marker');
  write(dev.dir, 'AGENTS.md', '# 约定\n\n<!-- teamlink:start -->\n旧的说明，结束标记被删掉了\n');
  for (const tool of ['codex', 'claude']) assert.match(await fails(dev, 'install', tool), /后面却没有结束标记/, tool);
  assert.ok(!existsSync(join(dev.dir, '.codex/hooks.json')), 'Codex 的配置没写');
  assert.ok(!existsSync(join(dev.dir, '.claude/settings.local.json')), 'Claude 的配置没写');
  write(dev.dir, 'AGENTS.md', '# 约定\n\n<!-- teamlink:start -->\n旧的说明\n<!-- teamlink:end -->\n');
  const out = await as(dev, 'install', 'codex');
  assert.match(out, /Codex：已写入/);
  assert.match(out, /\/hooks/, `重跑时还会提示信任：${out}`);
});

test('安装：只在 AGENTS.md、CLAUDE.md 真有改动时才提示提交', async () => {
  const dev = cloneAs(devs.dave, 'dave-commit');
  const hint = /AGENTS\.md 里加了一段使用说明，建议提交/;
  assert.match(await as(dev, 'install'), hint);
  sh(dev.dir, 'add', 'AGENTS.md', 'CLAUDE.md');
  sh(dev.dir, 'commit', '-q', '-m', '加上 teamlink 的说明');
  const again = await as(dev, 'install', 'codex');
  assert.match(again, /Codex：已是最新，没有改动/);
  assert.doesNotMatch(again, hint);
});

test('setup：不写工具时更新这个工作区已经装过的（只有 Claude 的就只更新 Claude，不生成 Codex 的配置）；写了 --claude 或 --codex 时加上已经装过的；Codex 的配置没改就不再让人去信任', async () => {
  const { carol } = devs;
  const launcher = join(carol.home, 'bin/teamlink');
  // 旧版装的：node 的绝对路径（带版本号）加 bin/teamlink.js
  const oldEntry = (event: string, tool: string) => ({ type: 'command', command: `"/opt/node-v24.1.0/bin/node" "/x/teamlink/bin/teamlink.js" hook ${event} --tool ${tool}`, timeout: 10 });
  const oldClaude = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [oldEntry('post-tool', 'claude')] }], Stop: [{ hooks: [oldEntry('stop', 'claude')] }] } };
  const oldCodex = { hooks: { PostToolUse: [{ matcher: 'apply_patch|Bash', hooks: [oldEntry('post-tool', 'codex')] }] } };
  const commands = (dev: Dev, rel: string) =>
    (Object.values(JSON.parse(readFileSync(join(dev.dir, rel), 'utf8')).hooks) as { hooks: { command: string }[] }[][]).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  const updated = (dev: Dev, rel: string, tool: string) => {
    const list = commands(dev, rel);
    assert.equal(list.length, 5, `${rel}：${list.join('、')}`);
    assert.ok(list.every((c) => c.startsWith(`"${launcher}" hook `) && c.endsWith(` --tool ${tool}`)), `${rel} 换成了启动脚本：${list.join('、')}`);
  };

  // 只装过 Claude 的：不带参数，只更新 Claude
  const only = cloneAs(carol, 'carol-setup-claude');
  write(only.dir, '.claude/settings.local.json', JSON.stringify(oldClaude));
  const out = await as(only, 'setup', '--server', server.url);
  assert.match(out, /Claude Code：已写入/);
  assert.doesNotMatch(out, /Codex：/);
  assert.ok(!existsSync(join(only.dir, '.codex/hooks.json')), '不生成 Codex 的配置');
  assert.doesNotMatch(out, /信任 teamlink 的 5 条/);
  updated(only, '.claude/settings.local.json', 'claude');
  // 只装过 Claude、这次写了 --codex：装上 Codex，Claude 也一起更新
  const plus = cloneAs(carol, 'carol-setup-codex');
  write(plus.dir, '.claude/settings.local.json', JSON.stringify(oldClaude));
  const added = await as(plus, 'setup', '--server', server.url, '--codex');
  assert.match(added, /Codex：已写入/);
  assert.match(added, /Claude Code：已写入/);
  updated(plus, '.claude/settings.local.json', 'claude');
  updated(plus, '.codex/hooks.json', 'codex');

  // 两个都装过：不带参数两个都更新；写了 --claude 也两个都更新
  for (const args of [[], ['--claude']]) {
    const both = cloneAs(carol, `carol-setup-both${args.join('')}`);
    write(both.dir, '.claude/settings.local.json', JSON.stringify(oldClaude));
    write(both.dir, '.codex/hooks.json', JSON.stringify(oldCodex));
    const r = await as(both, 'setup', '--server', server.url, ...args);
    assert.match(r, /Codex：已写入/, args.join(' '));
    assert.match(r, /Claude Code：已写入/, args.join(' '));
    assert.match(r, /运行 \/hooks，信任 teamlink 的 5 条 hook/, `${args.join(' ')}：Codex 的配置改了，要重新信任`);
    updated(both, '.claude/settings.local.json', 'claude');
    updated(both, '.codex/hooks.json', 'codex');
    // 再跑一次：都是最新，Codex 的配置没改，不再让人去信任
    const again = await as(both, 'setup', '--server', server.url, ...args);
    assert.match(again, /Codex：已是最新，没有改动/);
    assert.match(again, /Claude Code：已是最新，没有改动/);
    assert.doesNotMatch(again, /信任 teamlink 的 5 条/);
  }
});

test('启动脚本：TEAMLINK_NODE 优先；node-path 指向已删除的文件时回退到 $TEAMLINK_HOME/node、再到 PATH 里的 node；什么都找不到时 hook 退出码 0、输出为空、错误日志多一行', async () => {
  const { dave } = devs;
  const launcher = join(dave.home, 'bin/teamlink');
  const nodePathFile = join(dave.home, 'node-path');
  const saved = readFileSync(nodePathFile, 'utf8');
  // 模拟从图形界面启动的 AI 工具：PATH 里没有 node，也没有 TEAMLINK_HOME（启动脚本按自己的位置推）
  const bare = (extra: Record<string, string> = {}) => ({ HOME: dave.home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...extra });
  const probe = async (env: NodeJS.ProcessEnv) => /^node=(.*)$/m.exec((await run(launcher, ['--probe-node'], { env })).out)?.[1];
  try {
    assert.equal(await probe(bare()), saved.trim(), '平时用 node-path 里记的');
    const fake = join(tmp, 'fake-node');
    symlinkSync(process.execPath, fake);
    assert.equal(await probe(bare({ TEAMLINK_NODE: fake })), fake, 'TEAMLINK_NODE 优先');
    // node-path 指向一个已经删掉的文件
    const gone = join(tmp, 'gone-node');
    writeFileSync(gone, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(nodePathFile, `${gone}\n`);
    rmSync(gone);
    mkdirSync(join(dave.home, 'node/bin'), { recursive: true });
    symlinkSync(process.execPath, join(dave.home, 'node/bin/node'));
    assert.equal(await probe(bare()), join(dave.home, 'node/bin/node'), '回退到 $TEAMLINK_HOME/node/bin/node');
    const help = await run(launcher, ['help'], { env: bare() });
    assert.equal(help.code, 0, help.err);
    assert.match(help.out, /AI 常用/);
    rmSync(join(dave.home, 'node'), { recursive: true });
    const nodeDir = dirname(process.execPath);
    assert.equal(await probe(bare({ PATH: `${nodeDir}:/usr/bin:/bin` })), join(nodeDir, 'node'), '再回退到 PATH 里的 node');
    // 什么都找不到：hook 不输出、退出码 0，错误日志多一行
    const log = join(dave.home, 'hook-errors.log');
    const before = readText(log).split('\n').filter(Boolean).length;
    const nothing = await run('/bin/sh', ['-c', `"${launcher}" hook post-tool --tool codex`], { env: bare(), input: '{}' });
    assert.deepEqual([nothing.code, nothing.out, nothing.err], [0, '', '']);
    const lines = readText(log).split('\n').filter(Boolean);
    assert.equal(lines.length, before + 1);
    // macOS 的 /bin/sh 是 bash 3.2：UTF-8 环境下变量后面紧跟中文会被当成变量名的一部分，日志里的路径要完整
    assert.match(lines.at(-1) ?? '', new RegExp(`找不到 node（试过 TEAMLINK_NODE、${esc(dave.home)}/node-path、${esc(dave.home)}/node/bin/node、PATH），teamlink hook post-tool 没有运行$`));
    // 不是 hook 的命令（AI 在沙箱里用的 notify）：要让人知道没有运行
    const notify = await run(launcher, ['notify', '--to', 'bob', '--summary', 'x'], { env: bare() });
    assert.equal(notify.code, 1);
    assert.match(notify.err, /找不到 node/);
  } finally {
    writeFileSync(nodePathFile, saved);
    rmSync(join(dave.home, 'node'), { recursive: true, force: true });
  }
});

test('bin/teamlink.js 自己查 Node 版本（在加载 .ts 之前）：太旧时 hook 写一行错误日志、以 0 退出，其他命令打印错误、以 1 退出', async () => {
  // 本机没有旧版 Node：拷一份入口，把读到的版本号换成 22.1.0
  write(tmp, 'old-node-bin/teamlink.mjs', readFileSync(BIN, 'utf8').replace('process.versions.node', "'22.1.0'"));
  const fake = join(tmp, 'old-node-bin/teamlink.mjs');
  const home = join(tmp, 'home-old-node');
  const env = { HOME: home, PATH: '/usr/bin:/bin', TEAMLINK_HOME: home };
  const hookRun = await run(process.execPath, [fake, 'hook', 'post-tool', '--tool', 'codex'], { env, input: '{}' });
  assert.deepEqual([hookRun.code, hookRun.out, hookRun.err], [0, '', '']);
  assert.match(readText(join(home, 'hook-errors.log')), /teamlink 需要 Node\.js 23\.6 以上，现在用的是 v\d[^\n]*teamlink hook post-tool 没有运行/);
  const status = await run(process.execPath, [fake, 'status'], { env });
  assert.equal(status.code, 1);
  assert.match(status.err, /teamlink 需要 Node\.js 23\.6 以上/);
  const ok = await run(process.execPath, [BIN, 'help'], { env });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /人用/);
});

test('一键接入：curl | bash 装好连接器、写启动脚本、加入团队、关联仓库、装 Codex hook；装好的 hook 在几乎为空的环境里也能跑；重跑就是升级', async () => {
  fresh();
  const dir = join(tmp, 'erin');
  const home = join(tmp, 'home-erin');
  mkdirSync(home);
  sh(tmp, 'clone', '-q', remote, dir);
  sh(dir, 'config', 'user.email', 'erin@example.com');
  // 队友的电脑大多是 UTF-8 环境；macOS 自带的 bash 在这种环境下会把紧跟变量名的中文当成变量名的一部分
  const env = { HOME: home, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  const bashRun = (cmd: string) => run('bash', ['-c', cmd], { env, cwd: dir });
  const first = await bashRun(`curl -fsSL ${server.url}/install.sh | bash -s -- --invite ${engine.store.createInvite()} --name erin --handle erin`);
  assert.equal(first.code, 0, first.out + first.err);
  assert.match(first.out, /已以 erin 的身份加入/);
  assert.match(first.out, /运行 \/hooks，信任 teamlink 的 5 条 hook/);
  const tl = join(home, '.teamlink');
  assert.ok(readFileSync(join(tl, 'bin/teamlink'), 'utf8').includes(`\nAPP='${realpathSync(join(tl, 'app'))}'\n`), '启动脚本指向装好的那份连接器');
  assert.ok(existsSync(join(tl, 'node-path')));
  assert.equal(JSON.parse(readFileSync(join(dir, '.teamlink.json'), 'utf8')).repoId, repoId);
  const hooks = JSON.parse(readFileSync(join(dir, '.codex/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
  const post = hooks.hooks.PostToolUse[0].hooks[0].command as string;
  assert.equal(post, `"${join(tl, 'bin/teamlink')}" hook post-tool --tool codex`);
  assert.ok(engine.store.memberByName('erin'));
  // 装好的 hook 命令：模拟从图形界面启动的 Codex（PATH 里没有 node）
  const input = JSON.stringify({ session_id: 'erin-1', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const r = await run('/bin/sh', ['-c', post], { env: { HOME: home, PATH: '/usr/bin:/bin' }, input, cwd: dir });
  assert.equal(r.code, 0, r.err);
  // 7 天内谁都没开过工（fresh() 把会话都挪到了 8 天前）：没有队友行，只列出能点名的人
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, new RegExp(`^<team-notices-[0-9a-f]{8}>\\n${esc(HEADER)}\\n其他队友：alice、bob、carol、dave\\n</team-notices-[0-9a-f]{8}>$`));
  assert.ok(engine.store.session('codex:erin-1'), '第一次见到的会话按开工处理');
  // AI 在沙箱里用的 teamlink 命令也走启动脚本
  const notify = await run(join(tl, 'bin/teamlink'), ['notify', '--to', 'alice', '--summary', 'erin 用启动脚本发的'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, cwd: dir });
  assert.equal(notify.code, 0, notify.err);
  assert.match(notify.out, /^已发给 alice。/);
  // 重复运行就是升级：不重复加入，不重复改 PATH，hook 配置没变就不写，也不再让人去 Codex 里信任
  const again = await bashRun(`curl -fsSL ${server.url}/install.sh | bash -s --`);
  assert.equal(again.code, 0, again.out + again.err);
  assert.match(again.out, /已经以 erin 的身份加入过/);
  assert.match(again.out, /Codex：已是最新，没有改动/);
  assert.doesNotMatch(again.out, /最后一步|信任 teamlink 的 5 条/);
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8').match(/# teamlink/g)?.length, 1);
});

test('一键接入：bash 用户按登录 shell 的查找顺序写 PATH（只有 .profile 时写它，不新建 .bash_profile）；HOME 和安装路径带空格也行；路径按 shell 规则转义，里面的 $、反引号、引号原样保留，不会被当成命令', async () => {
  const home = join(tmp, 'home fay');
  write(home, '.profile', 'export FROM_PROFILE=yes\n');
  write(home, '.bashrc', 'export FROM_BASHRC=yes\n');
  // 装到一个带 $()、反引号、双引号、单引号和空格的目录里
  const tl = join(tmp, `tl-$(touch K5_RAN)-\`touch K5_TICK\`-"q"-'s' x`);
  const env = { HOME: home, SHELL: '/bin/bash', TEAMLINK_HOME: tl, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  const r = await run('bash', ['-c', `curl -fsSL ${server.url}/install.sh | bash -s --`], { env, cwd: home });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(!existsSync(join(home, '.bash_profile')), '不新建 .bash_profile（新建了就不再读 .profile）');
  for (const rc of ['.profile', '.bashrc']) assert.equal(readFileSync(join(home, rc), 'utf8').match(/# teamlink/g)?.length, 1, rc);
  // 登录 shell 照样读 .profile；交互 shell 读 .bashrc：PATH 最前面都是原样的路径
  const shell = (args: string[]) => run('env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', 'bash', ...args], { cwd: home });
  const login = await shell(['-lc', 'printf "%s\\n" "$FROM_PROFILE" "${PATH%%:*}"']);
  assert.deepEqual(login.out.split('\n').slice(0, 2), ['yes', join(tl, 'bin')], login.out + login.err);
  const rc = await shell(['-c', '. "$HOME/.bashrc"; printf "%s\\n" "$FROM_BASHRC" "${PATH%%:*}"']);
  assert.deepEqual(rc.out.split('\n').slice(0, 2), ['yes', join(tl, 'bin')], rc.out + rc.err);
  assert.equal(login.err + rc.err, '');
  for (const mark of ['K5_RAN', 'K5_TICK']) assert.ok(!existsSync(join(home, mark)), `${mark}：路径里的命令没有执行`);
});

test('安装脚本：服务器地址按访问地址填写，不合法的 Host 被拒绝；连接器包里不带 node_modules 和测试', async () => {
  const script = await (await fetch(`${server.url}/install.sh`)).text();
  assert.match(script, new RegExp(`SERVER="${esc(server.url)}"`));
  const port = new URL(server.url).port;
  const status = await new Promise<number>((ok) =>
    httpGet({ host: '127.0.0.1', port, path: '/install.sh', headers: { host: 'evil$(touch /tmp/x)' } }, (r) => {
      r.resume();
      ok(r.statusCode ?? 0);
    }),
  );
  assert.equal(status, 400);
  const tgz = join(tmp, 'teamlink.tar.gz');
  writeFileSync(tgz, Buffer.from(await (await fetch(`${server.url}/download/teamlink.tar.gz`)).arrayBuffer()));
  const list = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
  assert.match(list, /bin\/teamlink\.js/);
  assert.match(list, /src\/connector\/cli\.ts/);
  assert.match(list, /src\/server\/install\.sh/);
  assert.doesNotMatch(list, /node_modules|test\//);
});

// —— 18. status ——

test('status：打印身份、仓库关联、服务器和两边的协议版本、hook 装没装、启动脚本探测到的 node、hook 最近一次运行、发件箱、错误日志', async () => {
  const { dave } = devs;
  await hook(dave, 'post-tool', 'codex', { session_id: 'dave-status', ...bash('ls') });
  saveToOutbox(dave.dir, { repoId, tool: 'codex', sessionId: 'dave-status', type: 'message', summary: '还没补发的', to: ['bob'] });
  {
    const out = await as(dave, 'status');
    const expected = [
      /^本机身份：dave @ http:\/\/127\.0\.0\.1:\d+$/m,
      new RegExp(`^当前仓库：${esc(realpathSync(dave.dir))}，关联 ${repoId} @ http://127\\.0\\.0\\.1:\\d+$`, 'm'),
      /^服务器：能连上 http:\/\/127\.0\.0\.1:\d+，协议版本：服务器 2，本机 2$/m,
      /^ {2}身份：dave$/m,
      /^Claude Code 的 hook：5 条都装好了（.*settings\.local\.json）$/m,
      /^Codex 的 hook：5 条都装好了（.*hooks\.json）$/m,
      /^启动脚本：.*\/bin\/teamlink，从图形界面启动时用的 node 是 \/\S+（v\d+\.\d+\.\d+）$/m,
      /^Codex 的 hook 最近一次运行：\d{4}-\d\d-\d\d \d\d:\d\d:\d\d（post-tool，1 分钟前）$/m,
      /^Claude Code 的 hook 最近一次运行：/m,
      /^发件箱：1 条待补发，\.team\/outbox\/failed\/ 里 0 条被退回的$/m,
      /^hook 错误日志（.*hook-errors\.log）最后 [1-3] 行：$/m,
    ];
    for (const re of expected) assert.match(out, re);
    assert.doesNotMatch(out, /Codex 信任/);
  }
});

// —— 命令行 ——

test('命令行：帮助按“AI 常用”“人用”两组列出，不列删掉的命令和照收的旧参数', async () => {
  const help = await as(devs.alice, 'help');
  const ai = help.indexOf('\nAI 常用\n');
  const human = help.indexOf('\n人用\n');
  assert.ok(ai > 0 && human > ai, help);
  for (const c of ['notify', 'ask', 'reply']) assert.match(help.slice(ai, human), new RegExp(`\\n {2}teamlink ${c} `), c);
  for (const c of ['setup', 'join', 'link', 'install', 'inbox', 'status']) assert.match(help.slice(human), new RegExp(`\\n {2}teamlink ${c}\\b`), c);
  assert.doesNotMatch(help, /teamlink (mcp|approvals|approve|reject|alerts|ack|subscribe|sync|token|hook|team)\b|--type|--email|--handle|--generic|--mcp/);
  assert.equal(await as(devs.alice, '--help'), help);
  const unknown = await cli(devs.alice, 'approvals');
  assert.equal(unknown.code, 1, '删掉的命令');
  assert.match(unknown.out, /AI 常用/);
  assert.match(await fails(devs.alice, 'notify', '--to', 'bob', '--summary', 'x', '--bogus'), /不认识的参数 --bogus/);
  assert.match(await fails(devs.alice, 'notify', '--to', 'bob', '--sumary', 'x'), /不认识的参数 --sumary\n用法：teamlink notify /);
  // 值写错（比如说明以“- ”开头列几点）不是参数名写错：照原文报，原文里写了 --summary=… 的写法，后面照样附用法
  const dash = await fails(devs.alice, 'notify', '--to', 'bob', '--summary', '- 改了 compare 的返回字段\n- 新增 diff 字段');
  assert.match(dash, /--summary=/);
  assert.doesNotMatch(dash, /不认识的参数/);
  assert.match(dash, /\n用法：teamlink notify /);
});
