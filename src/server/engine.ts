// 核心流程：发消息（校验、审核、入库，只发给发送方点名的人），按成员排队；
// hook 请求时在同一个同步调用、同一个事务里收确认、选条目、渲染整段注入文字、记成已交出。服务器不读仓库。
// 送达要连接器确认：交出去以后一直没确认的会重发（见 deliver）。

import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Claim,
  DeliveryResponse,
  InboxResponse,
  JoinResponse,
  NoticeItem,
  NoticeType,
  NoticeVia,
  Presence,
  SendResponse,
  SessionRef,
  TakeAnswersResponse,
  Teammate,
  Tool,
} from '../shared/protocol.ts';
import { BASES, claimError, INJECTION_BUDGET_BYTES, MAX_ACKS, MAX_CLAIMS, MAX_SUMMARY_CHARS, memberNameError, VIAS, type Basis } from '../shared/protocol.ts';
import { excerpt, normalizeText, renderBatch, type RenderItem } from '../shared/render.ts';
import { DEFAULT_POLICY, type Policy } from '../shared/rules.ts';
import { newId, SYSTEM_SENDER, type DeviceInfo, type MemberRow, type Notice, type QueuedNotice, type RepoRow, type Store, type UndeliveredRow } from './db.ts';
import { loadPolicy } from './policy.ts';
import { rejectionMessage, reviewMessage } from '../shared/review.ts';

const DAY = 24 * 3600_000;
/** 开工时列 7 天内有过会话的队友，最多 8 人。 */
const TEAMMATE_WINDOW_MS = 7 * DAY;
const MAX_TEAMMATES = 8;
/** inbox --all 看最近 7 天。 */
const INBOX_WINDOW_MS = 7 * DAY;
/** 每天的备份文件名。 */
const BACKUP_FILE = /^teamlink-\d{4}-\d\d-\d\d\.db$/;
/** 告诉发送人“这些没送到、已经删了”时，一条系统消息里最多列几条、每条列几个收件人、摘录几个字。 */
const TOLD_MAX = 5;
const TOLD_NAMES = 3;
const TOLD_EXCERPT_CHARS = 40;
const TYPE_LABEL: Record<NoticeType, string> = { message: '消息', question: '提问', answer: '回答' };
/** ask --wait 当场取走的回答记在这个名下（不是哪一个会话）：这个成员的任何会话都把它当成“交给了自己”。 */
const WAIT_SESSION = 'cli';
/**
 * 一直没确认时，重发的间隔按交出的次数拉长：resendAfterMs 的 1、6、60、360、2160 倍
 * （默认 10 秒、1 分钟、10 分钟、1 小时，之后每 6 小时）。不设次数上限：没确认就不能算送到，只是越发越慢。
 */
const RESEND_BACKOFF = [1, 6, 60, 360, 2160];

export interface EngineConfig {
  dataDir: string;
  /** 会话没结束、并且这么久之内有活动，就算在线。 */
  onlineWindowMs: number;
  /** 每个会话（没有会话时按成员）在 sendWindowMs 内最多发几条：防失控的兜底。 */
  sendLimit: number;
  sendWindowMs: number;
  /** 同一个成员的所有会话加起来，在 sendWindowMs 内最多发几条：会话号是连接器自己报的，换会话号不能绕过限流。 */
  memberSendLimit: number;
  /** 一次注入最多多少字节（UTF-8）。 */
  budgetBytes: number;
  /** 会话和通知保留多少天。 */
  retentionDays: number;
  /** 每天备份一次数据库，保留最近几份；0 是不备份。 */
  backupKeep: number;
  /**
   * 交出去以后这么久还没收到确认，同一个会话再来时重发（再没确认，间隔逐次拉长，见 RESEND_BACKOFF）。
   * 要比一次 hook 的时限（3.5 秒）长：Codex 并行跑的几条 hook 里，后到的那条还没带上前一条的确认，不能把同一批再给它一遍。
   */
  resendAfterMs: number;
  /** 服务器事件（以前的审计表）和错误写到哪里，默认 stderr。 */
  log: (line: string) => void;
}

