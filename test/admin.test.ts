// 成员和设备管理、邀请码有效期、没送到的消息过期前告诉发送人。
// 自己起一个服务器（startServer({ port: 0 })）；成员直接用签名请求，管理命令用子进程真跑。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/connector/cli.ts';
import { generateDeviceKeys, signRequest } from '../src/shared/crypto.ts';
import { DEVICE_UNKNOWN, PROTOCOL, PROTOCOL_HEADER } from '../src/shared/protocol.ts';
import { INVITE_DAYS } from '../src/server/db.ts';
import type { Engine } from '../src/server/engine.ts';
import { openEngine, startServer, type RunningServer } from '../src/server/main.ts';

const SERVER_BIN = join(resolve(fileURLToPath(new URL('..', import.meta.url))), 'bin/teamlink-server.js');
const DAY = 24 * 3600_000;
const tmp = mkdtempSync(join(tmpdir(), 'teamlink-admin-'));
const dataDir = join(tmp, 'server');
let server: RunningServer;
let engine: Engine;
let repoId: string;

interface Device {
  memberId: string;
  deviceId: string;
  privateKey: string;
}

/** 用邀请码加入（或者加设备）：返回这台设备的身份。 */
function join_(name: string, invite = engine.store.createInvite()): Device {
  const keys = generateDeviceKeys();
  const res = engine.join({ invite, name, publicKey: keys.publicKey, deviceName: `${name} 的电脑` });
  return { memberId: res.memberId, deviceId: res.deviceId, privateKey: keys.privateKey };
}

