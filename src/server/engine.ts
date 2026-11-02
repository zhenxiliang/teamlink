// 核心流程：发消息（校验、审核、入库，只发给发送方点名的人），按成员排队；
// hook 请求时在同一个同步调用、同一个事务里选条目、渲染整段注入文字、记送达。服务器不读仓库。

import { createPublicKey } from 'node:crypto';
import type {
  Claim,
  DeliveryResponse,
  InboxResponse,
  JoinResponse,
  NoticeType,
  Presence,
  SendResponse,
  SessionRef,
  Teammate,
  Tool,
} from '../shared/protocol.ts';
import { claimError, INJECTION_BUDGET_BYTES, MAX_CLAIMS, MAX_SUMMARY_CHARS, memberNameError } from '../shared/protocol.ts';
import { normalizeText, renderBatch, type RenderItem } from '../shared/render.ts';
import { DEFAULT_POLICY, type Policy } from '../shared/rules.ts';
import { newId, type MemberRow, type Notice, type QueuedNotice, type RepoRow, type Store } from './db.ts';
import { loadPolicy } from './policy.ts';
import { rejectionMessage, reviewMessage } from './review.ts';

const DAY = 24 * 3600_000;
/** 开工时列 7 天内有过会话的队友，最多 8 人。 */
const TEAMMATE_WINDOW_MS = 7 * DAY;
const MAX_TEAMMATES = 8;
/** inbox --all 看最近 7 天。 */
const INBOX_WINDOW_MS = 7 * DAY;

export interface EngineConfig {
  dataDir: string;
  /** 会话没结束、并且这么久之内有活动，就算在线。 */
  onlineWindowMs: number;
  /** 每个会话（没有会话时按成员）在 sendWindowMs 内最多发几条：防失控的兜底。 */
  sendLimit: number;
  sendWindowMs: number;
  /** 一次注入最多多少字节（UTF-8）。 */
  budgetBytes: number;
  /** 会话和通知保留多少天。 */
  retentionDays: number;
  /** 服务器事件（以前的审计表）和错误写到哪里，默认 stderr。 */
  log: (line: string) => void;
}

