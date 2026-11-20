// 端到端：服务器这一侧：数据库迁移和升级、清理、管理命令、出错时的响应、部署脚本、HTTPS、停止。
// 公共的环境和辅助函数在 helpers.ts。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, mock, test } from 'node:test';
import { generateDeviceKeys, signRequest } from '../src/shared/crypto.ts';
import { PROTOCOL, PROTOCOL_HEADER } from '../src/shared/protocol.ts';
import { DEFAULT_POLICY } from '../src/shared/rules.ts';
import { SCHEMA_VERSION } from '../src/server/db.ts';
import { certNames, openEngine, startServer } from '../src/server/main.ts';
import { loadPolicy } from '../src/server/policy.ts';
import { reviewMessage } from '../src/shared/review.ts';
import { as, bash, cli, DAY, delivered, devs, engine, memberId, MINUTE, reply, repoId, ROOT, run, server, SERVER_BIN, serverLog, signed, signedAt, sleep, stop, tmp, write } from './helpers.ts';

// —— 15. 迁移 ——

/** 瘦身前（结构版本 0）db.ts 里的 SCHEMA 和 MIGRATIONS，原样拷过来造旧库。 */
const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, default_branch TEXT NOT NULL, mirror_dir TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, git_email TEXT, handle TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, public_key TEXT NOT NULL, name TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_at TEXT NOT NULL, used_by TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, device_id TEXT NOT NULL, tool TEXT NOT NULL, repo_id TEXT NOT NULL,
  branch TEXT, base TEXT, tainted INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_instant_at TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, member_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  ts TEXT NOT NULL, tool_name TEXT, files TEXT NOT NULL, note TEXT
);
CREATE INDEX IF NOT EXISTS activity_repo_ts ON activity(repo_id, ts);
CREATE TABLE IF NOT EXISTS subscriptions (member_id TEXT NOT NULL, repo_id TEXT NOT NULL, glob TEXT NOT NULL, PRIMARY KEY (member_id, repo_id, glob));
CREATE TABLE IF NOT EXISTS branch_heads (repo_id TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (repo_id, branch));
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, type TEXT NOT NULL, origin TEXT NOT NULL,
  sender_member_id TEXT, sender_email TEXT, sender_session_id TEXT,
  branch TEXT NOT NULL, base TEXT, head TEXT, commits TEXT NOT NULL DEFAULT '[]',
  claims TEXT NOT NULL DEFAULT '[]', changes TEXT NOT NULL DEFAULT '[]', unverified TEXT NOT NULL DEFAULT '[]',
  undeclared TEXT NOT NULL DEFAULT '[]', changed_files TEXT NOT NULL DEFAULT '[]', callers TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '', texts TEXT NOT NULL DEFAULT '[]', manual_to TEXT NOT NULL DEFAULT '[]',
  verification TEXT NOT NULL, tainted INTEGER NOT NULL DEFAULT 0,
  risk TEXT NOT NULL DEFAULT 'L0', risk_reasons TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'fyi',
  state TEXT NOT NULL, state_detail TEXT, supersedes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS notices_repo_state ON notices(repo_id, state);
