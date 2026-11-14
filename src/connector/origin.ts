// 这条命令是谁在运行：AI 会话里的 AI，还是本人在终端里。发消息时报给服务器，对方看到的发送人后面据此标“（本人写的）”。
// 判断宁可保守：拿不准一律算 AI。把本人写的标成 AI 发的没什么损失；反过来，AI 的推测就会被对方当成本人确认过的。

import type { NoticeVia } from '../shared/protocol.ts';

/** AI 工具启动的命令带着这些环境变量（Claude Code：CLAUDECODE 等；Codex：CODEX_THREAD_ID、沙箱相关的几个）。 */
const AI_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_CI',
  'AI_AGENT',
];

/** 没有 AI 工具的环境变量、标准输入和输出又都是终端，才算本人写的。 */
export function originOf(env: NodeJS.ProcessEnv = process.env, tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)): NoticeVia {
  if (AI_ENV.some((k) => env[k])) return 'ai';
  return tty ? 'person' : 'ai';
}
