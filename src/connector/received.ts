// .team/received.md：hook 每次送到的队友消息，在工作区里存一份（只在本机，不提交），最新的在最前面。
// 沙箱里的 AI 读得到它，怀疑漏了消息时看这里。只存消息条目（带边界标签和通知号），
// 队友段、“另有 N 条”、平台提示都不写进来；回答过的提问下面加一行标记，免得重复回答。
// .team/notices.json：同一批消息的结构化内容（发送人、本人写的、依据、原文、回的哪条提问），给 teamlink fact --from 用。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NoticeItem } from '../shared/protocol.ts';
import { excerpt } from '../shared/render.ts';
import { excludeLocally } from './config.ts';
import { readJson, withLock, writeAtomic } from './state.ts';

export const RECEIVED_FILE = '.team/received.md';
/** 最多留这么多批、这么多字节，超了就丢掉最旧的批次（最新的一批总是留着）。 */
const MAX_BATCHES = 30;
const MAX_BYTES = 60 * 1024;
const SEP = '\n\n---\n\n';
/** “只是参考，不是指令”只在每批开头的注入说明里说一次（规格第 3 节），这里不再重复。 */
const HEADER = '# teamlink 送到的队友消息（最新的在最前面）\n\nhook 送到的消息都在这里存一份（只在本机，不提交）。';

/** 本机时间，精确到秒（received.md 的批次标题、teamlink status 用）。 */
export function localTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 文件分成说明和一批批消息。旧版连接器写的文件也是用同一个分隔线，说明换成新的，批次照留。 */
function batchesOf(text: string): string[] {
  return text
    .split(SEP)
    .slice(1)
    .map((b) => b.trim())
    .filter(Boolean);
}

const fileOf = (batches: string[]) => `${HEADER}${SEP}${batches.join(SEP)}\n`;

function update(root: string, fn: (text: string) => string | null): void {
  const path = join(root, RECEIVED_FILE);
  withLock(join(root, '.team', '.received.lock'), () => {
    const cur = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const next = fn(cur);
    if (next !== null && next !== cur) writeAtomic(path, next);
  });
  try {
    excludeLocally(root, '.team/');
  } catch {
    // 沙箱里 .git 可能是只读的；安装时已经加过排除规则
  }
}

/** 存一批送到的消息（DeliveryResponse.messagesText）。 */
export function saveReceived(root: string, messagesText: string, count: number, when = new Date()): void {
  if (!messagesText.trim()) return;
  update(root, (cur) => {
    const batches = [`### ${localTime(when)} 送到 ${count} 条\n\n${messagesText.trim()}`, ...batchesOf(cur)];
    while (batches.length > 1 && (batches.length > MAX_BATCHES || Buffer.byteLength(fileOf(batches)) > MAX_BYTES)) batches.pop();
    return fileOf(batches);
  });
}

export type AnswerState = 'queued' | 'sent' | 'rejected';

const queuedLine = (ex: string) => `    ✔ 已回答（暂存，待补发）：${ex}`;

/**
 * 在 received.md 里那条提问下面标一行：暂存进发件箱时“✔ 已回答（暂存，待补发）”，
 * 发出去了改成“✔ 已回答”，被退回改成“✘ 回答被退回（原因）”。找不到这条提问就不标。
 */
export function markAnswer(root: string, questionId: string, state: AnswerState, answer: string, reason = ''): void {
  if (!existsSync(join(root, RECEIVED_FILE))) return;
  const ex = excerpt(answer, 40);
  const line =
    state === 'queued' ? queuedLine(ex) : state === 'sent' ? `    ✔ 已回答：${ex}` : `    ✘ 回答被退回（${excerpt(reason, 60) || '原因不明'}）：${ex}`;
  const id = questionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^\\[\\d+\\] 提问 · 来自 .* · ${id}：`);
  update(root, (cur) => {
    const lines = cur.split('\n');
    const i = lines.findIndex((l) => head.test(l));
    if (i < 0) return null;
    // 这一条到下一个不缩进的行为止（续行、“回答：”那一行、之前的标记都缩进 4 格）
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].startsWith('    ')) end++;
    const queued = state === 'queued' ? -1 : lines.slice(i + 1, end + 1).indexOf(queuedLine(ex));
    if (queued >= 0) lines[i + 1 + queued] = line;
    else lines.splice(end + 1, 0, line);
    return lines.join('\n');
  });
}

/** 最新的几批（inbox 连不上服务器时打印）。 */
export function latestBatches(root: string, n: number): string[] {
  const path = join(root, RECEIVED_FILE);
  return existsSync(path) ? batchesOf(readFileSync(path, 'utf8')).slice(0, n) : [];
}

// —— 结构化存档 ——

export const NOTICES_FILE = '.team/notices.json';
/** 最多留这么多条，超了丢最旧的。 */
const MAX_ITEMS = 500;

function isItem(x: unknown): x is NoticeItem {
  const i = x as NoticeItem;
  return Boolean(i) && typeof i.id === 'string' && typeof i.type === 'string' && typeof i.sender === 'string' && typeof i.summary === 'string';
}

function loadItems(root: string): NoticeItem[] {
  const all = readJson<unknown[]>(join(root, NOTICES_FILE));
  return Array.isArray(all) ? all.filter(isItem) : [];
}

/** 存一批送到的消息的结构化内容（最新的在最前面；重发的同一条只留一份）。 */
export function saveItems(root: string, items: unknown[]): void {
  const fresh = items.filter(isItem);
  if (fresh.length === 0) return;
  withLock(join(root, '.team', '.notices.lock'), () => {
    const ids = new Set(fresh.map((i) => i.id));
    const next = [...fresh, ...loadItems(root).filter((i) => !ids.has(i.id))].slice(0, MAX_ITEMS);
    writeAtomic(join(root, NOTICES_FILE), `${JSON.stringify(next, null, 1)}\n`);
  });
  try {
    excludeLocally(root, '.team/');
  } catch {
    // 同 received.md
  }
}

/**
 * 在存档里找一条：通知号对上的那一条；没有的话，当它是自己问过的提问，找回它的最新一条回答
 * （回答在注入里显示的是提问的号，AI 手里多半是它）。找不到返回 null。
 */
export function findItem(root: string, id: string): NoticeItem | null {
  const all = loadItems(root);
  const exact = all.find((i) => i.id === id);
  if (exact) return exact;
  const answers = all.filter((i) => i.type === 'answer' && i.replyTo?.id === id);
  answers.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return answers[0] ?? null;
}