CREATE TABLE IF NOT EXISTS recipients (
  notice_id TEXT NOT NULL, member_id TEXT NOT NULL, reasons TEXT NOT NULL, delivery TEXT NOT NULL,
  approval TEXT, delivered_at TEXT, delivered_session TEXT, retracted_at TEXT,
  PRIMARY KEY (notice_id, member_id)
);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, repo_id TEXT NOT NULL, member_id TEXT NOT NULL, session_id TEXT,
  rule TEXT NOT NULL, level TEXT NOT NULL, detail TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0,
  notify TEXT NOT NULL DEFAULT '[]', acked_at TEXT
);
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts(ts);
`;

/** 给已经部署过的数据库补上后来加的列。 */
const OLD_MIGRATIONS = [
  'ALTER TABLE activity ADD COLUMN detail TEXT',
  'ALTER TABLE notices ADD COLUMN reply_to TEXT',
  'ALTER TABLE notices ADD COLUMN client_id TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS notices_client ON notices(sender_member_id, client_id) WHERE client_id IS NOT NULL',
  // 第一次送达的时间：内容更新要重新投递时 delivered_at 会清空，但“看过某个版本”这件事不能丢（撤回、转发检查要用）
  'ALTER TABLE recipients ADD COLUMN first_delivered_at TEXT',
  'UPDATE recipients SET first_delivered_at = delivered_at WHERE first_delivered_at IS NULL AND delivered_at IS NOT NULL',
  // 会话进度：任务描述、最近的检查结果、未提交改动的规模
  'ALTER TABLE sessions ADD COLUMN task TEXT',
  'ALTER TABLE sessions ADD COLUMN checks TEXT',
  'ALTER TABLE sessions ADD COLUMN wip TEXT',
];

function insertRow(db: DatabaseSync, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as never[]));
}

/**
 * 按旧结构造一个库（和旧版 Store 的构造函数一样：建表、补列）：一个仓库、三个成员、两台设备、邀请码，
 * 要搬过来的通知（没送达的提问、进行中的接口改动、没送达的回答，以及它回的那条已经送到的提问），
 * 要清掉的通知（已送达的、作废的、隔离的、git 自动生成的、8 天前的），以及升级时整张删掉的表里的数据。
 */
function buildOldDb(dir: string, keys: { ming: string; lili: string }) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'teamlink.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(OLD_SCHEMA);
  for (const sql of OLD_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      // 列已经存在
    }
  }
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  insertRow(db, 'repos', { id: 'r_old', url: 'git@example.com:team/demo.git', default_branch: 'main', mirror_dir: join(dir, 'mirrors/r_old.git'), created_at: at(-30 * DAY) });
  insertRow(db, 'members', { id: 'm_ming', name: '阿明', git_email: 'ming@example.com', handle: 'ming', created_at: at(-30 * DAY) });
  insertRow(db, 'members', { id: 'm_lili', name: '丽丽', git_email: null, handle: null, created_at: at(-30 * DAY) });
  insertRow(db, 'members', { id: 'm_wei', name: '大伟', git_email: null, handle: null, created_at: at(-30 * DAY) });
  insertRow(db, 'devices', { id: 'd_ming', member_id: 'm_ming', public_key: keys.ming, name: 'mac', created_at: at(-30 * DAY) });
  insertRow(db, 'devices', { id: 'd_lili', member_id: 'm_lili', public_key: keys.lili, name: 'mac', created_at: at(-30 * DAY) });
  insertRow(db, 'invites', { code: 'a1b2c3d4e5f6', created_at: at(-DAY), used_by: null });
  insertRow(db, 'invites', { code: 'f6e5d4c3b2a1', created_at: at(-30 * DAY), used_by: 'm_wei' });
  const notice = (id: string, p: Record<string, unknown>, recipients: [string, boolean][]) => {
    insertRow(db, 'notices', {
      id,
      repo_id: 'r_old',
      type: 'interface_change',
      origin: 'agent',
      sender_member_id: 'm_ming',
      sender_email: null,
      sender_session_id: 'codex:s1',
      branch: 'main',
      base: null,
      head: null,
      commits: '[]',
      claims: '[]',
      changes: '[]',
      unverified: '[]',
      undeclared: '[]',
      changed_files: '[]',
      callers: '[]',
      summary: '',
      texts: '[]',
      manual_to: '[]',
      verification: 'unverified',
      tainted: 0,
      risk: 'L0',
      risk_reasons: '[]',
      kind: 'fyi',
      state: 'delivered',
      state_detail: null,
      supersedes: null,
      created_at: at(-DAY),
      updated_at: at(-DAY),
      expires_at: null,
      reply_to: null,
      client_id: null,
      ...p,
    });
    for (const [member, done] of recipients) {
      const when = done ? at(-DAY) : null;
      insertRow(db, 'recipients', { notice_id: id, member_id: member, reasons: '[{"kind":"manual"}]', delivery: 'instant', approval: null, delivered_at: when, delivered_session: done ? 'codex:x' : null, retracted_at: null, first_delivered_at: when });
    }
  };
  // 要搬过来的
  notice('n_q1', { type: 'question', summary: '比较接口的方向是 a−b 吗？', manual_to: '["丽丽"]' }, [['m_lili', false]]);
  notice('n_m1', { state: 'in_progress', summary: 'getUser 加了参数', claims: JSON.stringify([{ file: 'src/user.ts', symbol: 'getUser', change: 'signature_changed' }]), manual_to: '["丽丽"]', created_at: at(-DAY + 1000) }, [['m_lili', false]]);
  notice('n_q0', { type: 'question', summary: '你那边做到哪了？', manual_to: '["丽丽"]', created_at: at(-2 * DAY) }, [['m_lili', true]]);
  notice('n_a0', { type: 'answer', sender_member_id: 'm_lili', sender_session_id: 'codex:s2', summary: '做完一半了', manual_to: '["阿明"]', reply_to: 'n_q0', created_at: at(-DAY - 1000) }, [['m_ming', false]]);
  // 要清掉的
  notice('n_done', { type: 'decision', summary: '都送到了', manual_to: '["丽丽"]' }, [['m_lili', true]]);
  notice('n_void', { state: 'void', summary: '作废了' }, [['m_lili', false]]);
  notice('n_quar', { state: 'quarantined', summary: '隔离了' }, [['m_lili', false]]);
  notice('n_git', { origin: 'git', sender_member_id: null, summary: '', changes: '[{"file":"a.ts","symbol":"f","change":"removed"}]' }, [['m_lili', false]]);
  notice('n_old', { type: 'question', summary: '八天前的提问', created_at: at(-8 * DAY) }, [['m_lili', false]]);
  // 升级时整张删掉的表
  insertRow(db, 'sessions', { id: 'codex:s1', member_id: 'm_ming', device_id: 'd_ming', tool: 'codex', repo_id: 'r_old', branch: 'main', base: null, tainted: 0, started_at: at(-DAY), last_seen_at: at(-DAY), last_instant_at: null, ended_at: null, task: '旧的任务描述', checks: null, wip: null });
  insertRow(db, 'activity', { session_id: 'codex:s1', member_id: 'm_ming', repo_id: 'r_old', ts: at(-DAY), tool_name: 'Edit', files: '["a.ts"]', note: null, detail: null });
  insertRow(db, 'alerts', { id: 'a_1', ts: at(-DAY), repo_id: 'r_old', member_id: 'm_ming', session_id: null, rule: 'secret_read', level: 'alarm', detail: 'x', blocked: 0, notify: '[]', acked_at: null });
  insertRow(db, 'audit', { ts: at(-DAY), kind: 'notice_created', data: '{}' });
  insertRow(db, 'subscriptions', { member_id: 'm_ming', repo_id: 'r_old', glob: 'src/**' });
  insertRow(db, 'branch_heads', { repo_id: 'r_old', branch: 'main', sha: 'abc' });
  db.close();
}

function readDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const userVersion = (path: string) => readDb(path, (db) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
const tables = (path: string) =>
  readDb(path, (db) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name));
/** 库的全貌：结构版本、所有表和视图的定义、每张表的行数。 */
const snapshot = (path: string) =>
  readDb(path, (db) => {
    const schema = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all() as { type: string; name: string; sql: string | null }[];
    const rows = Object.fromEntries(schema.filter((s) => s.type === 'table').map((s) => [s.name, (db.prepare(`SELECT COUNT(*) AS c FROM "${s.name}"`).get() as { c: number }).c]));
    return { version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, schema, rows };
  });

test('迁移：旧结构的库升级到现在的版本——先备份，旧设备的签名请求照常通过，没送达的旧提问送到收件人，其余旧通知清掉；add-repo 能成功', async () => {
  const dir = join(tmp, 'migrate');
  const ming = generateDeviceKeys();
  const lili = generateDeviceKeys();
  buildOldDb(dir, { ming: ming.publicKey, lili: lili.publicKey });
  const path = join(dir, 'teamlink.db');
  assert.equal(userVersion(path), 0);
  const logs: string[] = [];
  const e = openEngine(dir, { log: (line) => logs.push(line) });
  try {
    assert.equal(userVersion(path), SCHEMA_VERSION);
    assert.equal(userVersion(`${path}.v1.bak`), 0, '先备份成 teamlink.db.v1.bak，备份是旧结构');
    assert.ok(tables(`${path}.v1.bak`).includes('activity'));
    assert.deepEqual(tables(path), ['devices', 'invites', 'members', 'notices', 'recipients', 'repos', 'sessions']);
    assert.deepEqual(
      e.store.all<{ name: string }>('PRAGMA table_info(repos)').map((c) => c.name),
      ['id', 'url', 'created_at'],
    );
    assert.match(logs.join('\n'), /数据库已升级到结构版本 3，搬过来 4 条通知[^\n]*丢掉 5 条/);
    // 提问、回答保持原类型，其余改成消息；7 天内的提问即使已经送到也搬过来（升级后还能回答，见服务器交接第 6 节第 2 条）
    assert.deepEqual(
      e.store.all<{ id: string; type: string }>('SELECT id, type FROM notices ORDER BY id').map((n) => `${n.id}:${n.type}`),
      ['n_a0:answer', 'n_m1:message', 'n_q0:question', 'n_q1:question'],
    );
    assert.equal(e.store.all('SELECT 1 FROM recipients WHERE delivered_at IS NULL').length, 3, '没送达的收件记录都在');
    assert.equal(e.store.all('SELECT 1 FROM sessions').length, 0, '旧的会话清掉');
    // 旧设备的签名请求照常通过；没送达的旧提问、消息送到收件人
    const s = await startServer({ engine: e, port: 0 });
    try {
      const asLili = { deviceId: 'd_lili', privateKey: lili.privateKey };
      const asMing = { deviceId: 'd_ming', privateKey: ming.privateKey };
      const start = await signedAt(s.url, asLili, 'POST', '/api/v2/sessions/start', { repoId: 'r_old', tool: 'codex', sessionId: 'lili-1' });
      assert.equal(start.status, 200, JSON.stringify(start.body));
      assert.deepEqual(start.body.ids, ['n_q1', 'n_m1']);
      assert.match(start.body.text, /\n\[1\] 提问 · 来自 阿明 · n_q1：比较接口的方向是 a−b 吗？\n/);
      assert.match(start.body.text, /\n\[2\] 消息 · 来自 阿明：getUser 加了参数\n {4}涉及：src\/user\.ts#getUser（签名变了）\n/);
      assert.deepEqual([...start.body.members].sort(), ['丽丽', '大伟', '阿明'].sort());
      const reply = await signedAt(s.url, asLili, 'POST', '/api/v2/notices', { repoId: 'r_old', replyTo: 'n_q1', summary: '是 a−b' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual(reply.body.recipients, ['阿明']);
      const mingStart = await signedAt(s.url, asMing, 'POST', '/api/v2/sessions/start', { repoId: 'r_old', tool: 'claude', sessionId: 'ming-1' });
      assert.equal(mingStart.status, 200);
      assert.match(mingStart.body.text, /\n\[1\] 回答 · 来自 丽丽 · 回复你的提问 n_q0「你那边做到哪了？」：做完一半了\n\[2\] 回答 · 来自 丽丽 · 回复你的提问 n_q1「比较接口的方向是 a−b 吗？」：是 a−b\n/);
      // 旧库里没用过的邀请码还能用
      const joined = await fetch(`${s.url}/api/v2/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: 'a1b2c3d4e5f6', name: '小红', publicKey: generateDeviceKeys().publicKey }) });
      assert.equal(joined.status, 200);
      assert.deepEqual(((await joined.json()) as { repos: unknown }).repos, [{ id: 'r_old', url: 'git@example.com:team/demo.git' }]);
    } finally {
      await s.close();
    }
  } finally {
    e.store.db.close();
  }
  // add-repo 能成功（只登记、不 clone，地址不存在也行），结构版本还是 2；第二次打开不再迁移
  const missing = join(tmp, 'no/such/repo.git');
  const add = await run(process.execPath, [SERVER_BIN, 'add-repo', '--repo', missing, '--data', dir]);
  assert.equal(add.code, 0, add.out + add.err);
  assert.match(add.out, /^已登记仓库 /);
  assert.equal(userVersion(path), SCHEMA_VERSION);
  const again = openEngine(dir, { log: () => {} });
  try {
    assert.equal(again.store.migration, null);
    assert.ok(again.store.repoByUrl(missing));
  } finally {
    again.store.db.close();
  }
});

