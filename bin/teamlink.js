#!/usr/bin/env node
// teamlink 命令行入口。先查 Node 版本：teamlink 直接运行 .ts，太旧的 Node 连代码都加载不了，所以这里不能静态 import。
// 启动脚本（$TEAMLINK_HOME/bin/teamlink）不查版本，由这里查。
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 23 || (major === 23 && minor < 6)) {
  const msg = `teamlink 需要 Node.js 23.6 以上，现在用的是 ${process.version}（${process.execPath}）`;
  const home = process.env.TEAMLINK_HOME || join(homedir(), '.teamlink');
  if (process.argv[2] === 'hook') {
    // hook 不能打断 AI：只在 hook-errors.log 记一行，以 0 退出
    try {
      mkdirSync(home, { recursive: true });
      appendFileSync(join(home, 'hook-errors.log'), `${new Date().toISOString()} ${msg}，teamlink hook ${process.argv[3] ?? ''} 没有运行\n`);
    } catch {
      // 连日志都写不了就算了
    }
    process.exit(0);
  }
  console.error(`${msg}。重新运行安装脚本，或者把新版 node 的路径写进 ${join(home, 'node-path')}。`);
  process.exit(1);
}

const { runCli } = await import('../src/connector/cli.ts');
runCli(process.argv.slice(2)).then(
  // 等 stdout 写完再退出：hook 的输出写进管道是异步的，直接 exit 可能截断
  (code) => process.stdout.write('', () => process.exit(code ?? 0)),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