/** 带设备签名的请求：返回状态码和响应体。 */
async function api(d: Device, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const raw = body ? JSON.stringify({ ...body, nonce: Math.random() }) : '';
  const ts = String(Date.now());
  const res = await fetch(server.url + path, {
    method,
    headers: {
      'content-type': 'application/json',
      [PROTOCOL_HEADER]: String(PROTOCOL),
      'x-tl-device': d.deviceId,
      'x-tl-ts': ts,
      'x-tl-sig': signRequest(d.privateKey, method, path, ts, raw),
    },
    body: method === 'GET' ? undefined : raw,
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

const send = (d: Device, to: string, summary: string) => api(d, 'POST', '/api/v2/notices', { repoId, to: [to], summary });
/** 看收件箱（只看，不记送达）。 */
const inbox = async (d: Device) => (await api(d, 'GET', `/api/v2/inbox?repoId=${repoId}`)).data.text as string;
/** 开工并确认收到：这个成员手上的消息都算送到了。 */
async function receive(d: Device, session: string): Promise<void> {
  const r = await api(d, 'POST', '/api/v2/sessions/start', { repoId, tool: 'claude', sessionId: session, acks: [] });
  await api(d, 'POST', '/api/v2/activity', { repoId, tool: 'claude', sessionId: session, acks: r.data.ids });
}

/** 真跑管理命令（服务器开着的时候另开一个进程改库）。 */
function admin(...argv: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [SERVER_BIN, ...argv, '--data', dataDir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

before(async () => {
  engine = openEngine(dataDir, { log: () => {} });
  repoId = engine.addRepo('git@example.com:team/admin.git').id;
  server = await startServer({ engine, port: 0 });
});

after(async () => {
  await server?.close();
  delete process.env.TEAMLINK_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test('邀请码有效期：默认 7 天，过期以后不能用（403），清理时删掉；这一版以前生成的从升级时起算 7 天', () => {
  const store = engine.store;
  const real = store.clock;
  // 时钟先定住：生成邀请码和下面取时间隔着几行，跨了毫秒就对不上
  const t0 = real();
  let code: string;
  let short: string;
  try {
    store.clock = () => t0;
    code = store.createInvite();
    assert.equal(Date.parse(store.invite(code)?.expires_at ?? '') - t0, INVITE_DAYS * DAY);
    short = store.createInvite({ days: 1 });
    store.clock = () => real() + 2 * DAY;
    assert.throws(() => join_('过期的人', short), /邀请码无效、已用过或已过期/);
    assert.equal(store.memberByName('过期的人'), undefined, '成员没有留下');
    assert.equal(join_('没过期的人', code).deviceId.startsWith('d_'), true);
    engine.prune();
    assert.equal(store.invite(short), undefined, '过期没用的清掉了');
    assert.ok(store.invite(code), '用过的留着');
  } finally {
    store.clock = real;
  }

  // 上一版的库：invites 表没有这两列，里面有一个没用过的邀请码
  const old = join(tmp, 'old');
  openEngine(old, { log: () => {} }).store.db.close();
  const db = new DatabaseSync(join(old, 'teamlink.db'));
  db.exec("ALTER TABLE invites DROP COLUMN expires_at; ALTER TABLE invites DROP COLUMN member_id; INSERT INTO invites (code, created_at) VALUES ('oldcode', '2020-01-01T00:00:00.000Z')");
  db.close();
  const upgraded = openEngine(old, { log: () => {} });
  const left = Date.parse(upgraded.store.invite('oldcode')?.expires_at ?? '') - Date.now();
  assert.ok(left > (INVITE_DAYS - 1) * DAY && left <= INVITE_DAYS * DAY, `从现在起算 ${INVITE_DAYS} 天：${left}`);
  upgraded.store.db.close();
});

test('第二台设备：invite --for 生成的邀请码只能给那个成员加设备，名字不对不行、码还在；普通邀请码遇到重名时提示怎么加设备', async () => {
  const laptop = join_('alice');
  assert.throws(() => join_('alice'), /成员名 alice 已被占用（要给这个成员再加一台设备，请管理员运行 teamlink-server invite --for alice）/);

  const r = admin('invite', '--for', 'alice', '--days', '3');
  assert.equal(r.code, 0, r.err);
  const code = r.out.trim();
  assert.match(code, /^[0-9a-f]{12}$/, '标准输出只有邀请码');
  assert.match(r.err, /3 天内有效，每个只能用一次。只能用来给 alice 加设备/);
  assert.throws(() => join_('mallory', code), /这个邀请码是给 alice 加设备用的/);
  assert.equal(engine.store.memberByName('mallory'), undefined);

  const desktop = join_('alice', code);
  assert.equal(desktop.memberId, laptop.memberId, '同一个成员');
  assert.notEqual(desktop.deviceId, laptop.deviceId);
  assert.throws(() => join_('alice', code), /邀请码无效、已用过或已过期/, '只能用一次');
  for (const d of [laptop, desktop]) assert.deepEqual((await api(d, 'GET', '/api/v2/whoami')).data.member, { id: laptop.memberId, name: 'alice' });

  assert.match(admin('invite', '--for', '没这个人').err, /找不到成员：没这个人。现有成员：/);
  assert.match(admin('invite', '--days', '0').err, /--days 要是 1 到 365 之间的整数/);
});

test('吊销设备：这台设备马上被拒（401，说明要重新加入），同一个成员的另一台照常；带着新邀请码重跑 setup 就重新加入', async () => {
  const a = join_('carol');
  const b = join_('carol', engine.store.createInvite({ memberId: a.memberId }));
  const list = admin('members');
  assert.match(list.out, new RegExp(`carol（${a.memberId}）  最近活动：30 天内没有\\n  设备 ${a.deviceId}  carol 的电脑  \\d{4}-\\d\\d-\\d\\d 登记\\n  设备 ${b.deviceId}  `));

  const r = admin('revoke-device', '--device', a.deviceId);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `已吊销 carol 的设备 ${a.deviceId}（carol 的电脑），这台设备的请求从现在起被拒绝。\ncarol 还有 1 台设备可用。\n`);
  const denied = await api(a, 'GET', '/api/v2/whoami');
  assert.equal(denied.status, 401);
  assert.ok((denied.data.error as string).startsWith(DEVICE_UNKNOWN));
  assert.equal((await api(b, 'GET', '/api/v2/whoami')).status, 200);
  assert.match(admin('revoke-device', '--device', a.deviceId).err, /找不到设备/);
  assert.match(admin('revoke-device', '--device', b.deviceId).out, /carol 没有可用的设备了：teamlink-server invite --for carol/);

  // 连接器：本机记着的身份已经失效，带着加设备的邀请码重跑接入命令
  const home = join(tmp, 'home-carol');
  process.env.TEAMLINK_HOME = home;
  const setup = async (...argv: string[]) => {
    let out = '';
    await runCli(['setup', '--server', server.url, ...argv], tmp, (s) => (out += s));
    return out;
  };
  const saved = () => JSON.parse(readFileSync(join(home, 'identities.json'), 'utf8'))[server.url] as Device;
  await setup('--invite', engine.store.createInvite({ memberId: a.memberId }), '--name', 'carol');
  const first = saved();
  assert.match(await setup('--invite', '000000000000', '--name', 'carol'), /本机已经以 carol 的身份加入过/, '身份还有效时不重新加入');
  engine.revokeDevice(first.deviceId);
  assert.match(await setup('--invite', engine.store.createInvite({ memberId: a.memberId }), '--name', 'carol'), /原来在 .* 的身份（carol）已经失效，用这个邀请码重新加入/);
  assert.notEqual(saved().deviceId, first.deviceId);
  assert.equal(saved().memberId, a.memberId);
  assert.equal((await api(saved(), 'GET', '/api/v2/whoami')).status, 200);
});

test('改名：身份跟着变，按新名字点名能送到，旧名字不认；名字不合规、重名都改不了', async () => {
  const dave = join_('dave');
  const erin = join_('erin');
  assert.match(admin('rename-member', '--name', 'dave', '--to', 'erin').err, /成员名 erin 已被占用/);
  assert.match(admin('rename-member', '--name', 'dave', '--to', '<x>').err, /成员名不能有尖括号/);
  const r = admin('rename-member', '--name', 'dave', '--to', '大卫');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^已把 dave 改名为 大卫。/);
  assert.deepEqual((await api(dave, 'GET', '/api/v2/whoami')).data.member, { id: dave.memberId, name: '大卫' });
  assert.equal((await send(erin, '大卫', '改名以后发的')).status, 200);
  assert.match(await inbox(dave), /消息 · 来自 erin：改名以后发的/);
  const old = await send(erin, 'dave', '按旧名字发的');
  assert.equal(old.status, 400);
  assert.match(old.data.error as string, /找不到成员：dave/);
});

test('移出成员：设备全部失效、名字空出来；发给他没送到的告诉发送人，他发出去没送到的不再送', async () => {
  const frank = join_('frank');
  const grace = join_('grace');
  assert.equal((await send(grace, 'frank', '发给 frank、他还没收到')).status, 200);
  assert.equal((await send(frank, 'grace', 'frank 发的、grace 还没收到')).status, 200);

  const r = admin('remove-member', '--name', 'frank');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '已移出 frank，吊销了他的 1 台设备。发给他、还没送到的消息已经删除，并告诉了发送人。\n');
  assert.equal((await api(frank, 'GET', '/api/v2/whoami')).status, 401);
  assert.ok(!admin('members').out.includes('frank'));

  const text = await inbox(grace);
  assert.match(text, /消息 · 来自 teamlink 服务器：你发的 1 条消息对方一直没有收到，已经删除（frank 已经被移出团队）。还需要的话换个方式告诉对方：\n {4}- \d{4}-\d\d-\d\d 发给 frank 的消息：发给 frank、他还没收到/);
  assert.ok(!text.includes('frank 发的'), '他发出去没送到的不再送');
  assert.equal((await send(grace, 'frank', '再发')).status, 400, '点不到他了');
  assert.notEqual(join_('frank').memberId, frank.memberId, '名字空出来了，新来的人可以用');
  assert.match(admin('remove-member', '--name', '没这个人').err, /找不到成员：没这个人/);
});

test('过期清理：要删的消息里还有人没收到的，先给发送人留一条系统消息；送到了的不提，系统消息自己过期时不再套娃', async () => {
  const heidi = join_('heidi');
  const ivan = join_('ivan');
  const judy = join_('judy');
  assert.equal((await send(heidi, 'ivan', '这条 ivan 收到了')).status, 200);
  await receive(ivan, 's1');
  const ask = await api(heidi, 'POST', '/api/v2/notices', { repoId, to: ['ivan', 'judy'], type: 'question', summary: '问两个人的' });
  assert.equal(ask.status, 200);
  for (let i = 1; i <= 7; i++) assert.equal((await send(heidi, 'judy', `第 ${i} 条，judy 一直没开工`)).status, 200);

  const store = engine.store;
  const real = store.clock;
  try {
    store.clock = () => real() + 31 * DAY;
    // 前面的用例留下的没送到的消息也在这次过期：只看 heidi 的
    assert.ok(engine.prune().told >= 1);
    const told = store.get<{ c: number }>("SELECT COUNT(*) AS c FROM recipients r JOIN notices n ON n.id = r.notice_id WHERE n.sender_member_id = 'teamlink' AND r.member_id = ?", heidi.memberId);
    assert.equal(told?.c, 1, '一个发送人一个仓库只留一条');
    const text = (await engine.inbox({ id: heidi.memberId, name: 'heidi' }, repoId, false)).text;
    assert.match(text, /来自 teamlink 服务器：你发的 8 条消息对方一直没有收到，已经删除（超过 30 天）。/);
    assert.match(text, /\n {4}- \d{4}-\d\d-\d\d 发给 ivan、judy 的提问：问两个人的\n {4}- \d{4}-\d\d-\d\d 发给 judy 的消息：第 1 条，judy 一直没开工\n/);
    assert.match(text, /第 4 条，judy 一直没开工\n {4}另有 3 条。/, '最多列 5 条');
    assert.ok(!text.includes('第 5 条'));
    assert.ok(!text.includes('ivan 收到了'), '送到了的不提');
    assert.equal(engine.inbox({ id: judy.memberId, name: 'judy' }, repoId, false).count, 0, '过期的不再送');

    // 再过 31 天：那条系统消息自己也过期了，没有人可以告诉
    store.clock = () => real() + 62 * DAY;
    assert.equal(engine.prune().told, 0);
    assert.equal(engine.inbox({ id: heidi.memberId, name: 'heidi' }, repoId, false).count, 0);
  } finally {
    store.clock = real;
  }
});