test('迁移：中途出错时回滚，库保持原样，报错并以非 0 退出（不带着旧结构继续跑）', async () => {
  const dir = join(tmp, 'migrate-fail');
  buildOldDb(dir, { ming: generateDeviceKeys().publicKey, lili: generateDeviceKeys().publicKey });
  const path = join(dir, 'teamlink.db');
  // 一个引用旧表的视图：删掉旧表以后 repos 改名会报错，正好落在迁移中途
  const raw = new DatabaseSync(path);
  raw.exec('CREATE VIEW broken AS SELECT * FROM activity');
  raw.close();
  const before = snapshot(path);
  const r = await run(process.execPath, [SERVER_BIN, 'start', '--port', '0', '--data', dir], { until: /服务器已启动/ });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /数据库升级失败，已回滚，库保持原样/);
  assert.doesNotMatch(r.out, /服务器已启动/);
  assert.deepEqual(snapshot(path), before, '库保持原样');
  assert.equal(before.version, 0);
  assert.throws(() => openEngine(dir, { log: () => {} }), /数据库升级失败，已回滚，库保持原样/);
  assert.deepEqual(snapshot(path), before);
  // 失败了两次，一份备份都不留：库没变，备份没用；run.sh 每 3 秒重启一次时，不会每次多一份整库副本
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.bak')), []);
  // 修好以后能再迁移；teamlink.db.v1.bak 已经有了（以前升级过、又用它降级回去），这次的备份名加时间戳，原来那份不动
  writeFileSync(`${path}.v1.bak`, '以前的备份');
  const fix = new DatabaseSync(path);
  fix.exec('DROP VIEW broken');
  fix.close();
  openEngine(dir, { log: () => {} }).store.db.close();
  assert.equal(userVersion(path), SCHEMA_VERSION);
  assert.equal(readFileSync(`${path}.v1.bak`, 'utf8'), '以前的备份');
  assert.ok(readdirSync(dir).some((f) => /^teamlink\.db\.v1\.\d{4}-.+\.bak$/.test(f)), readdirSync(dir).join(' '));
});

