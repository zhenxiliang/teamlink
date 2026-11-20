// 团队事实：队友之间问出来的、长期有效的事实（限额、口径、错误码、环境约定），记进仓库里的 docs/team-facts/。
//
// 为什么记在仓库里、不记在服务器上：
// - 跟着改动一起提交，经过 PR 审查才进主干：AI 记错的、过期的，有人把关；
// - 合并以后谁的 AI 都能直接读到，不需要 teamlink，也不用联网；服务器照旧不读仓库，消息照旧 30 天删掉。
// 为什么一条一个文件、文件名就是主题：
// - 几个人的 AI 在各自的分支上同时记，互不冲突；同一个主题再记一次就是更正，原来的内容挪到“以前”；
// - ls 一下就是目录，grep 一下就能搜。
// 只收本人写的、本人确认的、查证过的：推测进了团队事实，之后每个 AI 都会把它当真。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Basis, NoticeItem } from '../shared/protocol.ts';
import { BASIS_LABEL, MAX_SUMMARY_CHARS } from '../shared/protocol.ts';
import { excerpt, LINE_BREAKS, normalizeText } from '../shared/render.ts';
import { reviewFact } from '../shared/review.ts';
import { coverage, grams, similarity } from '../shared/similar.ts';

export const FACTS_DIR = 'docs/team-facts';
const README = 'README.md';
export const MAX_TITLE_CHARS = 40;
export const MAX_FACT_CHARS = MAX_SUMMARY_CHARS;
/** 更正时原来的内容挪到“以前”，最多留这么多条（再早的看 git 历史）。 */
const MAX_HISTORY = 3;
/** 文件末尾的几行出处；正文里恰好以这样开头的行会被改写，免得读回来时被当成出处。 */
const META = /^- (依据|来源|记录|以前)：(.*)$/;

/** 团队事实的依据：本人写的（对方本人在终端里写的），或者回答时的依据。 */
export type FactBasis = 'person' | Basis;
export const FACT_BASIS_LABEL: Record<FactBasis, string> = { person: '本人写的', ...BASIS_LABEL };

export interface Fact {
  title: string;
  body: string;
  /** 依据的文字（本人写的、本人确认、查证过；手写的文件可能是空串）。 */
  basis: string;
  /** 来源：谁说的，什么时候，哪条消息。 */
  source: string;
  /** 记录：谁记的，哪天。 */
  recorded: string;
  /** 更正以前的内容，新的在前。 */
  history: string[];
  /** 相对仓库根目录的路径。 */
  file: string;
}

const README_TEXT = `# 团队事实

这里每个文件是一条团队事实：队友之间问出来的、长期有效、读代码读不到的事实（限额、口径、错误码、环境约定）。
文件名就是主题，正文是事实，最后几行是出处：依据（本人写的、本人确认、查证过）、来源（谁说的、哪条消息）、谁记的。

- AI 问队友之前先查这里（\`teamlink facts 关键词\`），有了就不用问。
- 用 \`teamlink fact "主题" --from 通知号\` 记，跟着改动一起提交、一起审查。推测不记，临时进度不记，代码里读得到的不记。
- 同一个主题再记一次就是更正，原来的内容挪到“以前”。过期了直接删掉文件（git 里有历史）。可以直接编辑。
`;

