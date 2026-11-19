// 端到端：签名和防重放、加入团队、版本握手。
// 公共的环境和辅助函数在 helpers.ts。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { generateDeviceKeys, signRequest } from '../src/shared/crypto.ts';
import { PROTOCOL, PROTOCOL_HEADER } from '../src/shared/protocol.ts';
import type { RunningServer } from '../src/server/main.ts';
import { as, bash, delivered, type Dev, devs, engine, fails, fetchesDuring, fresh, hook, hookLog, identity, latestNotice, memberId, MINUTE, noticeCount, postTool, received, remote, repoId, ROOT, server, sh, signed, stop, tmp, write } from './helpers.ts';

// —— 1. 签名和重放 ——

test('签名和重放：没有签名、签名无效、过期、换一种 base64 写法、改了请求体或者重放的请求都被拒（401）', async () => {
  const id = identity(devs.alice);
  const headers = (sig: string, ts: string) => ({ 'x-tl-device': id.deviceId, 'x-tl-ts': ts, 'x-tl-sig': sig });
  const whoami = (h: Record<string, string>) => fetch(`${server.url}/api/v2/whoami`, { headers: { [PROTOCOL_HEADER]: String(PROTOCOL), ...h } }).then((r) => r.status);
  const ts = String(Date.now());
  const sig = signRequest(id.privateKey, 'GET', '/api/v2/whoami', ts, '');
  assert.equal(await whoami({}), 401, '没有签名');
  assert.equal(await whoami(headers(sig.replace(/=+$/, ''), ts)), 401, '去掉补位的写法不能当成新请求');
  assert.equal(await whoami(headers(sig, ts)), 200);
  assert.equal(await whoami(headers(sig, ts)), 401, '同一个签名不能用两次');
  assert.equal(await whoami(headers('AAAA', String(Date.now()))), 401, '签名无效');
  const stale = String(Date.now() - 10 * MINUTE);
  assert.equal(await whoami(headers(signRequest(id.privateKey, 'GET', '/api/v2/whoami', stale, ''), stale)), 401, '过期');
  // 签名覆盖请求体：签的是一份、发的是另一份
  const t2 = String(Date.now());
  const body = JSON.stringify({ repoId, summary: '原文', to: ['bob'] });
  const res = await fetch(`${server.url}/api/v2/notices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL), ...headers(signRequest(id.privateKey, 'POST', '/api/v2/notices', t2, body), t2) },
    body: body.replace('原文', '改过'),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get(PROTOCOL_HEADER), '2', '出错的响应也带协议头');
});

test('加入团队：成员名当场校验（控制字符、换行、看不见的字符、尖括号、前后空格、长度 1 到 32），服务器也查；请求体不是 JSON 对象时 400；名字被占用 409，邀请码不对 403 时不留下成员', async () => {
  const dev: Dev = { name: 'joiner', dir: tmp, home: join(tmp, 'home-joiner') };
  const local = await fetchesDuring(() => fails(dev, 'join', server.url, '--invite', 'x', '--name', '阿\n明'));
  assert.match(local.result, /成员名不能有控制字符和换行/);
  assert.deepEqual(local.urls, [], '命令行先查，不联网');
  assert.match(await fails(dev, 'join', server.url, '--invite', 'x', '--name', '名'.repeat(33)), /成员名最长 32 个字/);
  const keys = generateDeviceKeys();
  const postJoin = (body: Record<string, unknown>) =>
    fetch(`${server.url}/api/v2/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: keys.publicKey, ...body }) }).then((r) => r.status);
  assert.equal(await postJoin({ invite: engine.store.createInvite(), name: 'tab\there' }), 400);
  assert.equal(await postJoin({ invite: engine.store.createInvite(), name: 'x'.repeat(33) }), 400);
  assert.equal(await postJoin({ invite: engine.store.createInvite(), name: 'erin ' }), 400, '前后有空格的名字点不了名');
  assert.equal(await postJoin({ invite: engine.store.createInvite(), name: 'alice' }), 409);
  assert.equal(await postJoin({ invite: 'not-an-invite', name: 'erin2' }), 403);
  assert.equal(engine.store.memberByName('erin2'), undefined, '邀请码不对时不留下成员');
  // 显示出来会和别人一样的名字：夹着看不见的字符、带尖括号
  assert.equal(await postJoin({ invite: engine.store.createInvite(), name: 'alice\u{e0041}' }), 400);
  assert.equal(await postJoin({ invite: engine.store.createInvite(), name: 'al\u200bice' }), 400);
  assert.equal(await postJoin({ invite: engine.store.createInvite(), name: 'alice<team-notices-x>' }), 400);
  // 请求体不是 JSON 对象：400，不是 500
  for (const body of ['null', '[]', '"x"']) {
    assert.equal((await fetch(`${server.url}/api/v2/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400, body);
  }
});

// —— 2. 版本握手 ——

/** 瘦身前最后一个提交：里面有旧版连接器的渲染函数 renderInbox，也用它起旧版服务器（旧服务器加载时要用 typescript，没装依赖时跳过）。 */
const OLD_COMMIT = '92ad48acb943a7c84e545f76bc8390c951a8d683';
const OLD_SERVER = spawnSync('git', ['cat-file', '-e', `${OLD_COMMIT}^{commit}`], { cwd: ROOT }).status === 0 && existsSync(join(ROOT, 'node_modules/typescript'));

test('版本握手：不带协议头的旧连接器——开工、收尾检查拿到旧结构的升级提示，不建会话、不记送达；POST /api/notices 返回 429、说明没发出；其余接口 426；带协议头访问旧路径 404', async () => {
  fresh();
  const { alice, bob } = devs;
  const health = await fetch(`${server.url}/healthz`);
  assert.deepEqual(await health.json(), { ok: true, protocol: 2 });
  assert.equal(health.headers.get(PROTOCOL_HEADER), '2');

  await hook(alice, 'session-start', 'codex', { session_id: 'alice-legacy' });
  await as(alice, 'notify', '--to', 'bob', '--summary', '升级前排着的消息');
  const n = latestNotice();
  const install = String.raw`curl -fsSL http:\/\/127\.0\.0\.1:\d+\/install\.sh \| bash`;
  const upgrade = new RegExp(`^本机的 teamlink 连接器太旧，消息先在服务器上排队。请你的用户在仓库目录运行 ${install} 升级；用 Codex 的，升级后在 \/hooks 里重新信任一次。$`);
  const session = { repoId, tool: 'codex', sessionId: 'bob-legacy' };
  const start = await signed(bob, 'POST', '/api/sessions/start', session, null);
  assert.equal(start.status, 200);
  assert.equal(start.protocol, '2');
  assert.deepEqual(Object.keys(start.body).sort(), ['notices', 'overflow', 'retractions']);
  assert.deepEqual([start.body.notices, start.body.retractions], [[], []]);
  assert.equal(start.body.overflow.length, 1);
  assert.equal(start.body.overflow[0].id, 'teamlink');
  assert.match(start.body.overflow[0].title, upgrade);
  const stopCheck = await signed(bob, 'POST', '/api/sessions/stop-check', session, null);
  assert.equal(stopCheck.status, 200);
  assert.deepEqual(stopCheck.body, start.body);
  // 每次操作的 activity：空的旧结构，免得每次都插一遍这句话
  const activity = await signed(bob, 'POST', '/api/activity', session, null);
  assert.deepEqual([activity.status, activity.body], [200, { notices: [], retractions: [], overflow: [] }]);
  assert.equal(engine.store.session('codex:bob-legacy'), undefined, '不建会话');
  assert.equal(delivered(n.id, 'bob'), null, '不记送达');
  // 发消息：429（旧发件箱会留着文件，升级后由新连接器补发），不入库。旧命令行把正文打给 AI：要说没发出、升级后重发，不能说“排队”
  const count = noticeCount();
  const send = await signed(bob, 'POST', '/api/notices', { repoId, type: 'interface_change', summary: '旧命令行发的', to: ['alice'] }, null);
  assert.equal(send.status, 429);
  assert.match(send.body.error, new RegExp(`^这条消息没有发出：本机的 teamlink 连接器太旧。请你的用户在仓库目录运行 ${install} 升级，升级后重发这条。$`));
  assert.doesNotMatch(send.body.error, /排队/);
  assert.equal(noticeCount(), count);
  // 其余接口（包括已经删掉的）：426
  const others = [
    ['GET', '/api/whoami'],
    ['GET', '/api/repos'],
    ['GET', `/api/inbox?repoId=${repoId}`],
    ['GET', `/api/team?repoId=${repoId}`],
    ['POST', '/api/sessions/end'],
    ['GET', '/api/alerts'],
    ['POST', '/api/approvals'],
    ['GET', '/api/state'],
  ] as const;
  for (const [method, path] of others) {
    const r = await signed(bob, method, path, method === 'POST' ? { tool: 'codex', sessionId: 'bob-legacy' } : undefined, null);
    assert.equal(r.status, 426, `${method} ${path}`);
    assert.match(r.body.error, upgrade);
  }
  assert.equal((await signed(bob, 'GET', '/api/whoami', undefined, '1')).status, 426, '协议版本低于 2 也算旧连接器');
  // 带协议头访问旧路径：404，什么都不做（这一版的连接器只用 /api/v2/）
  const oldPaths = [
    ['POST', '/api/sessions/start'],
    ['POST', '/api/activity'],
    ['POST', '/api/sessions/stop-check'],
    ['POST', '/api/sessions/end'],
    ['POST', '/api/notices'],
    ['GET', '/api/whoami'],
    ['GET', '/api/repos'],
    ['GET', `/api/inbox?repoId=${repoId}`],
  ] as const;
  for (const [method, path] of oldPaths) {
    const r = await signed(bob, method, path, method === 'POST' ? { ...session, type: 'message', summary: '带协议头走旧路径', to: ['alice'] } : undefined);
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  assert.equal(engine.store.session('codex:bob-legacy'), undefined, '带协议头走旧路径也不建会话');
  assert.equal(delivered(n.id, 'bob'), null, '也不记送达');
  assert.equal(noticeCount(), count, '也不入库');
  const invite = engine.store.createInvite();
  const oldJoin = await fetch(`${server.url}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL) },
    body: JSON.stringify({ invite, name: 'old-path-join', publicKey: generateDeviceKeys().publicKey }),
  });
  assert.equal(oldJoin.status, 404);
  assert.equal(engine.store.memberByName('old-path-join'), undefined);
  assert.equal(engine.store.get<{ used_by: string | null }>('SELECT used_by FROM invites WHERE code = ?', invite)?.used_by, null, '邀请码没被用掉');
  // 新连接器访问删掉的接口：404；看板也没了
  for (const path of ['/api/v2/alerts', '/api/v2/policy', '/api/v2/state', '/api/v2/subscriptions', '/api/v2/approvals', `/api/v2/team?repoId=${repoId}`]) assert.equal((await signed(bob, 'GET', path)).status, 404, path);
  assert.equal((await fetch(`${server.url}/`)).status, 404, '看板删掉了');

  // 用旧版连接器的渲染函数实际渲染一次（取自瘦身前的提交；仓库历史里没有这个提交时跳过这一步）
  const old = spawnSync('git', ['show', `${OLD_COMMIT}:src/shared/render.ts`], { cwd: ROOT, encoding: 'utf8' });
  if (old.status === 0) {
    write(tmp, 'old-render/render.mts', old.stdout);
    const { renderInbox } = (await import(pathToFileURL(join(tmp, 'old-render/render.mts')).href)) as { renderInbox: (r: unknown, o?: { nonce?: string }) => string };
    const text = renderInbox(start.body, { nonce: 'deadbeef' });
    assert.match(text, /^<team-notices-deadbeef>\n[\s\S]*\n {2}- teamlink：本机的 teamlink 连接器太旧，消息先在服务器上排队。[^\n]*\n<\/team-notices-deadbeef>$/);
    assert.equal(renderInbox(activity.body), '', '旧 hook 每次操作不输出东西');
  }
  // 升级以后，排着的消息照常送到
  assert.match(await postTool(bob, 'bob-legacy'), /\n\[1\] 消息 · 来自 alice：升级前排着的消息\n/);
});