test('迁移：备份中途失败时不留下半个备份文件（不占着 teamlink.db.v1.bak 这个名字）；问题过去以后再打开，备份就是完整的 teamlink.db.v1.bak', async () => {
  const dir = join(tmp, 'migrate-backup-fail');
  buildOldDb(dir, { ming: generateDeviceKeys().publicKey, lili: generateDeviceKeys().publicKey });
  const path = join(dir, 'teamlink.db');
  const db = new DatabaseSync(path);
  const pad = db.prepare("INSERT INTO audit (ts, kind, data) VALUES ('2026-01-01T00:00:00.000Z', 'x', ?)");
  db.exec('BEGIN');
  for (let i = 0; i < 2000; i++) pad.run('x'.repeat(400));
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  // 用一页坏数据代替“磁盘满、I/O 错误”这类暂时的问题：备份（VACUUM INTO）读到它就失败。最后几页都是 audit 表的数据
  const size = statSync(path).size;
  const page = size - 4096 * 3;
  const fd = openSync(path, 'r+');
  const saved = Buffer.alloc(4096);
  readSync(fd, saved, 0, 4096, page);
  writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, page);
  closeSync(fd);
  assert.throws(() => openEngine(dir, { log: () => {} }), /升级前备份数据库失败，没有升级，库保持原样/);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.bak')), [], '不留下空的备份文件');
  assert.equal(userVersion(path), 0);
  // 问题过去了（把那一页恢复原样）：这次的备份就是 teamlink.db.v1.bak，降级时用它能换回完整的旧库
  const restore = openSync(path, 'r+');
  writeSync(restore, saved, 0, 4096, page);
  closeSync(restore);
  const e = openEngine(dir, { log: () => {} });
  try {
    assert.equal(e.store.migration?.backup, `${path}.v1.bak`);
  } finally {
    e.store.db.close();
  }
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.bak')), ['teamlink.db.v1.bak']);
  assert.equal(userVersion(`${path}.v1.bak`), 0);
  assert.equal(readDb(`${path}.v1.bak`, (b) => (b.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c), 3, '备份里成员都在');
});

test('迁移：同一个地址登记过两次时，挂在后登记那个仓库上的在途提问改挂到留下的仓库，照常送到、能回答', async () => {
  const dir = join(tmp, 'migrate-dup');
  buildOldDb(dir, { ming: generateDeviceKeys().publicKey, lili: generateDeviceKeys().publicKey });
  const raw = new DatabaseSync(join(dir, 'teamlink.db'));
  insertRow(raw, 'repos', { id: 'r_dup', url: 'git@example.com:team/demo.git', default_branch: 'main', mirror_dir: join(dir, 'mirrors/r_dup.git'), created_at: new Date(Date.now() - DAY).toISOString() });
  raw.prepare("UPDATE notices SET repo_id = 'r_dup' WHERE id = 'n_q1'").run();
  raw.close();
  const logs: string[] = [];
  const e = openEngine(dir, { log: (line) => logs.push(line) });
  try {
    assert.deepEqual(e.store.repos().map((r) => r.id), ['r_old']);
    assert.match(logs.join('\n'), /这些仓库和更早登记的地址重复，没有搬过来：r_dup/);
    assert.equal(e.store.notice('n_q1')?.repo_id, 'r_old');
    const lili = e.store.member('m_lili') ?? assert.fail('没有丽丽');
    const got = e.deliver(lili, { repoId: 'r_old', tool: 'codex', sessionId: 'lili-dup', kind: 'start' });
    assert.deepEqual(got.ids, ['n_q1', 'n_m1']);
    const answer = e.send(lili, { repoId: 'r_old', sessionKey: null, summary: '是 a−b', to: [], replyTo: 'n_q1', clientId: null });
    assert.deepEqual(answer.recipients, ['阿明']);
  } finally {
    e.store.db.close();
  }
});

