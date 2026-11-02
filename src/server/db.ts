// 数据存储：Node 自带的 SQLite，零安装。结构版本记在 PRAGMA user_version：旧库是 0，现在的结构是 2。
// 打开库时先迁移、再建表；迁移失败就回滚、报错，不带着旧结构继续跑。

import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Claim, NoticeType, Tool } from '../shared/protocol.ts';
import { claimError, MAX_CLAIMS, MAX_SUMMARY_CHARS } from '../shared/protocol.ts';

export const SCHEMA_VERSION = 2;

/** members、devices、invites 沿用旧表（git_email、handle 这些可空列留着不用）。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, git_email TEXT, handle TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, public_key TEXT NOT NULL, name TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_at TEXT NOT NULL, used_by TEXT);
CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, repo_id TEXT NOT NULL, tool TEXT NOT NULL,
  started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_repo_seen ON sessions(repo_id, last_seen_at);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id, repo_id);
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, sender_member_id TEXT NOT NULL, sender_session_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('message', 'question', 'answer')), summary TEXT NOT NULL,
  claims TEXT NOT NULL DEFAULT '[]', to_names TEXT NOT NULL DEFAULT '[]', reply_to TEXT, client_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (sender_member_id, client_id)
);
CREATE INDEX IF NOT EXISTS notices_session ON notices(sender_session_id, created_at);
CREATE INDEX IF NOT EXISTS notices_created ON notices(created_at);
CREATE TABLE IF NOT EXISTS recipients (
  notice_id TEXT NOT NULL, member_id TEXT NOT NULL, delivered_at TEXT, delivered_session TEXT,
  PRIMARY KEY (notice_id, member_id)
);
CREATE INDEX IF NOT EXISTS recipients_member ON recipients(member_id, delivered_at);
`;

/** 升级时整个删掉的旧表（git 分析、告警、审计、订阅、活动记录，以及要换结构的会话和通知）。 */
const OLD_TABLES = ['activity', 'alerts', 'audit', 'subscriptions', 'branch_heads', 'sessions', 'notices', 'recipients'];
/** 旧库里只要有其中一张表，就是要迁移的旧结构。 */
const OLD_MARKERS = ['members', 'repos', 'notices'];
const DAY = 24 * 3600_000;

export interface RepoRow {
  id: string;
  url: string;
  created_at: string;
}
export interface MemberRow {
  id: string;
  name: string;
}
export interface DeviceRow {
  id: string;
  member_id: string;
  public_key: string;
}
export interface SessionRow {
  /** 工具:会话号 */
  id: string;
  member_id: string;
  repo_id: string;
  tool: Tool;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
}
/** 通知创建后不再变。 */
export interface Notice {
  id: string;
  repo_id: string;
  sender_member_id: string;
  sender_session_id: string | null;
  type: NoticeType;
  summary: string;
  claims: Claim[];
  to_names: string[];
  /** 回答：对应的提问。 */
  reply_to: string | null;
  /** 连接器给每条消息生成的编号：发件箱重发、回复丢失后重试时按它去重。 */
  client_id: string | null;
  created_at: string;
}
/** 送达时一次查出来的一条：通知本身，加上发送人的名字，以及回答对应的提问内容和提问时的会话。 */
export interface QueuedNotice extends Notice {
  sender_name: string | null;
  question: string | null;
  /** 回答：提问是从哪个会话发的（“工具:会话号”）。 */
  asker_session: string | null;
}

export interface MigrationResult {
  backup: string;
  /** 搬过来的通知（7 天内、还有人没收到的，以及 7 天内的提问）。 */
  kept: number;
  dropped: number;
  /** 地址重复、没搬过来的仓库 ID。 */
  duplicateRepos: string[];
}

export interface StoreOptions {
  log?: (line: string) => void;
}

type Row = Record<string, unknown>;

/** 升级前备份失败：库还没动过，原样报出去，不再套一层“升级失败、已回滚”。 */
class BackupError extends Error {}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