test(
  '版本握手：新连接器连到还没升级的旧服务器——开工、post-tool、收尾检查、inbox 都不记送达，join 不建成员、不用掉邀请码',
  { skip: OLD_SERVER ? false : '仓库历史里没有瘦身前的提交，或者没装 typescript' },
  async () => {
    // 旧服务器：瘦身前的代码，进程内起在端口 0。它对不认识的路径在验签之前就回 404，新连接器只用 /api/v2/，所以碰不到它的旧接口
    const dir = join(tmp, 'old-server');
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['archive', '-o', join(tmp, 'old-server.tar'), OLD_COMMIT, 'bin', 'src', 'package.json'], { cwd: ROOT });
    execFileSync('tar', ['-xf', join(tmp, 'old-server.tar'), '-C', dir]);
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    const oldMain = await import(pathToFileURL(join(dir, 'src/server/main.ts')).href);
    const { generateDeviceKeys: oldKeys } = await import(pathToFileURL(join(dir, 'src/shared/crypto.ts')).href);
    const { call: oldCall } = await import(pathToFileURL(join(dir, 'src/connector/client.ts')).href);
    const oldEngine = oldMain.openEngine(join(dir, 'data'));
    // 旧版登记仓库要带一个镜像（bare 仓库）
    const mirror = join(dir, 'data/mirrors/r.git');
    sh(tmp, 'clone', '-q', '--bare', remote, mirror);
    const repo = oldEngine.store.addRepo(remote, 'main', mirror) as { id: string };
    const ids: Record<string, { memberId: string; deviceId: string; name: string; privateKey: string }> = {};
    for (const name of ['alice', 'bob']) {
      const k = oldKeys() as { publicKey: string; privateKey: string };
      const m = oldEngine.store.addMember(name, null, null) as { id: string };
      ids[name] = { memberId: m.id, deviceId: oldEngine.store.addDevice(m.id, k.publicKey, 'mac').id, name, privateKey: k.privateKey };
    }
    const s = (await oldMain.startServer({ engine: oldEngine, port: 0 })) as RunningServer;
    try {
      // alice 还用旧连接器，给 bob 发一条提问（旧 payload 要带 branch）
      const sent = (await oldCall(s.url, ids.alice, 'POST', '/api/notices', { repoId: repo.id, type: 'question', summary: '旧服务器上的提问', claims: [], to: ['bob'], branch: 'main', clientId: randomUUID() })) as { id: string };
      const deliveredAt = () =>
        (oldEngine.store.get('SELECT delivered_at FROM recipients WHERE notice_id = ? AND member_id = ?', sent.id, ids.bob.memberId) as { delivered_at: string | null } | undefined)?.delivered_at ?? null;
      assert.equal(deliveredAt(), null);
      // bob 已经换成新连接器
      const bob: Dev = { name: 'bob', dir: join(tmp, 'bob-on-old'), home: join(tmp, 'home-bob-on-old') };
      sh(tmp, 'clone', '-q', remote, bob.dir);
      writeFileSync(join(bob.dir, '.teamlink.json'), JSON.stringify({ server: s.url, repoId: repo.id }));
      write(bob.home, 'identities.json', JSON.stringify({ [s.url]: { ...ids.bob, server: s.url } }));
      assert.equal(await hook(bob, 'session-start', 'claude', { session_id: 'bob-old-1' }), '');
      assert.equal(deliveredAt(), null, 'session-start 不记送达');
      assert.equal(await postTool(bob, 'bob-old-1'), '');
      assert.equal(deliveredAt(), null, 'post-tool 不记送达');
      assert.equal(await stop(bob, 'claude', 'bob-old-1'), null);
      assert.equal(deliveredAt(), null, '收尾检查不记送达');
      for (const args of [['inbox'], ['inbox', '--all']]) {
        assert.match(await fails(bob, ...args), /没有返回协议版本：多半是旧版的 teamlink 服务器/, args.join(' '));
        assert.equal(deliveredAt(), null, `${args.join(' ')} 不记送达`);
      }
      assert.match(hookLog(bob), /没有返回协议版本/);
      assert.equal(received(bob), '', 'AI 没看到的不存进 received.md');
      // join：旧服务器回 404，不建成员，邀请码还能用，本机也不存身份
      const invite = oldEngine.store.createInvite() as string;
      const carol: Dev = { name: 'carol', dir: tmp, home: join(tmp, 'home-carol-on-old') };
      assert.match(await fails(carol, 'join', s.url, '--invite', invite, '--name', 'carol'), /没有返回协议版本/);
      assert.equal(oldEngine.store.memberByName('carol'), undefined, '没建成员');
      assert.equal((oldEngine.store.get('SELECT used_by FROM invites WHERE code = ?', invite) as { used_by: string | null }).used_by, null, '邀请码没被用掉');
      assert.ok(!existsSync(join(carol.home, 'identities.json')));
    } finally {
      await s.close();
      oldEngine.store.db.close();
    }
  },
);

// —— 签名时间戳 ——

test('签名：时间戳不是纯数字的请求不接受（不然过期检查形同虚设）', async () => {
  const id = identity(devs.alice);
  for (const ts of ['abc', '', '1e3', ` ${Date.now()}`, `${Date.now()}.5`, '-1']) {
    const res = await fetch(`${server.url}/api/v2/whoami`, {
      headers: { [PROTOCOL_HEADER]: String(PROTOCOL), 'x-tl-device': id.deviceId, 'x-tl-ts': ts, 'x-tl-sig': signRequest(id.privateKey, 'GET', '/api/v2/whoami', ts, '') },
    });
    assert.equal(res.status, 401, `x-tl-ts: ${JSON.stringify(ts)}`);
  }
});