test('迁移：服务器和管理命令同时打开旧库时，只有拿到锁的那个去备份和迁移，其余的等它做完，都能成功', async () => {
  const dir = join(tmp, 'migrate-race');
  buildOldDb(dir, { ming: generateDeviceKeys().publicKey, lili: generateDeviceKeys().publicKey });
  const path = join(dir, 'teamlink.db');
  // 多一点数据，让备份和迁移花一点时间，几个进程才会真的撞在一起
  const db = new DatabaseSync(path);
  const pad = db.prepare("INSERT INTO audit (ts, kind, data) VALUES ('2026-01-01T00:00:00.000Z', 'x', ?)");
  db.exec('BEGIN');
  for (let i = 0; i < 20_000; i++) pad.run('x'.repeat(200));
  db.exec('COMMIT');
  db.close();
  const runs = await Promise.all([0, 1, 2, 3].map((i) => run(process.execPath, [SERVER_BIN, 'add-repo', '--repo', `git@example.com:team/race${i}.git`, '--data', dir])));
  for (const r of runs) assert.equal(r.code, 0, r.out + r.err);
  assert.equal(runs.filter((r) => r.err.includes('数据库已升级到结构版本 3')).length, 1, '只有一个去迁移');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.bak')), ['teamlink.db.v1.bak'], '只备份一份');
  assert.equal(userVersion(path), SCHEMA_VERSION);
  const e = openEngine(dir, { log: () => {} });
  try {
    assert.equal(e.store.repos().length, 5);
    assert.equal(e.store.all('SELECT 1 FROM notices').length, 4);
  } finally {
    e.store.db.close();
  }
});

// —— 16. 清理 ——

test('清理：engine.prune() 删掉 30 天没活动的会话、30 天前的通知（连同收件记录），新的留着；startServer 启动时也清一次', async () => {
  const s = engine.store;
  const old = new Date(Date.now() - 31 * DAY).toISOString();
  s.startSession('claude:prune-old', memberId('bob'), repoId, 'claude');
  s.run("UPDATE sessions SET last_seen_at = ? WHERE id = 'claude:prune-old'", old);
  s.startSession('claude:prune-new', memberId('bob'), repoId, 'claude');
  const notice = (id: string, createdAt: string) =>
    s.transaction(() =>
      s.insertNotice(
        { id, repo_id: repoId, sender_member_id: memberId('alice'), sender_session_id: null, type: 'message', summary: id, claims: [], to_names: ['bob'], reply_to: null, client_id: null, created_at: createdAt, via: null },
        [memberId('bob')],
      ),
    );
  notice('n_prune_old', old);
  notice('n_prune_new', new Date().toISOString());
  const r = engine.prune();
  assert.ok(r.sessions >= 1 && r.notices >= 1, JSON.stringify(r));
  assert.equal(s.session('claude:prune-old'), undefined);
  assert.ok(s.session('claude:prune-new'));
  assert.equal(s.notice('n_prune_old'), undefined);
  assert.equal(s.all("SELECT 1 FROM recipients WHERE notice_id = 'n_prune_old'").length, 0, '收件记录一起删');
  assert.ok(s.notice('n_prune_new'));
  assert.equal(s.all("SELECT 1 FROM recipients WHERE notice_id = 'n_prune_new'").length, 1);
  // startServer 启动时跑一次
  notice('n_prune_boot', old);
  const booted = await startServer({ engine, port: 0 });
  await booted.close();
  assert.equal(s.notice('n_prune_boot'), undefined);
  assert.ok(serverLog.some((l) => / pruned \{/.test(l)));
  // 之后每小时一次（setInterval）
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const hourly = await startServer({ engine, port: 0 });
    notice('n_prune_hourly', old);
    mock.timers.tick(59 * MINUTE);
    assert.ok(s.notice('n_prune_hourly'), '不到一小时不清');
    mock.timers.tick(MINUTE);
    assert.equal(s.notice('n_prune_hourly'), undefined, '一小时后又清了一次');
    await hourly.close();
  } finally {
    mock.timers.reset();
  }
});

// —— 17. 服务器命令 ——