export const DEFAULT_CONFIG: Omit<EngineConfig, 'dataDir'> = {
  onlineWindowMs: 30 * 60_000,
  sendLimit: 30,
  memberSendLimit: 120,
  sendWindowMs: 10 * 60_000,
  budgetBytes: INJECTION_BUDGET_BYTES,
  retentionDays: 30,
  backupKeep: 7,
  resendAfterMs: 10_000,
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
  /** 谁写的（AI 会话 / 本人在终端）：连接器报的，不认识的值当作没报。 */
  via?: unknown;
  /** 回答的依据（confirmed、checked、guess）：只有回答能带；不认识的值报错，免得依据悄悄丢掉。 */
  basis?: unknown;
}

const toItem = (n: QueuedNotice): RenderItem => ({
  id: n.id,
  type: n.type,
  sender: n.sender_member_id === SYSTEM_SENDER ? 'teamlink 服务器' : (n.sender_name ?? '已移出团队的成员'),
  summary: n.summary,
  claims: n.claims,
  replyTo: n.reply_to ? { id: n.reply_to, question: n.question ?? '' } : null,
  via: n.via,
  basis: n.basis ?? null,
});

/** 送达响应里带的结构化内容：连接器存起来，teamlink fact --from 用。 */
const toNoticeItem = (n: QueuedNotice): NoticeItem => {
  const r = toItem(n);
  return { id: r.id, type: r.type, sender: r.sender, via: r.via ?? null, basis: r.basis ?? null, summary: r.summary, replyTo: r.replyTo ?? null, createdAt: n.created_at };
};

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
    const invalid = () => new ApiError(403, '邀请码无效、已用过或已过期');
    let added = false;
    const res = this.store.transaction(() => {
      // 给现有成员再加一台设备的邀请码（teamlink-server invite --for）：名字要和那个成员一致
      const owner = this.store.invite(input.invite)?.member_id;
      let member = owner ? this.store.member(owner) : undefined;
      if (owner) {
        // 先用掉再比名字：码不能用时不透露它是给谁的；名字不对时抛错，用掉的这一步一起回滚
        if (!member || !this.store.useInvite(input.invite, member.id)) throw invalid();
        if (member.name !== input.name) throw new ApiError(403, `这个邀请码是给 ${member.name} 加设备用的，--name 要写 ${member.name}`);
        added = true;
      } else {
        if (this.store.memberByName(input.name)) {
          throw new ApiError(409, `成员名 ${input.name} 已被占用（要给这个成员再加一台设备，请管理员运行 teamlink-server invite --for ${input.name}）`);
        }
        member = this.store.addMember(input.name);
        // 在事务里：邀请码不对时，上面加的成员一起回滚
        if (!this.store.useInvite(input.invite, member.id)) throw invalid();
      }
      const device = this.store.addDevice(member.id, input.publicKey, input.deviceName);
      return { memberId: member.id, deviceId: device.id, repos: this.store.repos().map(({ id, url }) => ({ id, url })) };
    });
    this.event(added ? 'device_added' : 'member_joined', { member: res.memberId, name: input.name, device: res.deviceId });
    return res;
  }

  // —— 成员和设备管理（只有服务器上的管理命令能调，接口里没有）——

  /** 按名字找成员；找不到时报出现有的名字。 */
  memberNamed(name: string): MemberRow {
    const member = this.store.memberByName(name.trim());
    if (!member) throw new Error(`找不到成员：${name}。现有成员：${this.store.members().map((m) => m.name).join('、') || '（无）'}`);
    return member;
  }

  /** 改名：消息、会话都按成员 ID 记，不受影响；队友下一次 hook 拿到新的名单。 */
  renameMember(name: string, to: string): MemberRow {
    const member = this.memberNamed(name);
    const why = memberNameError(to);
    if (why) throw new Error(why);
    if (to === member.name) return member;
    if (this.store.memberByName(to)) throw new Error(`成员名 ${to} 已被占用`);
    this.store.renameMember(member.id, to);
    this.event('member_renamed', { member: member.id, from: member.name, to });
    return { ...member, name: to };
  }

  /**
   * 移出成员：他的设备全部失效，名字空出来。别人发给他、还没送到的，先告诉发送人；他发出去、还没送到的不再送。
   * 返回吊销了几台设备、告诉了几个发送人。
   */
  removeMember(name: string): { member: MemberRow; devices: number; told: number } {
    const member = this.memberNamed(name);
    const res = this.store.transaction(() => {
      const told = this.tellSenders(this.store.undelivered('r.member_id = ?', member.id), `${member.name} 已经被移出团队`);
      const devices = this.store.devices().filter((d) => d.member_id === member.id).length;
      this.store.removeMember(member.id);
      return { devices, told };
    });
    this.event('member_removed', { member: member.id, name: member.name, ...res });
    return { member, ...res };
  }

  /**
   * 吊销一台设备（电脑丢了、私钥泄露）：成员还在，别的设备照常用。
   * 这个成员的会话一起记成结束：会话不记是哪台设备开的，而交给被吊销设备的会话、还没确认的消息，要等那个会话下线（30 分钟）
   * 才会改交给别的会话。别的设备上还开着的会话，下一次 hook 就重新算在线。
   */
  revokeDevice(deviceId: string): { device: DeviceInfo; member: MemberRow | undefined; left: number } {
    const all = this.store.devices();
    const device = all.find((d) => d.id === deviceId.trim());
    if (!device) throw new Error(`找不到设备：${deviceId}。用 teamlink-server members 查看设备 ID`);
    this.store.transaction(() => {
      this.store.removeDevice(device.id);
      this.store.run('UPDATE sessions SET ended_at = ? WHERE member_id = ? AND ended_at IS NULL', this.store.now(), device.member_id);
    });
    const member = this.store.member(device.member_id);
    this.event('device_revoked', { device: device.id, member: device.member_id, name: member?.name });
    return { device, member, left: all.filter((d) => d.member_id === device.member_id).length - 1 };
  }

  /**
   * 没送到就要删掉的消息：给每个发送人在对应的仓库里留一条系统消息，说清是哪几条（调用方放在删除的同一个事务里）。
   * 一个发送人一个仓库只留一条，最多列 TOLD_MAX 条。返回留了几条系统消息。
   */
  private tellSenders(rows: UndeliveredRow[], why: string): number {
    // 发送人 + 仓库 → 通知 ID → 那条通知和没收到的人
    const groups = new Map<string, Map<string, { row: UndeliveredRow; to: string[] }>>();
    for (const row of rows) {
      const key = `${row.sender_member_id}\n${row.repo_id}`;
      const notices = groups.get(key) ?? new Map<string, { row: UndeliveredRow; to: string[] }>();
      groups.set(key, notices);
      const cur = notices.get(row.id) ?? { row, to: [] };
      notices.set(row.id, cur);
      cur.to.push(row.recipient);
    }
    for (const notices of groups.values()) {
      const list = [...notices.values()];
      const { sender_member_id, repo_id } = list[0].row;
      const sender = this.store.member(sender_member_id);
      if (!sender) continue;
      // 收件人最多列 TOLD_NAMES 个：一条群发给几十个人时，这条系统消息也不会超过注入预算
      const names = (to: string[]) => (to.length > TOLD_NAMES ? `${to.slice(0, TOLD_NAMES).join('、')} 等 ${to.length} 人` : to.join('、'));
      const lines = list.slice(0, TOLD_MAX).map(({ row, to }) => `- ${row.created_at.slice(0, 10)} 发给 ${names(to)} 的${TYPE_LABEL[row.type]}：${excerpt(row.summary, TOLD_EXCERPT_CHARS)}`);
      if (list.length > TOLD_MAX) lines.push(`另有 ${list.length - TOLD_MAX} 条。`);
      this.store.insertNotice(
        {
          id: newId('n'),
          repo_id,
          sender_member_id: SYSTEM_SENDER,
          sender_session_id: null,
          type: 'message',
          summary: `你发的 ${list.length} 条消息对方一直没有收到，已经删除（${why}）。还需要的话换个方式告诉对方：\n${lines.join('\n')}`,
          claims: [],
          to_names: [sender.name],
          reply_to: null,
          client_id: null,
          created_at: this.store.now(),
          via: null,
        },
        [sender.id],
      );
    }
    return groups.size;
  }

  // —— 送达 ——

  /** 连接器确认这些已经输出给 AI 了：只认发给这个成员、已经交出去的，别的忽略。 */
  private confirm(member: MemberRow, acks: string[] | undefined): void {
    for (const id of (acks ?? []).slice(0, MAX_ACKS)) this.store.ack(id, member.id);
  }

  /** 只收确认、不送消息：收尾检查拦过一次以后的那次结束不能再输出，但上一批的确认要及时带回来。 */
  ack(member: MemberRow, acks: string[] | undefined): void {
    this.store.transaction(() => this.confirm(member, acks));
  }

  /**
   * 开工、prompt/post-tool、收尾检查共用：建会话或更新活动时间，收确认，按预算选条目、渲染、记成已交出。
   * 全程同步、在一个事务里（Codex 会并行跑几条 hook，不能两条都拿到同一批）。
   *
   * 送达确认：交出去的条目要等连接器在之后的请求里确认（acks）才算送到。还没确认的：
   * - 交给的就是这个会话：过了 resendAfterMs 它再来、还是没确认，说明那一批没到 AI 手里（hook 超时被杀、响应丢了），重发；
   *   再没确认，间隔逐次拉长，一直发到确认为止（30 天后和别的通知一起清掉）；
   * - 交给的是这个成员的另一个会话：那个会话还在线就继续等它，结束或下线了才交给现在这个。
   * 先后：同一个发送人前面有一条交给了这个会话、还没确认时，他后面的不能先到（更正不能比原文先到）——
   * 那一条刚交出去（可能还在路上）就等它；已经在等下一次重发了，就把它提前、和后面的一起发。
   * 请求里没有 acks 字段的是旧连接器，不会回确认：照旧交出时就算送到。
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
      // 先收确认，再选条目：这个请求确认掉的不会又被选中
      this.confirm(member, p.acks);
      const since = this.store.now(-this.config.onlineWindowMs);
      /** 这个成员在这个仓库里的另一个会话已经不在了（没有、结束了、下线了）。 */
      const gone = (key: string) => {
        const s = this.store.session(key);
        return !s || s.member_id !== member.id || s.repo_id !== p.repoId || s.ended_at !== null || s.last_seen_at < since;
      };
      const now = this.store.clock();
      const resendDelay = (attempts: number) => this.config.resendAfterMs * RESEND_BACKOFF[Math.min(Math.max(attempts, 1), RESEND_BACKOFF.length) - 1];
      const pending: QueuedNotice[] = [];
      /** 这些发送人有一条刚交给这个会话、还没确认（可能还在路上）：他后面的先等它。 */
      const waitFor = new Set<string>();
      /** 这些发送人有交给这个会话、没确认、还没到重发时间的：他后面有新的要送时，提前一起重发。 */
      const early = new Map<string, QueuedNotice[]>();
      for (const n of this.store.pending(member.id, p.repoId)) {
        const from = n.sender_member_id;
        if (n.delivered_at !== null) {
          // 交出去过、还没确认
          if (n.delivered_session !== sessionKey && n.delivered_session !== WAIT_SESSION) {
            if (!n.delivered_session || gone(n.delivered_session)) pending.push(n);
            continue;
          }
          const waited = now - Date.parse(n.delivered_at);
          if (waited >= resendDelay(n.attempts)) pending.push(n);
          else if (waited < this.config.resendAfterMs) waitFor.add(from);
          else early.set(from, [...(early.get(from) ?? []), n]);
          continue;
        }
        // 回答先留给提问的那个会话：它还在线时（同一个人的另一个会话，比如另一个 worktree 里的），这次不给，继续排队
        if (n.type === 'answer' && n.asker_session && n.asker_session !== sessionKey && !gone(n.asker_session)) continue;
        if (waitFor.has(from)) continue;
        const held = early.get(from);
        if (held) {
          pending.push(...held);
          early.delete(from);
        }
        pending.push(n);
      }
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
      // 只把放进去的记成已交出，其余继续排队。旧连接器不回确认：当场算送到
      const sent = pending.slice(0, batch.included);
      const legacy = p.acks === undefined;
      for (const n of sent) this.store.handOut(n.id, member.id, sessionKey, legacy);
      const resent = sent.filter((n) => n.attempts > 0);
      if (resent.length > 0) this.event('notice_resent', { to: member.name, session: sessionKey, ids: resent.map((n) => n.id) });
      return {
        text: batch.text,
        messagesText: batch.messagesText,
        ids: sent.map((n) => n.id),
        types: sent.map((n) => n.type),
        hasMessages: sent.length > 0,
        // 每次都带：会话中途有人加入时，命令行的名单下一次 hook 就更新（内容没变连接器不写盘）
        members: names,
        items: sent.map(toNoticeItem),
      };
    });
  }

  /** 会话结束。顺带收确认：最后一批是在收尾时交给 AI 的话，确认只能跟着这个请求来。没确认的，这个成员的下一个会话会收到。 */
  endSession(member: MemberRow, tool: Tool, sessionId: string, acks?: string[]): void {
    const key = `${tool}:${sessionId}`;
    this.store.transaction(() => {
      this.confirm(member, acks);
      const s = this.store.session(key);
      if (!s) return;
      if (s.member_id !== member.id) throw new ApiError(403, '不能结束别人的会话');
      this.store.endSession(key);
    });
  }

  /**
   * ask --wait 用：取走某条提问已经到了的回答。和 hook 一样要确认：命令行打印出来以后回 /api/v2/acks，这才算送到；
   * 响应丢了、命令在打印前被杀了，下一次轮询还能再拿到，一直没确认的由 hook 重发。
   * 只拿没交出去过的和上次 --wait 拿走还没确认的：已经交给 hook 的那一份由 hook 负责。提问必须是这个成员自己发的。
   */
  takeAnswers(member: MemberRow, p: { repoId: string; question: string }): TakeAnswersResponse {
    this.requireRepo(p.repoId);
    const q = this.store.notice(p.question);
    if (!q || q.repo_id !== p.repoId || q.type !== 'question') throw new ApiError(404, `找不到提问 ${normalizeText(p.question, true).slice(0, 40)}`);
    if (q.sender_member_id !== member.id) throw new ApiError(403, '只能等自己发的提问的回答');
    return this.store.transaction(() => {
      const answers = this.store
        .pending(member.id, p.repoId)
        .filter((n) => n.type === 'answer' && n.reply_to === q.id && (n.delivered_at === null || n.delivered_session === WAIT_SESSION));
      for (const n of answers) this.store.handOut(n.id, member.id, WAIT_SESSION, false);
      const asked = this.store.recipientIds(q.id);
      return {
        text: answers.length > 0 ? renderBatch({ items: answers.map(toItem), budgetBytes: Infinity, now: this.store.clock() }).text : '',
        ids: answers.map((n) => n.id),
        online: asked.some((id) => this.presence(id, p.repoId).online),
        items: answers.map(toNoticeItem),
      };
    });
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
    const via: NoticeVia | null = VIAS.includes(input.via as NoticeVia) ? (input.via as NoticeVia) : null;
    if (input.basis !== undefined && input.basis !== null && !BASES.includes(input.basis as Basis)) {
      throw new ApiError(400, `basis 必须是 ${BASES.join('、')} 之一`);
    }
    // 只有回答有依据：提问和消息带了也不存
    const basis = type === 'answer' ? ((input.basis as Basis | null | undefined) ?? null) : null;

    const reasons = reviewMessage([summary, ...claims.map((c) => `${c.file}#${c.symbol}`)], this.policy().allowDomains);
    if (reasons.length > 0) {
      this.event('notice_rejected', { from: member.name, type, reasons });
      throw new ApiError(422, rejectionMessage(reasons));
    }

    // 发送方的会话属于别人时不算（会话号冲突），按成员限流
    const owner = input.sessionKey ? this.store.session(input.sessionKey)?.member_id : undefined;
    const sessionKey = input.sessionKey && (owner === undefined || owner === member.id) ? input.sessionKey : null;
    const since = this.store.now(-this.config.sendWindowMs);
    const minutes = Math.round(this.config.sendWindowMs / 60_000);
    if (this.store.sentSince(member.id, sessionKey, since) >= this.config.sendLimit) {
      throw new ApiError(429, `发送太频繁：同一个会话 ${minutes} 分钟内最多发 ${this.config.sendLimit} 条，请稍后再发`);
    }
    if (this.store.sentByMemberSince(member.id, since) >= this.config.memberSendLimit) {
      throw new ApiError(429, `发送太频繁：同一个人 ${minutes} 分钟内最多发 ${this.config.memberSendLimit} 条，请稍后再发`);
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
          via,
          basis,
        },
        to.map((m) => m.id),
      ),
    );
    this.event('notice_sent', { id: n.id, type, from: member.name, to: n.to_names, ...(via ? { via } : {}), ...(basis ? { basis } : {}) });
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

  /**
   * teamlink fact --from 在本机存档里找不到时来查：一条自己发的或者收到的通知。
   * 是自己发的提问时返回它最新的一条回答（同一条提问可以回答多次来更正，以最新的为准）。
   */
  lookup(member: MemberRow, repoId: string, id: string): NoticeItem {
    this.requireRepo(repoId);
    const shown = normalizeText(id, true).slice(0, 40);
    const n = this.store.notice(id);
    if (!n || n.repo_id !== repoId) throw new ApiError(404, `找不到通知 ${shown}`);
    if (n.sender_member_id !== member.id && !this.store.isRecipient(n.id, member.id)) throw new ApiError(403, '只能查自己发的或者收到的通知');
    let target: Notice = n;
    if (n.type === 'question') {
      if (n.sender_member_id !== member.id) throw new ApiError(400, `${shown} 是别人问你的提问，不是事实`);
      const answer = this.store.get<{ id: string }>("SELECT id FROM notices WHERE reply_to = ? AND type = 'answer' ORDER BY created_at DESC, rowid DESC LIMIT 1", n.id);
      if (!answer) throw new ApiError(404, `提问 ${shown} 还没有回答`);
      target = this.store.notice(answer.id) as Notice;
    }
    const question = target.reply_to ? this.store.notice(target.reply_to) : undefined;
    const sender = this.store.member(target.sender_member_id);
    return toNoticeItem({
      ...target,
      sender_name: sender?.name ?? null,
      question: question?.summary ?? null,
      asker_session: null,
      delivered_at: null,
      delivered_session: null,
      attempts: 0,
    });
  }

  /**
   * teamlink inbox：只看，不记送达，不受注入预算限制。默认看还没交给过 AI 会话的
   * （交出去了、还在等确认的不算：多半已经在 AI 手里，没到的会自动重发），all 看最近 7 天的全部。
   */
  inbox(member: MemberRow, repoId: string, all: boolean): InboxResponse {
    this.requireRepo(repoId);
    const rows = all ? this.store.received(member.id, repoId, this.store.now(-INBOX_WINDOW_MS)) : this.store.pending(member.id, repoId).filter((n) => n.delivered_at === null);
    if (rows.length === 0) return { text: all ? '最近 7 天没有收到消息。' : '没有还没送到的消息。', count: 0 };
    return { text: renderBatch({ items: rows.map(toItem), budgetBytes: Infinity, now: this.store.clock() }).text, count: rows.length };
  }

  // —— 备份 ——

  /**
   * 每天备份一次数据库：<数据目录>/backups/teamlink-年-月-日.db（按 UTC 的日期），保留最近 backupKeep 份。
   * 服务器不用停（VACUUM INTO 写出的是一份一致的快照）。今天的已经有了就不做。返回新备份的路径，没做返回 null。
   */
  backup(): string | null {
    if (this.config.backupKeep <= 0 || this.store.path === ':memory:') return null;
    const dir = join(this.config.dataDir, 'backups');
    const target = join(dir, `teamlink-${this.store.now().slice(0, 10)}.db`);
    if (existsSync(target)) return null;
    mkdirSync(dir, { recursive: true });
    // 先写临时文件再改名：备份到一半断了（磁盘满、进程被杀），不会留下一个看着完整、其实只有半截的备份
    const tmp = `${target}.tmp`;
    rmSync(tmp, { force: true });
    try {
      this.store.backupTo(tmp);
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    const files = readdirSync(dir);
    const all = files.filter((f) => BACKUP_FILE.test(f)).sort();
    // 以前哪天做到一半被杀掉留下的临时文件也删：只有服务器这一个进程做备份，这时候没有别人在写
    const stale = files.filter((f) => f.endsWith('.tmp') && BACKUP_FILE.test(f.slice(0, -4)));
    for (const f of [...all.slice(0, -this.config.backupKeep), ...stale]) rmSync(join(dir, f), { force: true });
    return target;
  }

  // —— 清理 ——

  /**
   * 清掉 30 天没活动的会话、30 天前的通知（连同收件记录，同一个事务）、过期没用的邀请码。返回删掉的条数。
   * 要删的通知里还有人没收到的，先给发送人留一条系统消息（told：留了几条）：不然消息悄悄没了，发送人一直以为对方看到了。
   */
  prune(): { sessions: number; notices: number; told: number } {
    const cutoff = this.store.now(-this.config.retentionDays * DAY);
    return this.store.transaction(() => {
      const sessions = this.store.run('DELETE FROM sessions WHERE last_seen_at < ?', cutoff);
      const told = this.tellSenders(this.store.undelivered('n.created_at < ?', cutoff), `超过 ${this.config.retentionDays} 天`);
      this.store.run('DELETE FROM recipients WHERE notice_id IN (SELECT id FROM notices WHERE created_at < ?)', cutoff);
      const notices = this.store.run('DELETE FROM notices WHERE created_at < ?', cutoff);
      this.store.run('DELETE FROM invites WHERE used_by IS NULL AND expires_at < ?', this.store.now());
      return { sessions, notices, told };
    });
  }
}
