// teamlink-server stats：团队的问答做得怎么样。只在服务器上运行（管理命令），接口里没有。
// 看的是“可衡量”的那几样：问了有没有人答、多久答、答的依据硬不硬、知识集中在谁那里、同一个问题是不是被问了好几次。
// 最后一样是团队事实有没有起作用的直接证据：记下来以后，同样的问题应该越来越少。
// 只统计消息的元数据；唯一用到正文的是“可能重复的提问”（列出问题的摘录，方便管理员决定该记哪条）。

import { excerpt } from '../shared/render.ts';
import { grams, similarity } from '../shared/similar.ts';
import { SYSTEM_SENDER, type RepoRow, type Store } from './db.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** 超过这么久还没人回答的提问，单独列出来。 */
const STALE_MS = DAY;
/** 两个提问的相似度到这个数就算“可能是同一个问题”。 */
const REPEAT_SIMILARITY = 0.5;
const LIST_MAX = 5;

export type BasisKey = 'person' | 'confirmed' | 'checked' | 'guess' | 'none';
const BASIS_NAMES: Record<BasisKey, string> = { person: '本人写的', confirmed: '本人确认', checked: '查证过', guess: '推测', none: '没写' };

export interface RepoStats {
  repo: RepoRow;
  since: string;
  until: string;
  questions: number;
  answered: number;
  /** 提问到第一条回答的时间，中位数（毫秒）；没有回答过的为 null。 */
  answerMedianMs: number | null;
  /** 超过一天还没人回答的提问有几条，和最早的几条。 */
  unansweredCount: number;
  unanswered: { asker: string; to: string[]; summary: string; ageMs: number }[];
  /** 回答按依据分。 */
  basis: Record<BasisKey, number>;
  messages: number;
  /** 从发出到对方的 AI 拿到（确认送到）的时间，中位数（毫秒）。 */
  deliveryMedianMs: number | null;
  /** 重发过的收件记录（交出去以后没确认、又交了一次）。 */
  resent: number;
  /** 被问得最多的人。 */
  askedMost: { name: string; count: number }[];
  /** 可能是同一个问题、被问了不止一次的几组。 */
  repeated: { summary: string; count: number; askers: string[] }[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 一段时长：N 秒、N 分钟、N 小时、N 天。 */
export function durationText(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))} 秒`;
  if (ms < 60 * MINUTE) return `${Math.round(ms / MINUTE)} 分钟`;
  if (ms < DAY) return `${Math.round(ms / (60 * MINUTE))} 小时`;
  return `${Math.round(ms / DAY)} 天`;
}

const parseNames = (v: string) => {
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) ? x.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
};

/** 把相似的提问并成组（并查集），返回两条以上的组，问得多的在前。 */
function repeatedQuestions(qs: { summary: string; asker: string }[]): RepoStats['repeated'] {
  const g = qs.map((q) => grams(q.summary));
  const parent = qs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < qs.length; i++) {
    for (let j = i + 1; j < qs.length; j++) if (similarity(g[i], g[j]) >= REPEAT_SIMILARITY) parent[find(j)] = find(i);
  }
  const groups = new Map<number, number[]>();
  qs.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  return [...groups.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ({ summary: qs[ids[0]].summary, count: ids.length, askers: [...new Set(ids.map((i) => qs[i].asker))] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, LIST_MAX);
}

/** 一个仓库最近 days 天的统计。 */
export function repoStats(store: Store, repo: RepoRow, days: number): RepoStats {
  const nowMs = store.clock();
  const since = store.now(-days * DAY);
  const until = store.now();
  const name = (id: string, n: string | null) => (id === SYSTEM_SENDER ? 'teamlink 服务器' : (n ?? '已移出团队的成员'));

  const questions = store
    .all<{ id: string; summary: string; created_at: string; sender_member_id: string; asker: string | null; to_names: string }>(
      `SELECT n.id, n.summary, n.created_at, n.sender_member_id, m.name AS asker, n.to_names FROM notices n
       LEFT JOIN members m ON m.id = n.sender_member_id
       WHERE n.repo_id = ? AND n.type = 'question' AND n.created_at >= ? ORDER BY n.created_at, n.rowid`,
      repo.id,
      since,
    )
    .map((q) => ({ ...q, asker: name(q.sender_member_id, q.asker) }));
  const firstAnswer = new Map(
    store
      .all<{ reply_to: string; first: string }>("SELECT reply_to, MIN(created_at) AS first FROM notices WHERE repo_id = ? AND type = 'answer' GROUP BY reply_to", repo.id)
      .map((r) => [r.reply_to, r.first]),
  );
  const answerTimes: number[] = [];
  const unanswered: RepoStats['unanswered'] = [];
  for (const q of questions) {
    const first = firstAnswer.get(q.id);
    if (first) answerTimes.push(Date.parse(first) - Date.parse(q.created_at));
    else if (nowMs - Date.parse(q.created_at) >= STALE_MS) unanswered.push({ asker: q.asker, to: parseNames(q.to_names), summary: q.summary, ageMs: nowMs - Date.parse(q.created_at) });
  }

  const basis: Record<BasisKey, number> = { person: 0, confirmed: 0, checked: 0, guess: 0, none: 0 };
  for (const r of store.all<{ via: string | null; basis: string | null; c: number }>(
    "SELECT via, basis, COUNT(*) AS c FROM notices WHERE repo_id = ? AND type = 'answer' AND created_at >= ? GROUP BY via, basis",
    repo.id,
    since,
  )) {
    const key: BasisKey = r.basis === 'guess' ? 'guess' : r.via === 'person' ? 'person' : r.basis === 'confirmed' || r.basis === 'checked' ? r.basis : 'none';
    basis[key] += r.c;
  }

  const messages =
    store.get<{ c: number }>("SELECT COUNT(*) AS c FROM notices WHERE repo_id = ? AND type = 'message' AND created_at >= ? AND sender_member_id != ?", repo.id, since, SYSTEM_SENDER)?.c ?? 0;
  const deliveries = store.all<{ created_at: string; acked_at: string | null; attempts: number }>(
    `SELECT n.created_at, r.acked_at, r.attempts FROM recipients r JOIN notices n ON n.id = r.notice_id
     WHERE n.repo_id = ? AND n.created_at >= ? AND n.sender_member_id != ?`,
    repo.id,
    since,
    SYSTEM_SENDER,
  );
  const askedMost = store
    .all<{ name: string; count: number }>(
    `SELECT m.name AS name, COUNT(*) AS count FROM recipients r JOIN notices n ON n.id = r.notice_id JOIN members m ON m.id = r.member_id
     WHERE n.repo_id = ? AND n.type = 'question' AND n.created_at >= ? GROUP BY r.member_id ORDER BY count DESC, m.name LIMIT ?`,
      repo.id,
      since,
      LIST_MAX,
    )
    .map((r) => ({ name: r.name, count: r.count }));

  return {
    repo,
    since,
    until,
    questions: questions.length,
    answered: answerTimes.length,
    answerMedianMs: median(answerTimes),
    unansweredCount: unanswered.length,
    unanswered: unanswered.slice(0, LIST_MAX),
    basis,
    messages,
    deliveryMedianMs: median(deliveries.filter((d) => d.acked_at).map((d) => Date.parse(d.acked_at as string) - Date.parse(d.created_at))),
    resent: deliveries.filter((d) => d.attempts > 1).length,
    askedMost,
    repeated: repeatedQuestions(questions),
  };
}

/** 打印给管理员看的文字。 */
export function renderStats(s: RepoStats, days: number): string {
  const lines = [`仓库 ${s.repo.url}（${s.repo.id}），最近 ${days} 天（${s.since.slice(0, 10)} 到 ${s.until.slice(0, 10)}）`];
  if (s.questions === 0 && s.messages === 0) return [...lines, '  没有提问，也没有消息。'].join('\n');
  const pct = (n: number, d: number) => (d === 0 ? '' : `（${Math.round((100 * n) / d)}%）`);
  lines.push(
    s.questions === 0
      ? '  提问 0 条'
      : `  提问 ${s.questions} 条：已回答 ${s.answered} 条${pct(s.answered, s.questions)}${s.answerMedianMs === null ? '' : `，回答用时中位数 ${durationText(s.answerMedianMs)}`}`,
  );
  if (s.unanswered.length > 0) {
    lines.push(`  超过 1 天没人回答的提问 ${s.unansweredCount} 条${s.unansweredCount > s.unanswered.length ? `，最早的 ${s.unanswered.length} 条` : ''}：`);
    for (const u of s.unanswered) lines.push(`    - ${u.asker} 问 ${u.to.join('、') || '（收件人已移出）'}，${durationText(u.ageMs)}前：${excerpt(u.summary, 40)}`);
  }
  const answers = Object.values(s.basis).reduce((a, b) => a + b, 0);
  if (answers > 0) {
    const parts = (Object.keys(BASIS_NAMES) as BasisKey[]).filter((k) => s.basis[k] > 0).map((k) => `${BASIS_NAMES[k]} ${s.basis[k]}`);
    const soft = s.basis.guess + s.basis.none;
    lines.push(`  回答的依据：${parts.join('、')}${soft > 0 ? `（推测和没写的占 ${Math.round((100 * soft) / answers)}%，这部分不能当成对方确认过的）` : ''}`);
  }
  lines.push(
    `  消息 ${s.messages} 条${s.deliveryMedianMs === null ? '' : `；送达用时中位数 ${durationText(s.deliveryMedianMs)}（从发出到对方的 AI 拿到，对方不在线时要等他开工）`}${s.resent > 0 ? `；重发过 ${s.resent} 次` : ''}`,
  );
  if (s.askedMost.length > 0) {
    lines.push(`  被问得最多：${s.askedMost.map((a) => `${a.name} ${a.count} 次`).join('、')}。只有他们知道的事最多，他们的回答最值得记进团队事实`);
  }
  if (s.repeated.length > 0) {
    lines.push(`  可能重复的提问 ${s.repeated.length} 组（同一个问题问了不止一次，答案该记进团队事实）：`);
    for (const r of s.repeated) lines.push(`    - 「${excerpt(r.summary, 40)}」${r.count} 次（${r.askers.join('、')} 问的）`);
  }
  return lines.join('\n');
}