export const DEFAULT_CONFIG: Omit<EngineConfig, 'dataDir'> = {
  onlineWindowMs: 30 * 60_000,
  sendLimit: 30,
  sendWindowMs: 10 * 60_000,
  budgetBytes: INJECTION_BUDGET_BYTES,
  retentionDays: 30,
  log: (line) => process.stderr.write(`${line}\n`),
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 送达类请求：开工、prompt 和 post-tool、收尾检查。 */
export interface DeliverInput extends SessionRef {
  kind: 'start' | 'activity' | 'stop';
}

/** 发消息的输入（接口层只做类型上的整理，规则都在这里查）。 */
export interface SendInput {
  repoId: string;
  /** 发送方的会话“工具:会话号”，用于每会话的发送限流。 */
  sessionKey: string | null;
  type?: unknown;
  summary?: unknown;
  claims?: unknown;
  to: string[];
  replyTo: string | null;
  clientId: string | null;
}

const toItem = (n: QueuedNotice): RenderItem => ({
  id: n.id,
  type: n.type,
  sender: n.sender_name ?? '未知成员',
  summary: n.summary,
  claims: n.claims,
  replyTo: n.reply_to ? { id: n.reply_to, question: n.question ?? '' } : null,
});

export class Engine {
  readonly store: Store;
  readonly config: EngineConfig;

  constructor(store: Store, config: EngineConfig) {
    this.store = store;
    this.config = config;
  }

  /** 记一行服务器事件（以前写进审计表，现在打到 stderr）。 */
  event(kind: string, data: Record<string, unknown>): void {
    this.config.log(`${this.store.now()} ${kind} ${JSON.stringify(data)}`);
  }

  /** 每次请求时读，管理员改了立即生效；policy.json 坏了就按默认策略，并记一行。 */
  policy(): Policy {
    try {
      return loadPolicy(this.config.dataDir);
    } catch (e) {
      this.event('policy_unreadable', { error: String(e) });
      return { ...DEFAULT_POLICY, allowDomains: [...DEFAULT_POLICY.allowDomains] };
    }
  }

  requireRepo(repoId: string): RepoRow {
    const repo = this.store.repo(repoId);
    if (!repo) throw new ApiError(404, `没有这个仓库：${repoId}`);
    return repo;
  }

  /** 登记仓库（只登记，不 clone）；同一个地址登记过就返回原来的。 */
  addRepo(url: string): RepoRow {
    const u = url.trim();
    if (!u) throw new Error('需要仓库地址');
    const existing = this.store.repoByUrl(u);
    if (existing) return existing;
    const repo = this.store.addRepo(u);
    this.event('repo_added', { id: repo.id, url: u });
    return repo;
  }

  /** 用邀请码加入团队。成员名当场校验：不能有控制字符和换行，1 到 32 个字。 */
  join(input: { invite: string; name: string; publicKey: string; deviceName: string | null }): JoinResponse {
    const why = memberNameError(input.name);
    if (why) throw new ApiError(400, why);
    try {
      if (createPublicKey(input.publicKey).asymmetricKeyType !== 'ed25519') throw new Error();
    } catch {
      throw new ApiError(400, 'publicKey 必须是 PEM 格式的 ed25519 公钥');
    }
    const res = this.store.transaction(() => {
      if (this.store.memberByName(input.name)) throw new ApiError(409, `成员名 ${input.name} 已被占用`);
      const member = this.store.addMember(input.name);
      // 在事务里：邀请码不对时，上面加的成员一起回滚
      if (!this.store.useInvite(input.invite, member.id)) throw new ApiError(403, '邀请码无效或已用过');
      const device = this.store.addDevice(member.id, input.publicKey, input.deviceName);
      return { memberId: member.id, deviceId: device.id, repos: this.store.repos().map(({ id, url }) => ({ id, url })) };
    });
    this.event('member_joined', { member: res.memberId, name: input.name });
    return res;
  }

  // —— 送达 ——

  /**
   * 开工、prompt/post-tool、收尾检查共用：建会话或更新活动时间，按预算选条目、渲染、记送达。
   * 全程同步、在一个事务里（Codex 会并行跑几条 hook，不能两条都拿到同一批）。
   */
  deliver(member: MemberRow, p: DeliverInput): DeliveryResponse {
    this.requireRepo(p.repoId);
    const sessionKey = `${p.tool}:${p.sessionId}`;
    return this.store.transaction(() => {
      const existing = this.store.session(sessionKey);
      if (existing && existing.member_id !== member.id) throw new ApiError(403, '这个会话号属于别的成员');
      // 服务器第一次见到这个会话：不管是哪个 hook 发来的，都按开工处理，开工 hook 丢了也能补上
      const fresh = !existing || existing.repo_id !== p.repoId;
      if (fresh) this.store.startSession(sessionKey, member.id, p.repoId, p.tool);
      else this.store.touchSession(sessionKey);
      const start = p.kind === 'start' || fresh;
      // 回答先留给提问的那个会话：它还在线时（同一个人的另一个会话，比如另一个 worktree 里的），这次不给，继续排队
      const since = this.store.now(-this.config.onlineWindowMs);
      const pending = this.store.pending(member.id, p.repoId).filter((n) => {
        if (n.type !== 'answer' || !n.asker_session || n.asker_session === sessionKey) return true;
        const s = this.store.session(n.asker_session);
        return !s || s.member_id !== member.id || s.repo_id !== p.repoId || s.ended_at !== null || s.last_seen_at < since;
      });
      const names = this.store.members().map((m) => m.name);
      const teammates = start ? this.teammates(member.id, p.repoId) : [];
      const batch = renderBatch({
        items: pending.map(toItem),
        teammates,
        // 队友行里没有的成员（7 天内没开过工的、排在 8 人以外的）也列出名字：AI 开工时就知道能点谁
        others: start ? names.filter((n) => n !== member.name && !teammates.some((t) => t.name === n)) : [],
        start,
        budgetBytes: this.config.budgetBytes,
        now: this.store.clock(),
      });
      // 只把放进去的记成已送达，其余继续排队
      const sent = pending.slice(0, batch.included);
      for (const n of sent) this.store.markDelivered(n.id, member.id, sessionKey);
      return {
        text: batch.text,
        messagesText: batch.messagesText,
        ids: sent.map((n) => n.id),
        types: sent.map((n) => n.type),
        hasMessages: sent.length > 0,
        // 每次都带：会话中途有人加入时，命令行的名单下一次 hook 就更新（内容没变连接器不写盘）
        members: names,
      };
    });
  }

  endSession(member: MemberRow, tool: Tool, sessionId: string): void {
    const key = `${tool}:${sessionId}`;
    const s = this.store.session(key);
    if (!s) return;
    if (s.member_id !== member.id) throw new ApiError(403, '不能结束别人的会话');
    this.store.endSession(key);
  }

  // —— 发消息 ——

  /**
   * notify、ask、reply 和发件箱补发。只发给点名的人；回答发给提问的人。
   * 同一个 clientId 重发时返回已有的那条，不重复创建，也不占发送限额。
   */
  send(member: MemberRow, input: SendInput): SendResponse {
    const repo = this.requireRepo(input.repoId);
    if (input.clientId !== null) {
      if (!/^[0-9a-f-]{8,64}$/i.test(input.clientId)) throw new ApiError(400, 'clientId 格式不对');
      const dup = this.store.noticeByClientId(member.id, input.clientId);
      if (dup) return this.sendResult(dup);
    }
    // 旧发件箱里的 payload 也照收：question、answer 原样，其余一律当作消息
    let type: NoticeType = input.type === 'question' ? 'question' : input.type === 'answer' ? 'answer' : 'message';
    if (input.replyTo) type = 'answer';
    if (type === 'answer' && !input.replyTo) throw new ApiError(400, '回答要写明回的是哪一条提问（replyTo）');

    if (input.summary !== undefined && input.summary !== null && typeof input.summary !== 'string') throw new ApiError(400, 'summary 必须是字符串');
    const summary = typeof input.summary === 'string' ? input.summary.trimEnd() : '';
    const length = [...summary].length;
    if (length > MAX_SUMMARY_CHARS) throw new ApiError(413, `说明最多 ${MAX_SUMMARY_CHARS} 字，这条有 ${length} 字：请精简后重发`);
    if (input.claims !== undefined && input.claims !== null && !Array.isArray(input.claims)) throw new ApiError(400, 'claims 必须是数组');
    const rawClaims = Array.isArray(input.claims) ? (input.claims as unknown[]) : [];
    if (rawClaims.length > MAX_CLAIMS) throw new ApiError(413, `声明最多 ${MAX_CLAIMS} 条，这条有 ${rawClaims.length} 条：只列最要紧的`);
    for (const c of rawClaims) {
      const why = claimError(c);
      if (why) throw new ApiError(400, why);
    }
    // 只留这三个字段，多出来的不入库
    const claims = rawClaims.map((c) => {
      const { file, symbol, change } = c as Claim;
      return { file, symbol, change };
    });
    if (summary.trim() === '' && (type !== 'message' || claims.length === 0)) throw new ApiError(400, type === 'message' ? '缺少说明（--summary）' : '缺少内容');

    const { to, replyTo } = type === 'answer' ? this.answerTarget(member, repo.id, input.replyTo as string) : { to: this.namedRecipients(member, input.to), replyTo: null };

    const reasons = reviewMessage([summary, ...claims.map((c) => `${c.file}#${c.symbol}`)], this.policy().allowDomains);
    if (reasons.length > 0) {
      this.event('notice_rejected', { from: member.name, type, reasons });
      throw new ApiError(422, rejectionMessage(reasons));
    }

    // 发送方的会话属于别人时不算（会话号冲突），按成员限流
    const owner = input.sessionKey ? this.store.session(input.sessionKey)?.member_id : undefined;
    const sessionKey = input.sessionKey && (owner === undefined || owner === member.id) ? input.sessionKey : null;
    const sent = this.store.sentSince(member.id, sessionKey, this.store.now(-this.config.sendWindowMs));
    if (sent >= this.config.sendLimit) {
      const minutes = Math.round(this.config.sendWindowMs / 60_000);
      throw new ApiError(429, `发送太频繁：同一个会话 ${minutes} 分钟内最多发 ${this.config.sendLimit} 条，请稍后再发`);
    }

    const n = this.store.transaction(() =>
      this.store.insertNotice(
        {
          id: newId('n'),
          repo_id: repo.id,
          sender_member_id: member.id,
          sender_session_id: sessionKey,
          type,
          summary,
          claims,
          to_names: to.map((m) => m.name),
          reply_to: replyTo,
          client_id: input.clientId,
          created_at: this.store.now(),
        },
        to.map((m) => m.id),
      ),
    );
    this.event('notice_sent', { id: n.id, type, from: member.name, to: n.to_names });
    return this.sendResult(n);
  }

  /** 点名的收件人：必须写，名字必须都存在；写了自己的话去掉自己。 */
  private namedRecipients(member: MemberRow, names: string[]): MemberRow[] {
    const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (wanted.length === 0) throw new ApiError(400, '没写发给谁：用 --to 成员名 点名（可以写多次）');
    const all = this.store.members();
    const unknown = wanted.filter((n) => !all.some((m) => m.name === n));
    if (unknown.length > 0) {
      const list = (xs: string[]) => xs.map((x) => normalizeText(x, true)).join('、');
      throw new ApiError(400, `找不到成员：${list(unknown)}。现有成员：${list(all.map((m) => m.name))}`);
    }
    const to = wanted.map((n) => all.find((m) => m.name === n) as MemberRow).filter((m) => m.id !== member.id);
    if (to.length === 0) throw new ApiError(400, '不能只发给你自己');
    return to;
  }

  /** 回答：只有被问到的人能回答，收件人是提问的人。同一条提问可以回答多次（用于更正）。 */
  private answerTarget(member: MemberRow, repoId: string, questionId: string): { to: MemberRow[]; replyTo: string } {
    const q = this.store.notice(questionId);
    if (!q || q.repo_id !== repoId || q.type !== 'question') throw new ApiError(404, `找不到提问 ${normalizeText(questionId, true).slice(0, 40)}`);
    if (!this.store.isRecipient(q.id, member.id)) throw new ApiError(403, '只有被问到的人才能回答这条提问');
    const asker = this.store.member(q.sender_member_id);
    if (!asker) throw new ApiError(404, '找不到提问的人');
    return { to: [asker], replyTo: q.id };
  }

  private sendResult(n: Notice): SendResponse {
    const recipients = this.store.recipientIds(n.id).flatMap((id) => this.store.member(id) ?? []);
    return {
      id: n.id,
      recipients: recipients.map((m) => m.name),
      presence: recipients.map((m) => ({ name: m.name, ...this.presence(m.id, n.repo_id) })),
    };
  }

  /** 成员在这个仓库里在不在线：有会话没结束、并且最近 30 分钟内有活动。 */
  presence(memberId: string, repoId: string): Omit<Presence, 'name'> {
    const row = this.store.get<{ last: string | null; online: number | null }>(
      'SELECT MAX(last_seen_at) AS last, MAX(ended_at IS NULL AND last_seen_at >= ?) AS online FROM sessions WHERE member_id = ? AND repo_id = ?',
      this.store.now(-this.config.onlineWindowMs),
      memberId,
      repoId,
    );
    return { online: row?.online === 1, lastSeenAt: row?.last ?? null };
  }

  // —— 队友概况 ——

  /** 7 天内在这个仓库有过会话的队友（不含自己），每人一个会话（在线的优先，其次最近活动的）：在线的排前面，其余按最近活动排，最多 8 人。 */
  teammates(memberId: string, repoId: string): Teammate[] {
    const rows = this.store.recentSessions(repoId, this.store.now(-TEAMMATE_WINDOW_MS));
    const since = this.store.clock() - this.config.onlineWindowMs;
    const online = (s: { ended_at: string | null; last_seen_at: string }) => !s.ended_at && Date.parse(s.last_seen_at) >= since;
    const picked = new Map<string, (typeof rows)[number]>();
    for (const s of rows) {
      if (s.member_id === memberId) continue;
      const cur = picked.get(s.member_id);
      if (!cur || (!online(cur) && online(s))) picked.set(s.member_id, s);
    }
    return [...picked.values()]
      .map((s) => ({ name: s.name, tool: s.tool, online: online(s), lastSeenAt: s.last_seen_at }))
      .sort((a, b) => Number(b.online) - Number(a.online) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, MAX_TEAMMATES);
  }

  // —— 查看 ——

  /** teamlink inbox：只看，不记送达，不受注入预算限制。默认看没送到的，all 看最近 7 天的全部。 */
  inbox(member: MemberRow, repoId: string, all: boolean): InboxResponse {
    this.requireRepo(repoId);
    const rows = all ? this.store.received(member.id, repoId, this.store.now(-INBOX_WINDOW_MS)) : this.store.pending(member.id, repoId);
    if (rows.length === 0) return { text: all ? '最近 7 天没有收到消息。' : '没有还没送到的消息。', count: 0 };
    return { text: renderBatch({ items: rows.map(toItem), budgetBytes: Infinity, now: this.store.clock() }).text, count: rows.length };
  }

  // —— 清理 ——

  /** 清掉 30 天没活动的会话、30 天前的通知（连同收件记录，同一个事务）。返回删掉的条数。 */
  prune(): { sessions: number; notices: number } {
    const cutoff = this.store.now(-this.config.retentionDays * DAY);
    return this.store.transaction(() => {
      const sessions = this.store.run('DELETE FROM sessions WHERE last_seen_at < ?', cutoff);
      this.store.run('DELETE FROM recipients WHERE notice_id IN (SELECT id FROM notices WHERE created_at < ?)', cutoff);
      const notices = this.store.run('DELETE FROM notices WHERE created_at < ?', cutoff);
      return { sessions, notices };
    });
  }
}