test('服务器命令：start 带 --poll、--no-dashboard-auth 不报错；init、add-repo 只登记不 clone（地址不存在也能成功），也接受位置参数；policy 的两个参数都能用；token 已删掉', async () => {
  const dir = join(tmp, 'server-cli');
  const tl = (args: string[], until?: RegExp) => run(process.execPath, [SERVER_BIN, ...args, '--data', dir], { until });
  const init = await tl(['init', '--repo', 'git@example.com:team/cli.git']);
  assert.equal(init.code, 0, init.err);
  assert.match(init.out, /^已登记仓库 git@example\.com:team\/cli\.git\n {2}仓库 ID：r_[0-9a-f]{10}\n {2}邀请码：[0-9a-f]{12}\n$/);
  assert.match((await tl(['init', 'git@example.com:team/cli.git'])).out, /仓库已经登记过/, '位置参数也认');
  const missing = join(tmp, 'no/such/other.git');
  const add = await tl(['add-repo', '--repo', missing, '--branch', 'main']);
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /^已登记仓库 /);
  assert.equal((await tl(['add-repo', 'https://example.invalid/team/third.git'])).code, 0);
  assert.ok(!existsSync(join(dir, 'mirrors')), '不 clone');
  const e = openEngine(dir, { log: () => {} });
  assert.deepEqual(e.store.repos().map((r) => r.url), ['git@example.com:team/cli.git', missing, 'https://example.invalid/team/third.git']);
  e.store.db.close();

  const start = await tl(['start', '--poll', '10', '--no-dashboard-auth', '--port', '0'], /服务器已启动/);
  assert.match(start.out, /已忽略 --poll/);
  assert.match(start.out, /已忽略 --no-dashboard-auth/);
  assert.match(start.out, /teamlink 服务器已启动，监听 127\.0\.0\.1:\d+（协议版本 2）/);
  assert.doesNotMatch(start.out, /口令/, '不再生成看板口令');
  assert.match(start.err, /^(\S+ backup \{"file":"[^"]+"\}\n)?\S+ stopping \{"signal":"SIGTERM"\}\n$/, '除了当天的备份和收到停止信号这两行，没有别的输出');

  // 旧版 policy.json 里的其他字段（拦截、批准、任务共享……）直接忽略，保存时去掉
  write(dir, 'policy.json', JSON.stringify({ ...DEFAULT_POLICY, block: ['secret_read'], riskyNotices: 'approve', shareTasks: false, notifyOwners: true, massDeleteThreshold: 20 }));
  const policy = await tl(['policy', '--allow-domain', 'docs.example.com', '--remove-domain', 'gitee.com']);
  assert.equal(policy.code, 0, policy.err);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8'))), ['allowDomains']);
  const p = loadPolicy(dir);
  assert.ok(p.allowDomains.includes('docs.example.com'));
  assert.ok(!p.allowDomains.includes('gitee.com'));
  assert.deepEqual(reviewMessage(['文档见 https://docs.example.com/api'], p.allowDomains), [], '加进白名单的域名可以出现在消息里');
  assert.notDeepEqual(reviewMessage(['见 https://gitee.com/x/y'], p.allowDomains), [], '删掉的域名不行了');
  const show = await tl(['policy']);
  assert.match(show.out, /^消息里的链接只允许指向这些域名（含子域名）：.*docs\.example\.com/);
  assert.match((await tl(['policy', '--confirm-after-injection', 'off'])).err, /不认识的参数 --confirm-after-injection/, '联网确认的开关删掉了');

  assert.equal((await tl(['token'])).code, 1, 'token 命令删掉了');
  const invites = await tl(['invite', '--count', '3']);
  assert.equal(invites.out.trim().split('\n').length, 3);
});

// —— 4.11 服务器错误、部署脚本 ——

test('服务器错误：处理请求时出了意外的错，返回 500，打到服务器日志（stderr）', async () => {
  const original = engine.inbox;
  engine.inbox = () => {
    throw new Error('模拟的意外错误');
  };
  try {
    const r = await signed(devs.alice, 'GET', `/api/v2/inbox?repoId=${repoId}`);
    assert.equal(r.status, 500);
    assert.equal(r.protocol, '2');
  } finally {
    engine.inbox = original;
  }
  assert.ok(serverLog.some((l) => / server_error \{.*模拟的意外错误/.test(l)));
});

test('服务器错误：解析不了的请求地址（GET //[）返回 400，服务器进程不退出', async () => {
  const { port } = new URL(server.url);
  const response = await new Promise<string>((ok) => {
    let got = '';
    const sock = connect(Number(port), '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    sock.on('data', (d) => (got += d));
    sock.on('close', () => ok(got));
    sock.on('error', () => ok(got));
    // 地址解析抛到 try 外面时什么也不回、连接也不关：2 秒没动静就算没有响应，免得整个测试文件卡住
    sock.setTimeout(2000, () => sock.destroy());
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200, '服务器还在');
});

test('部署脚本：语法正确；服务器端不用 git、python，启动命令和 env 模板不带 --poll；crontab 分支先结束旧循环再启动新的；push.sh 不再提看板口令', () => {
  for (const f of ['deploy/install-server.sh', 'deploy/push.sh', 'src/server/install.sh']) execFileSync('bash', ['-n', join(ROOT, f)]);
  const script = readFileSync(join(ROOT, 'deploy/install-server.sh'), 'utf8');
  const code = script
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(code, /\bgit\b|\bpython3?\b/);
  assert.doesNotMatch(script, /--poll|POLL/);
  const cron = script.slice(script.indexOf('crontab -l'));
  const kill = cron.indexOf('pkill -f "$BASE/run.sh"');
  assert.ok(kill > 0 && kill < cron.indexOf('nohup setsid "$BASE/run.sh"'), '先 pkill 旧循环，再 nohup 启动');
  assert.doesNotMatch(readFileSync(join(ROOT, 'deploy/push.sh'), 'utf8'), /token|看板/);
});

// —— HTTPS ——

/** 用 openssl 造一张 localhost 的自签证书；机器上没有 openssl 时返回 null。 */
function selfSigned(dir: string): { cert: string; key: string } | null {
  mkdirSync(dir, { recursive: true });
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:*.example.com'], { stdio: 'ignore' });
  return r.status === 0 && existsSync(cert) && existsSync(key) ? { cert, key } : null;
}

/** 不验证书的 HTTPS GET（自签证书）。 */
function tlsGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = httpsRequest(url, { method: 'GET', rejectUnauthorized: false, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('HTTPS：start 给了 --cert 和 --key 就走 HTTPS，安装脚本里的服务器地址也是 https；只给一个报错；接入命令按证书上的域名打印', async (t) => {
  const tls = selfSigned(join(tmp, 'tls'));
  if (!tls) return t.skip('这台机器上没有 openssl');
  assert.deepEqual(certNames(readFileSync(tls.cert, 'utf8')), ['localhost'], '通配符的不算');
  const e = openEngine(join(tmp, 'tls-server'), { log: () => {} });
  const s = await startServer({ engine: e, port: 0, tls });
  try {
    assert.match(s.url, /^https:\/\//);
    const port = new URL(s.url).port;
    const health = await tlsGet(`https://localhost:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, protocol: PROTOCOL });
    const script = await tlsGet(`https://localhost:${port}/install.sh`);
    assert.match(script.body, new RegExp(`\\nSERVER="https://localhost:${port}"\\n`));
    // 明文 HTTP 连不上这个端口
    await assert.rejects(fetch(`http://localhost:${port}/healthz`));
  } finally {
    await s.close();
    e.store.db.close();
  }
  const dir = join(tmp, 'tls-cli');
  const one = await run(process.execPath, [SERVER_BIN, 'start', '--port', '0', '--data', dir, '--cert', tls.cert]);
  assert.equal(one.code, 1);
  assert.match(one.err, /--cert 和 --key 要一起给/);
  const bad = await run(process.execPath, [SERVER_BIN, 'start', '--port', '0', '--data', dir, '--cert', join(tmp, 'nope.pem'), '--key', tls.key]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /读不了证书文件/);
  const started = await run(process.execPath, [SERVER_BIN, 'start', '--port', '0', '--data', dir, '--cert', tls.cert, '--key', tls.key], { until: /NODE_EXTRA_CA_CERTS/ });
  assert.match(started.out, /teamlink 服务器已启动，监听 127\.0\.0\.1:\d+（协议版本 2，HTTPS）/);
  assert.match(started.out, /curl -fsSL https:\/\/localhost:\d+\/install\.sh \| bash -s -- --invite 邀请码 --name 名字/);
});

// —— 从上一版升级 ——

/** 上一版（结构版本 2）的表结构：没有 acked_at、attempts、via。 */
const SCHEMA_V2 = `
CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, git_email TEXT, handle TEXT, created_at TEXT NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, public_key TEXT NOT NULL, name TEXT, created_at TEXT NOT NULL);
CREATE TABLE invites (code TEXT PRIMARY KEY, created_at TEXT NOT NULL, used_by TEXT);
CREATE TABLE repos (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, repo_id TEXT NOT NULL, tool TEXT NOT NULL, started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE notices (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, sender_member_id TEXT NOT NULL, sender_session_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('message', 'question', 'answer')), summary TEXT NOT NULL,
  claims TEXT NOT NULL DEFAULT '[]', to_names TEXT NOT NULL DEFAULT '[]', reply_to TEXT, client_id TEXT,
  created_at TEXT NOT NULL, UNIQUE (sender_member_id, client_id)
);
CREATE TABLE recipients (notice_id TEXT NOT NULL, member_id TEXT NOT NULL, delivered_at TEXT, delivered_session TEXT, PRIMARY KEY (notice_id, member_id));
PRAGMA user_version = 2;
`;

test('升级：上一版（结构版本 2）的库原地加列升到 3——成员、消息都在；升级前送达的算确认过、不重发，没送达的照常送到；几个进程同时打开也只升一次', async () => {
  const dir = join(tmp, 'upgrade-v2');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'teamlink.db');
  const keys = generateDeviceKeys();
  const now = new Date().toISOString();
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_V2);
  db.exec(`
    INSERT INTO members (id, name, created_at) VALUES ('m_ming', '阿明', '${now}'), ('m_lili', '丽丽', '${now}');
    INSERT INTO repos (id, url, created_at) VALUES ('r_1', 'git@example.com:team/up.git', '${now}');
    INSERT INTO notices (id, repo_id, sender_member_id, type, summary, created_at) VALUES
      ('n_old_done', 'r_1', 'm_ming', 'message', '升级前已经送到的', '${now}'),
      ('n_old_mid', 'r_1', 'm_ming', 'message', '升级以后、旧服务器还在跑的时候送到的', '${now}'),
      ('n_old_wait', 'r_1', 'm_ming', 'message', '升级前还没送到的', '${now}');
    INSERT INTO recipients (notice_id, member_id, delivered_at, delivered_session) VALUES
      ('n_old_done', 'm_lili', '${now}', 'codex:old'),
      ('n_old_mid', 'm_lili', NULL, NULL),
      ('n_old_wait', 'm_lili', NULL, NULL);
  `);
  db.prepare("INSERT INTO devices (id, member_id, public_key, created_at) VALUES ('d_lili', 'm_lili', ?, ?)").run(keys.publicKey, now);
  db.close();

  // 几个管理命令同时打开：都成功，只有一个去升级
  const runs = await Promise.all([0, 1, 2].map(() => run(process.execPath, [SERVER_BIN, 'invite', '--data', dir])));
  for (const r of runs) assert.equal(r.code, 0, r.out + r.err);
  assert.equal(runs.filter((r) => r.err.includes('数据库已升级到结构版本 3')).length, 1);
  assert.equal(userVersion(path), SCHEMA_VERSION);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.bak')), [], '只加列，不用备份');

  // 库升级了、上一版的服务器进程还在跑：它送达时只记 delivered_at，不加次数、不确认（下面是它用的那句 SQL）
  const old = new DatabaseSync(path);
  old.prepare("UPDATE recipients SET delivered_at = ?, delivered_session = ? WHERE notice_id = 'n_old_mid' AND member_id = 'm_lili' AND delivered_at IS NULL").run(now, 'codex:old');
  old.close();

  const e = openEngine(dir, { log: () => {} });
  const s = await startServer({ engine: e, port: 0 });
  try {
    const cols = (table: string) => e.store.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    assert.ok(cols('recipients').includes('acked_at') && cols('recipients').includes('attempts'));
    assert.ok(cols('notices').includes('via'));
    // 0.3 加的回答依据：只加列（addColumns），结构版本还是 3，上一版的服务器照样能打开
    assert.ok(cols('notices').includes('basis'));
    assert.equal(userVersion(path), 3);
    assert.deepEqual(
      e.store.all<{ notice_id: string; acked: number; attempts: number }>('SELECT notice_id, acked_at IS NOT NULL AS acked, attempts FROM recipients ORDER BY notice_id').map((r) => ({ ...r })),
      [
        { notice_id: 'n_old_done', acked: 1, attempts: 1 },
        { notice_id: 'n_old_mid', acked: 1, attempts: 1 },
        { notice_id: 'n_old_wait', acked: 0, attempts: 0 },
      ],
    );
    const lili = { deviceId: 'd_lili', privateKey: keys.privateKey };
    const start = await signedAt(s.url, lili, 'POST', '/api/v2/sessions/start', { repoId: 'r_1', tool: 'codex', sessionId: 'lili-up', acks: [] });
    assert.deepEqual(start.body.ids, ['n_old_wait'], '只送还没送到的那条：旧服务器送过的不重发');
    assert.match(start.body.text, /\n\[1\] 消息 · 来自 阿明：升级前还没送到的\n/);
  } finally {
    await s.close();
    e.store.db.close();
  }
});

// —— 服务器停止 ——

test('teamlink-server start：收到 SIGTERM 正常退出（退出码 0），日志里记一行', async () => {
  const dir = mkdtempSync(join(tmp, 'server-stop-'));
  const r = await run(process.execPath, [SERVER_BIN, 'start', '--port', '0', '--data', dir], { until: /服务器已启动/ });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /stopping.*SIGTERM/);
});

test('服务器停止（drain）：进行中的请求照常答完，答完就断开连接，不在这条连接上接新请求', async () => {
  const e = openEngine(mkdtempSync(join(tmp, 'server-drain-')), { log: () => {} });
  const s = await startServer({ engine: e, port: 0 });
  const sock = connect(Number(new URL(s.url).port), '127.0.0.1');
  let got = '';
  sock.on('data', (d) => (got += d));
  const closed = new Promise<void>((ok) => sock.once('close', () => ok()));
  await new Promise((ok) => sock.once('connect', ok));
  // 请求发到一半时开始停止
  sock.write(`POST /api/v2/join HTTP/1.1\r\nHost: x\r\n${PROTOCOL_HEADER}: ${PROTOCOL}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{`);
  await sleep(50);
  const drained = s.drain();
  await sleep(50);
  sock.write('}');
  await Promise.all([closed, drained]);
  assert.match(got, /^HTTP\/1\.1 400 /, '进行中的请求答完了');
  assert.equal(got.match(/HTTP\/1\.1 /g)?.length, 1);
  e.store.db.close();
});

test('服务器停止（drain）：别的请求答完时，不会把读得慢的客户端还没收完的响应切断', async () => {
  const e = openEngine(mkdtempSync(join(tmp, 'server-drain-slow-')), { log: () => {} });
  const repo = e.addRepo('git@example.com:team/drain.git');
  const keys = generateDeviceKeys();
  const a = e.join({ invite: e.store.createInvite(), name: 'a', publicKey: keys.publicKey, deviceName: null });
  const b = e.join({ invite: e.store.createInvite(), name: 'b', publicKey: generateDeviceKeys().publicKey, deviceName: null });
  // 响应要比本机的套接字缓冲区大（约 6 MB）：服务器 end() 以后还有数据等着写出去
  e.store.transaction(() => {
    for (let i = 0; i < 4000; i++) {
      e.store.insertNotice(
        { id: `n_drain${i}`, repo_id: repo.id, sender_member_id: b.memberId, sender_session_id: null, type: 'message', summary: '长'.repeat(500), claims: [], to_names: ['a'], reply_to: null, client_id: null, created_at: e.store.now(), via: null },
        [a.memberId],
      );
    }
  });
  const s = await startServer({ engine: e, port: 0 });
  const port = Number(new URL(s.url).port);
  const path = `/api/v2/inbox?repoId=${repo.id}&all=1`;
  const ts = String(Date.now());
  const slow = connect(port, '127.0.0.1');
  let got = '';
  slow.setEncoding('utf8');
  slow.on('data', (d) => (got += d));
  slow.on('error', () => {});
  const closed = new Promise<void>((ok) => slow.once('close', () => ok()));
  slow.pause();
  slow.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n${PROTOCOL_HEADER}: ${PROTOCOL}\r\nx-tl-device: ${a.deviceId}\r\nx-tl-ts: ${ts}\r\nx-tl-sig: ${signRequest(keys.privateKey, 'GET', path, ts, '')}\r\n\r\n`);
  // 另一个请求发到一半时开始停止，停止过程中答完
  const other = connect(port, '127.0.0.1');
  other.on('error', () => {});
  other.write(`POST /api/v2/join HTTP/1.1\r\nHost: x\r\n${PROTOCOL_HEADER}: ${PROTOCOL}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{`);
  await sleep(300);
  const drained = s.drain();
  await sleep(50);
  other.write('}');
  await sleep(200);
  slow.resume();
  await Promise.all([closed, drained]);
  assert.match(got, /^HTTP\/1\.1 200 /);
  assert.ok(got.endsWith('\r\n0\r\n\r\n'), `慢的客户端收到的响应不完整（${Buffer.byteLength(got)} 字节）`);
  e.store.db.close();
});