const today = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 主题当文件名：去掉路径和 shell 里麻烦的字符，空白换成 -。 */
export function factFileName(title: string): string {
  const name = normalizeText(title, true)
    .trim()
    .replace(/[/\\:*?"<>|#%`$'!&;(){}[\]]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|-+$/g, '');
  return [...name].slice(0, 60).join('');
}

/** 主题的规矩：合格返回 null，否则返回原因。 */
export function factTitleError(title: string): string | null {
  const t = title.trim();
  if (!t) return '主题不能为空：写一个短语，比如“交易所下单限额”';
  if (/[\r\n]/.test(title.replace(LINE_BREAKS, '\n'))) return '主题只能写一行';
  if ([...t].length > MAX_TITLE_CHARS) return `主题最长 ${MAX_TITLE_CHARS} 个字，写成一个短语，细节放进事实里`;
  const file = factFileName(t);
  if (!file) return '主题里要有文字';
  if (file.toLowerCase() === 'readme') return '主题不能叫 README';
  return null;
}

/** 正文规整：去掉控制字符和边界标签，保留换行；碰巧像出处的行改写一下。 */
function cleanBody(body: string): string {
  return body
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((line) => normalizeText(line, true).trimEnd())
    .map((line) => (META.test(line) ? line.replace(/^- /, '• ') : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 读一个事实文件：第一行 # 主题，最后一段是出处，中间是正文。手写的、没有出处的也能读。 */
export function parseFact(text: string, file: string): Fact {
  const lines = text.replace(/\r\n|\r/g, '\n').trimEnd().split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  const title = first >= 0 && lines[first].startsWith('# ') ? lines[first].slice(2).trim() : '';
  let end = lines.length;
  while (end > 0 && META.test(lines[end - 1])) end--;
  const meta = lines.slice(end).map((l) => META.exec(l) as RegExpExecArray);
  const field = (k: string) => meta.find((m) => m[1] === k)?.[2].trim() ?? '';
  const body = lines
    .slice(title ? first + 1 : 0, end)
    .join('\n')
    .trim();
  return {
    title: title || file.replace(/^.*\//, '').replace(/\.md$/, ''),
    body,
    basis: field('依据'),
    source: field('来源'),
    recorded: field('记录'),
    history: meta.filter((m) => m[1] === '以前').map((m) => m[2].trim()),
    file,
  };
}

export function renderFact(f: Omit<Fact, 'file'>): string {
  const meta = [`- 依据：${f.basis}`, `- 来源：${f.source}`, `- 记录：${f.recorded}`, ...f.history.map((h) => `- 以前：${h}`)];
  return `# ${f.title}\n\n${f.body}\n\n${meta.join('\n')}\n`;
}

export interface FactInput {
  title: string;
  /** 事实本身；不写就用 from 那条消息的原文。 */
  body?: string;
  /** 从哪条消息记的（回答或者消息）。 */
  from?: NoticeItem | null;
  /** 显式写的依据；不写就用 from 的（本人写的、回答时的依据）。 */
  basis?: Basis;
  /** 记录人（本机的成员名）。 */
  recorder: string;
  now?: Date;
}

export interface Recorded {
  action: 'created' | 'updated' | 'unchanged';
  fact: Fact;
}

/** 这条消息算不算本人写的、回答时写了什么依据。 */
function basisOf(input: FactInput): FactBasis | null {
  if (input.basis) return input.basis;
  if (input.from?.via === 'person' && input.from.basis !== 'guess') return 'person';
  return input.from?.basis ?? null;
}

/** 记一条团队事实，返回做了什么。内容不合规矩时抛错，文件不动。 */
export function recordFact(root: string, input: FactInput): Recorded {
  const titleWhy = factTitleError(input.title);
  if (titleWhy) throw new Error(titleWhy);
  const title = normalizeText(input.title, true).trim();
  const from = input.from ?? null;
  if (from && from.type === 'question') throw new Error(`${from.id} 是别人问你的提问，不是事实：--from 写回答号、消息号，或者你自己问过的提问号（记的是它最新的一条回答）`);
  const body = cleanBody(input.body?.trim() ? input.body : (from?.summary ?? ''));
  if (!body) throw new Error('缺少事实内容：写在主题后面，或者用 --from 通知号 取那条回答的原文');
  const length = [...body].length;
  if (length > MAX_FACT_CHARS) throw new Error(`事实最多 ${MAX_FACT_CHARS} 字，这条有 ${length} 字：只写结论，来龙去脉留在代码和提交说明里`);

  const basis = basisOf(input);
  if (basis === 'guess') throw new Error('推测不进团队事实：先找对方本人确认，或者自己查证以后再记（加 --basis 本人确认 或 查证过）');
  if (!basis) throw new Error(`不知道依据：加 --basis 本人确认（你的用户亲口说的）或 查证过（你在本机或系统里查到的）${from ? `。${from.id} 回答时没写依据` : ''}`);

  const reasons = reviewFact([title, body]);
  if (reasons.length > 0) throw new Error(`没有记：里面有${reasons.join('、')}。团队事实会提交进仓库、之后每个 AI 都会读，这类内容不能放进去`);

  const now = input.now ?? new Date();
  const source = from
    ? [
        normalizeText(from.sender, true),
        from.createdAt.slice(0, 10),
        from.type === 'answer' && from.replyTo
          ? `回答提问${from.replyTo.question ? `「${excerpt(from.replyTo.question, 30)}」` : ''}（${normalizeText(from.replyTo.id, true)}）`
          : `消息（${normalizeText(from.id, true)}）`,
      ].join('，')
    : `${normalizeText(input.recorder, true)}，${today(now)}`;
  const dir = join(root, FACTS_DIR);
  const file = `${FACTS_DIR}/${factFileName(title)}.md`;
  const path = join(root, file);
  const next: Omit<Fact, 'file'> = { title, body, basis: FACT_BASIS_LABEL[basis], source, recorded: `${normalizeText(input.recorder, true)}，${today(now)}`, history: [] };

  let action: Recorded['action'] = 'created';
  if (existsSync(path)) {
    const old = parseFact(readFileSync(path, 'utf8'), file);
    if (old.body === body) return { action: 'unchanged', fact: old };
    action = 'updated';
    const was = `${excerpt(old.body, 60)}（${[old.basis, old.source.split('，').slice(0, 2).join('，')].filter(Boolean).join('，')}）`;
    next.history = [was, ...old.history].slice(0, MAX_HISTORY);
  }
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, README))) writeFileSync(join(dir, README), README_TEXT);
  writeFileSync(path, renderFact(next));
  return { action, fact: { ...next, file } };
}

/** 仓库里全部团队事实，按主题排序。 */
export function loadFacts(root: string): Fact[] {
  const dir = join(root, FACTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== README)
    .map((f) => parseFact(readFileSync(join(dir, f), 'utf8'), `${FACTS_DIR}/${f}`))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh'));
}

/** 列表里的一行：主题、摘录、依据 · 谁说的 · 哪天记的。 */
export function factLine(f: Fact): string {
  const who = f.source.split('，')[0];
  const day = f.recorded.split('，')[1] ?? '';
  const meta = [f.basis, who, day].filter(Boolean).join(' · ');
  const name = `${FACTS_DIR}/${factFileName(f.title)}.md` === f.file ? '' : `（${f.file}）`;
  return `- ${normalizeText(f.title, true)}${name}：${excerpt(f.body, 80)}${meta ? `（${meta}）` : ''}`;
}

/** 主题有多像在问这个问题：主题的特征有多少出现在问题里。主题太短（不到 2 个特征）的不算，免得一个词就挡住提问。 */
function titleMatch(f: Fact, question: Set<string>): number {
  const t = grams(f.title);
  return t.size >= 2 ? coverage(t, question) : 0;
}

/** ask 之前查：主题几乎都出现在问题里的团队事实，最像的在前，最多 3 条。 */
export function relatedFacts(root: string, question: string, threshold = 0.75): Fact[] {
  const q = grams(question);
  return loadFacts(root)
    .map((f) => ({ f, score: titleMatch(f, q) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.f);
}

/**
 * teamlink facts 关键词：先按字面找（每个关键词都要出现在主题或正文里，不分大小写）；
 * 一条都没有时，再按意思相近找（AI 常把整句问题当关键词），并说明是“可能相关”。
 */
export function searchFacts(root: string, keywords: string[]): { exact: boolean; facts: Fact[] } {
  const all = loadFacts(root);
  const words = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) return { exact: true, facts: all };
  const hay = (f: Fact) => `${f.title}\n${f.body}`.toLowerCase();
  const exact = all.filter((f) => words.every((w) => hay(f).includes(w)));
  if (exact.length > 0) return { exact: true, facts: exact };
  const q = grams(words.join(' '));
  const close = all
    .map((f) => ({ f, score: Math.max(titleMatch(f, q), similarity(q, `${f.title} ${f.body}`)) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.f);
  return { exact: false, facts: close };
}