function parseList(v: unknown): unknown[] {
  if (typeof v !== 'string') return [];
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly log: (line: string) => void;
  /** 这次打开时做了迁移的话，迁移的结果。 */
  readonly migration: MigrationResult | null;
  /** 测试里可以替换时钟。 */
  clock: () => number = () => Date.now();

  constructor(path: string, opts: StoreOptions = {}) {
    this.path = path;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.db = new DatabaseSync(path);
    // busy_timeout 要先设：别的进程（服务器、正在迁移的管理命令）拿着库的时候，journal_mode 这一句也要等，不能立即报“database is locked”
    this.db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;');
    try {
      this.migration = this.prepare();
    } catch (e) {
      this.db.close();
      throw e;
    }
    if (this.migration) {
      const m = this.migration;
      this.log(`teamlink：数据库已升级到结构版本 ${SCHEMA_VERSION}，搬过来 ${m.kept} 条通知（还有人没收到的，以及 7 天内的提问），丢掉 ${m.dropped} 条。原库备份在 ${m.backup}，降级回旧版时用它。`);
      if (m.duplicateRepos.length > 0) {
        this.log(`teamlink：这些仓库和更早登记的地址重复，没有搬过来：${m.duplicateRepos.join('、')}。关联到它们的成员要重新运行 teamlink link。`);
      }
    }
  }

  private userVersion(): number {
    return this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  }

  private columns(table: string): Set<string> {
    return new Set(this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
  }

  private hasOldTables(): boolean {
    return this.all('SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?, ?)', 'table', ...OLD_MARKERS).length > 0;
  }

  /** 先迁移、再建表。返回迁移结果；新库或已经是新结构时返回 null。 */
  private prepare(): MigrationResult | null {
    const version = this.userVersion();
    if (version === SCHEMA_VERSION) {
      this.db.exec(SCHEMA);
      return null;
    }
    if (version !== 0) throw new Error(`数据库的结构版本是 ${version}，这个版本的服务器只认 0 和 ${SCHEMA_VERSION}；请换用对应版本的服务器`);
    // 先拿写锁再读一次版本：服务器和管理命令同时打开旧库时，只有拿到锁的那个去备份和迁移，其余的等它做完、直接用新结构。
    // 以前是拿锁之前就备份，几个进程会各备份一份，还会同时写同一个备份文件，后到的报“备份失败”退出
    this.db.exec('PRAGMA busy_timeout = 30000');
    let backup = '';
    try {
      return this.transaction(() => {
        if (this.userVersion() === SCHEMA_VERSION) return null;
        if (!this.hasOldTables()) {
          this.db.exec(SCHEMA);
          this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          return null;
        }
        backup = this.path === ':memory:' ? '' : this.backup();
        const result = this.migrateFromV0();
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        return backup ? { ...result, backup } : null;
      });
    } catch (e) {
      if (e instanceof BackupError) throw e;
      // 已回滚，库没变，这次的备份没用了：删掉。否则 run.sh 每 3 秒重启一次，每次多一份整库副本，能把磁盘写满
      if (backup) rmSync(backup, { force: true });
      throw new Error(`数据库升级失败，已回滚，库保持原样（${this.path}）：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.db.exec('PRAGMA busy_timeout = 3000');
    }
  }

  /**
   * 备份成 teamlink.db.v1.bak；已经有了就加时间戳。VACUUM INTO 不能在事务里执行，而这时本连接拿着写锁、在事务里，
   * 所以另开一个只读连接来做：它读到的是拿锁以前提交的状态，也就是迁移前的旧库。
   */
  private backup(): string {
    let target = `${this.path}.v1.bak`;
    if (existsSync(target)) target = `${this.path}.v1.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    try {
      const reader = new DatabaseSync(this.path, { readOnly: true });
      try {
        reader.exec('PRAGMA busy_timeout = 30000');
        reader.prepare('VACUUM INTO ?').run(target);
      } finally {
        reader.close();
      }
    } catch (e) {
      // VACUUM INTO 中途失败会留下这次新建的目标文件（多半是空的）：删掉，不然它占着 teamlink.db.v1.bak 这个名字，降级时换上的是空库
      rmSync(target, { force: true });
      throw new BackupError(`升级前备份数据库失败，没有升级，库保持原样（${this.path}）：${e instanceof Error ? e.message : String(e)}`);
    }
    return target;
  }

  /**
   * 旧结构（版本 0）→ 新结构，在调用方的事务里做：
   * 先读出要保留的通知（7 天内、状态没作废、还有人没收到），再删旧表、建新表、写回。
   * 7 天内的提问即使已经送到也搬过来（连同已送达的收件记录）：被问的人升级后才回答时，服务器还认得这条提问，
   * 只有收件人才能回答的检查也还成立；否则回答会被 404 退回，提问的人永远等不到。
   */
  private migrateFromV0(): Omit<MigrationResult, 'backup'> {
    const nc = this.columns('notices');
    const rc = this.columns('recipients');
    const col = (cols: Set<string>, c: string, fallback = 'NULL') => (cols.has(c) ? c : `${fallback} AS ${c}`);
    const total = nc.size > 0 ? (this.get<{ c: number }>('SELECT COUNT(*) AS c FROM notices')?.c ?? 0) : 0;
    const old =
      nc.size > 0 && rc.size > 0
        ? this.all(
            `SELECT id, repo_id, type, ${col(nc, 'sender_member_id')}, ${col(nc, 'sender_session_id')}, ${col(nc, 'summary', "''")}, ${col(nc, 'claims', "'[]'")},
               ${col(nc, 'manual_to', "'[]'")}, ${col(nc, 'reply_to')}, ${col(nc, 'client_id')}, created_at
             FROM notices WHERE created_at >= ?${nc.has('state') ? " AND state NOT IN ('quarantined', 'void', 'superseded', 'expired')" : ''}
             ORDER BY created_at`,
            this.now(-7 * DAY),
          )
        : [];
    // 只搬没送达的收件记录（提问除外，见上）；拒绝过、撤回过的不搬，发回给发送人自己的（旧版的“没人负责”提醒）也不搬
    const usable = ['member_id != ?'];
    if (rc.has('approval')) usable.push("(approval IS NULL OR approval != 'rejected')");
    if (rc.has('retracted_at')) usable.push('retracted_at IS NULL');
    type Delivery = { member_id: string; delivered_at: string | null; delivered_session: string | null };
    const kept: { notice: Notice; recipients: Delivery[] }[] = [];
    for (const r of old) {
      const sender = r.sender_member_id;
      if (typeof sender !== 'string') continue; // git 自动生成的通知没有发送人
      const question = r.type === 'question';
      const recipients = this.all<Delivery>(
        `SELECT member_id, delivered_at, ${col(rc, 'delivered_session')} FROM recipients WHERE notice_id = ? AND ${usable.join(' AND ')}${question ? '' : ' AND delivered_at IS NULL'}`,
        r.id,
        sender,
      );
      if (recipients.length === 0) continue;
      const claims = parseList(r.claims).filter((c): c is Claim => claimError(c) === null).slice(0, MAX_CLAIMS);
      const summary = typeof r.summary === 'string' ? [...r.summary].slice(0, MAX_SUMMARY_CHARS).join('') : '';
      if (summary.trim() === '' && claims.length === 0) continue;
      kept.push({
        notice: {
          id: r.id as string,
          repo_id: r.repo_id as string,
          sender_member_id: sender,
          sender_session_id: typeof r.sender_session_id === 'string' ? r.sender_session_id : null,
          // 提问、回答保持原类型，其余（接口变更、设计决定、交接……）一律改成消息
          type: question ? 'question' : r.type === 'answer' ? 'answer' : 'message',
          summary,
          claims,
          to_names: parseList(r.manual_to).filter((x): x is string => typeof x === 'string'),
          reply_to: typeof r.reply_to === 'string' ? r.reply_to : null,
          client_id: typeof r.client_id === 'string' ? r.client_id : null,
          created_at: r.created_at as string,
        },
        recipients,
      });
    }
    for (const t of OLD_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
    // repos 重建为 (id, url UNIQUE, created_at)：先拷数据、删旧表，再改名。地址重复的只留最早登记的那个
    const duplicateRepos: string[] = [];
    // 重复的仓库 ID → 留下的那个：挂在重复仓库上的通知改挂过去，否则谁也收不到、也回答不了
    const keptRepo = new Map<string, string>();
    const repoCols = this.columns('repos');
    if (repoCols.size > 0) {
      this.db.exec('CREATE TABLE repos_v2 (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)');
      const repos = this.all<{ id: string; url: string; created_at: string | null }>(`SELECT id, url, ${col(repoCols, 'created_at')} FROM repos ORDER BY created_at`);
      for (const r of repos) {
        if (this.run('INSERT OR IGNORE INTO repos_v2 (id, url, created_at) VALUES (?, ?, ?)', r.id, r.url, r.created_at ?? this.now()) === 0) {
          duplicateRepos.push(r.id);
          const first = this.get<{ id: string }>('SELECT id FROM repos_v2 WHERE url = ?', r.url);
          if (first) keptRepo.set(r.id, first.id);
        }
      }
      this.db.exec('DROP TABLE repos; ALTER TABLE repos_v2 RENAME TO repos;');
    }
    this.db.exec(SCHEMA);
    for (const k of kept) {
      k.notice.repo_id = keptRepo.get(k.notice.repo_id) ?? k.notice.repo_id;
      this.insertNotice(k.notice, []);
      for (const x of k.recipients) {
        this.run('INSERT INTO recipients (notice_id, member_id, delivered_at, delivered_session) VALUES (?, ?, ?, ?)', k.notice.id, x.member_id, x.delivered_at, x.delivered_session);
      }
    }
    return { kept: kept.length, dropped: total - kept.length, duplicateRepos };
  }

  private txDepth = 0;

  /** 一组写操作要么全部生效、要么都不生效。BEGIN IMMEDIATE：和同时打开这个库的管理命令互斥。 */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  now(offsetMs = 0): string {
    return new Date(this.clock() + offsetMs).toISOString();
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  /** 返回改动的行数。 */
  run(sql: string, ...params: unknown[]): number {
    return Number(this.db.prepare(sql).run(...(params as never[])).changes);
  }

  // —— 仓库 ——

  addRepo(url: string, id = newId('r')): RepoRow {
    const created_at = this.now();
    this.run('INSERT INTO repos (id, url, created_at) VALUES (?, ?, ?)', id, url, created_at);
    return { id, url, created_at };
  }
  repos(): RepoRow[] {
    return this.all<RepoRow>('SELECT id, url, created_at FROM repos ORDER BY created_at');
  }
  repo(id: string): RepoRow | undefined {
    return this.get<RepoRow>('SELECT id, url, created_at FROM repos WHERE id = ?', id);
  }
  repoByUrl(url: string): RepoRow | undefined {
    return this.get<RepoRow>('SELECT id, url, created_at FROM repos WHERE url = ?', url);
  }

  // —— 邀请码、成员、设备 ——

  createInvite(): string {
    const code = randomBytes(6).toString('hex');
    this.run('INSERT INTO invites (code, created_at) VALUES (?, ?)', code, this.now());
    return code;
  }
  /** 用掉一个邀请码；没有这个码或者已经用过时返回 false。 */
  useInvite(code: string, memberId: string): boolean {
    return this.run('UPDATE invites SET used_by = ? WHERE code = ? AND used_by IS NULL', memberId, code) === 1;
  }

  addMember(name: string): MemberRow {
    const id = newId('m');
    this.run('INSERT INTO members (id, name, created_at) VALUES (?, ?, ?)', id, name, this.now());
    return { id, name };
  }
  members(): MemberRow[] {
    return this.all<MemberRow>('SELECT id, name FROM members ORDER BY name');
  }
  member(id: string): MemberRow | undefined {
    return this.get<MemberRow>('SELECT id, name FROM members WHERE id = ?', id);
  }
  memberByName(name: string): MemberRow | undefined {
    return this.get<MemberRow>('SELECT id, name FROM members WHERE name = ?', name);
  }

  addDevice(memberId: string, publicKey: string, name: string | null): DeviceRow {
    const id = newId('d');
    this.run('INSERT INTO devices (id, member_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)', id, memberId, publicKey, name, this.now());
    return { id, member_id: memberId, public_key: publicKey };
  }
  device(id: string): DeviceRow | undefined {
    return this.get<DeviceRow>('SELECT id, member_id, public_key FROM devices WHERE id = ?', id);
  }

  // —— 会话 ——

  session(id: string): SessionRow | undefined {
    return this.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  }

  /** 新建会话；同一个会话号换了仓库时从头算。 */
  startSession(id: string, memberId: string, repoId: string, tool: Tool): void {
    const now = this.now();
    this.run(
      `INSERT INTO sessions (id, member_id, repo_id, tool, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET repo_id = excluded.repo_id, tool = excluded.tool, started_at = excluded.started_at,
         last_seen_at = excluded.last_seen_at, ended_at = NULL`,
      id,
      memberId,
      repoId,
      tool,
      now,
      now,
    );
  }
  /** 有活动：更新最近活动时间；结束过的会话（比如 resume）重新算在线。 */
  touchSession(id: string): void {
    this.run('UPDATE sessions SET last_seen_at = ?, ended_at = NULL WHERE id = ?', this.now(), id);
  }
  endSession(id: string): void {
    this.run('UPDATE sessions SET ended_at = ? WHERE id = ?', this.now(), id);
  }
  /** 某个仓库里 sinceIso 之后有过活动的会话，带成员名，最近活动的在前。 */
  recentSessions(repoId: string, sinceIso: string): (SessionRow & { name: string })[] {
    return this.all<SessionRow & { name: string }>(
      'SELECT s.*, m.name AS name FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.repo_id = ? AND s.last_seen_at >= ? ORDER BY s.last_seen_at DESC',
      repoId,
      sinceIso,
    );
  }

  // —— 通知和收件人 ——

  private decodeNotice<T extends Notice>(row: Row): T {
    return {
      ...(row as unknown as T),
      claims: parseList(row.claims) as Claim[],
      to_names: parseList(row.to_names).filter((x): x is string => typeof x === 'string'),
    };
  }

  /** 写入通知和它的收件人（调用方负责放进事务）。 */
  insertNotice(n: Notice, recipientIds: string[]): Notice {
    this.run(
      'INSERT INTO notices (id, repo_id, sender_member_id, sender_session_id, type, summary, claims, to_names, reply_to, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      n.id,
      n.repo_id,
      n.sender_member_id,
      n.sender_session_id,
      n.type,
      n.summary,
      JSON.stringify(n.claims),
      JSON.stringify(n.to_names),
      n.reply_to,
      n.client_id,
      n.created_at,
    );
    for (const m of recipientIds) this.run('INSERT OR IGNORE INTO recipients (notice_id, member_id) VALUES (?, ?)', n.id, m);
    return n;
  }

  notice(id: string): Notice | undefined {
    const row = this.get('SELECT * FROM notices WHERE id = ?', id);
    return row ? this.decodeNotice(row) : undefined;
  }
  noticeByClientId(memberId: string, clientId: string): Notice | undefined {
    const row = this.get('SELECT * FROM notices WHERE sender_member_id = ? AND client_id = ?', memberId, clientId);
    return row ? this.decodeNotice(row) : undefined;
  }
  /** 收件人的成员 ID。 */
  recipientIds(noticeId: string): string[] {
    return this.all<{ member_id: string }>('SELECT member_id FROM recipients WHERE notice_id = ? ORDER BY rowid', noticeId).map((r) => r.member_id);
  }
  isRecipient(noticeId: string, memberId: string): boolean {
    return this.get('SELECT 1 AS x FROM recipients WHERE notice_id = ? AND member_id = ?', noticeId, memberId) !== undefined;
  }

  private queued(where: string, order: string, ...params: unknown[]): QueuedNotice[] {
    return this.all(
      `SELECT n.*, m.name AS sender_name, q.summary AS question, q.sender_session_id AS asker_session
       FROM recipients r JOIN notices n ON n.id = r.notice_id
       LEFT JOIN members m ON m.id = n.sender_member_id
       LEFT JOIN notices q ON q.id = n.reply_to
       WHERE ${where} ORDER BY ${order}`,
      ...params,
    ).map((row) => this.decodeNotice<QueuedNotice>(row));
  }

  /** 这个成员在这个项目里所有没送达的：提问 → 回答 → 消息，同类按创建时间。 */
  pending(memberId: string, repoId: string): QueuedNotice[] {
    return this.queued(
      'r.member_id = ? AND n.repo_id = ? AND r.delivered_at IS NULL',
      "CASE n.type WHEN 'question' THEN 0 WHEN 'answer' THEN 1 ELSE 2 END, n.created_at, n.rowid",
      memberId,
      repoId,
    );
  }
  /** 这个成员在这个项目里 sinceIso 之后收到的全部（不管送没送到），按时间顺序。 */
  received(memberId: string, repoId: string, sinceIso: string): QueuedNotice[] {
    return this.queued('r.member_id = ? AND n.repo_id = ? AND n.created_at >= ?', 'n.created_at, n.rowid', memberId, repoId, sinceIso);
  }

  markDelivered(noticeId: string, memberId: string, sessionId: string): void {
    this.run('UPDATE recipients SET delivered_at = ?, delivered_session = ? WHERE notice_id = ? AND member_id = ? AND delivered_at IS NULL', this.now(), sessionId, noticeId, memberId);
  }

  /** 发送限流用：某个会话（没有会话时按成员）sinceIso 之后发了几条。 */
  sentSince(memberId: string, sessionId: string | null, sinceIso: string): number {
    const row = sessionId
      ? this.get<{ c: number }>('SELECT COUNT(*) AS c FROM notices WHERE sender_session_id = ? AND created_at >= ?', sessionId, sinceIso)
      : this.get<{ c: number }>('SELECT COUNT(*) AS c FROM notices WHERE sender_member_id = ? AND sender_session_id IS NULL AND created_at >= ?', memberId, sinceIso);
    return row?.c ?? 0;
  }
}
