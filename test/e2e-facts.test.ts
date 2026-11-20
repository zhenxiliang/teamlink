// 端到端：回答的依据（reply --basis）和团队事实（fact、facts，ask 之前查重），以及 teamlink-server stats。
// 公共的环境和辅助函数在 helpers.ts。

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { as, devs, engine, fails, fresh, latestNotice, noticeCount, offline, postTool, repoId, run, SERVER_BIN, signed, tmp } from './helpers.ts';

const factFile = (dir: string, title: string) => join(dir, 'docs/team-facts', `${title}.md`);
const archive = (dir: string) => join(dir, '.team/notices.json');

test('依据：AI 回答必须带 --basis，服务器存下来，提问方看到“依据：…”；认不出的写法当场报错；接口只收三种值，提问和消息带了也不存', async () => {
  fresh();
  const { alice, bob } = devs;
  await as(bob, 'ask', 'alice', '回测的手续费按万几算？');
  const qid = latestNotice().id;
  const before = noticeCount();
  assert.match(await fails(alice, 'reply', qid, '万二'), /回答要写明依据：加 --basis 本人确认、查证过、推测 之一/);
  assert.match(await fails(alice, 'reply', qid, '万二', '--basis', '大概'), /--basis 只能是 本人确认、查证过、推测，收到：大概/);
  assert.equal(noticeCount(), before, '报错的都没发出');
  await as(alice, 'reply', qid, '万二', '--basis', '用户说的');
  const aid = latestNotice().id;
  assert.equal(engine.store.notice(aid)?.basis, 'confirmed');
  const got = await postTool(bob, 'bob-basis');
  assert.match(got, new RegExp(`\\n\\[1\\] 回答 · 来自 alice · 依据：本人确认 · 回复你的提问 ${qid}「回测的手续费按万几算？」：万二\\n {4}是长期有效的事实（限额、口径、约定这类）就记下来：teamlink fact "主题" --from ${aid}\\n`));

  assert.equal((await signed(alice, 'POST', '/api/v2/notices', { repoId, replyTo: qid, summary: '万三', basis: 'maybe' })).status, 400);
  assert.equal((await signed(bob, 'POST', '/api/v2/notices', { repoId, type: 'message', to: ['alice'], summary: '消息', basis: 'checked' })).status, 200);
  assert.equal(engine.store.notice(latestNotice().id)?.basis, null, '消息带了依据也不存');
});

test('团队事实：回答到了，提问方 fact --from 提问号（或回答号）就能记下，来源和依据自动带上；facts 能查；再问同样的问题先不发，--anyway 照发', async () => {
  fresh();
  const { alice, bob, carol } = devs;
  await as(alice, 'ask', 'bob', '交易所后台的下单限额是多少？');
  const qid = latestNotice().id;
  await as(bob, 'reply', qid, '每分钟最多 20 笔，超了返回 429', '--basis', '本人确认');
  const aid = latestNotice().id;
  assert.match(await postTool(alice, 'alice-fact'), new RegExp(`--from ${aid}`));
  // hook 把结构化内容存进了本机存档：沙箱里断网也能记
  assert.ok(JSON.parse(readFileSync(archive(alice.dir), 'utf8')).some((i: { id: string }) => i.id === aid));

  const out = await offline(() => as(alice, 'fact', '交易所下单限额', '--from', qid));
  assert.equal(out, '已记进团队事实：docs/team-facts/交易所下单限额.md（依据：本人确认，来源：bob）\n跟着你的改动一起提交；合并以后，队友的 AI 问之前会先查到它。\n');
  const text = readFileSync(factFile(alice.dir, '交易所下单限额'), 'utf8');
  assert.match(text, /^# 交易所下单限额\n\n每分钟最多 20 笔，超了返回 429\n\n- 依据：本人确认\n- 来源：bob，\d{4}-\d\d-\d\d，回答提问「交易所后台的下单限额是多少？」（n_[0-9a-f]+）\n- 记录：alice，\d{4}-\d\d-\d\d\n$/);
  assert.match(await as(alice, 'fact', '交易所下单限额', '--from', aid), /已经有这一条，内容一样，没有改动/);

  // 查：全部、按关键词、找不到
  assert.match(await as(alice, 'facts'), /^团队事实（docs\/team-facts\/，共 1 条）：\n- 交易所下单限额：每分钟最多 20 笔，超了返回 429（本人确认 · bob · \d{4}-\d\d-\d\d）\n/);
  assert.match(await as(alice, 'facts', '429'), /^团队事实里含「429」的：\n- 交易所下单限额/);
  assert.match(await as(alice, 'facts', '冷却期'), /里没有和「冷却期」相关的记录/);

  // 再问同样的问题：先不发，把事实打印出来；--anyway 照发
  const before = noticeCount();
  const held = await as(alice, 'ask', 'carol', '交易所的下单限额现在是多少？');
  assert.match(held, /^没有发出：团队事实里已经有相关的记录[^\n]*\n- 交易所下单限额：每分钟最多 20 笔[^\n]*\n {4}docs\/team-facts\/交易所下单限额\.md\n它答不了你的问题[^\n]*--anyway/);
  assert.equal(noticeCount(), before);
  assert.match(await as(alice, 'ask', 'carol', '交易所的下单限额现在是多少？', '--anyway'), /^已发给 carol/);
  assert.equal(noticeCount(), before + 1);
  // 不相干的问题照常发
  assert.match(await as(alice, 'ask', 'carol', '回测接口返回什么错误码？'), /^已发给 carol/);

  // 事实是 alice 工作区里的文件，不经过服务器：提交、合并以后别人才有，carol 这边现在还没有
  assert.match(await as(carol, 'facts'), /还没有团队事实/);
});

test('团队事实：更正——对方再答一次，同一个主题再记一次，原来的挪到“以前”；推测的回答不收，自己查证过的可以写上内容和 --basis 记', async () => {
  fresh();
  const { alice, bob } = devs;
  await as(alice, 'ask', 'bob', '下单失败后的冷却期是多久？');
  const qid = latestNotice().id;
  await as(bob, 'reply', qid, '30 秒', '--basis', '查证过');
  await postTool(alice, 'alice-fix');
  await as(alice, 'fact', '下单冷却期', '--from', qid);
  await as(bob, 'reply', qid, '更正：60 秒（后台刚改过）', '--basis', '本人确认');
  await postTool(alice, 'alice-fix');
  assert.match(await as(alice, 'fact', '下单冷却期', '--from', qid), /^已更正团队事实：docs\/team-facts\/下单冷却期\.md（依据：本人确认，来源：bob），原来的内容挪到了“以前”\n/);
  const text = readFileSync(factFile(alice.dir, '下单冷却期'), 'utf8');
  assert.match(text, /\n\n更正：60 秒（后台刚改过）\n\n- 依据：本人确认\n[\s\S]*\n- 以前：30 秒（查证过，bob，\d{4}-\d\d-\d\d）\n$/);

  await as(alice, 'ask', 'bob', '回测的年化因子取多少？');
  const q2 = latestNotice().id;
  await as(bob, 'reply', q2, '大概 2190 吧', '--basis', '推测');
  const guessed = latestNotice().id;
  const got = await postTool(alice, 'alice-fix');
  assert.doesNotMatch(got, /teamlink fact/, '推测的回答下面不提示记');
  assert.match(await fails(alice, 'fact', '年化因子', '--from', guessed), /推测不进团队事实/);
  assert.equal(existsSync(factFile(alice.dir, '年化因子')), false);
  assert.match(await as(alice, 'fact', '年化因子', '4 小时 K 线一年 2190 根', '--basis', '查证过'), /依据：查证过，来源：alice/);
});

test('团队事实：本机存档里没有的（别的 worktree、存档被删）问服务器——只能查自己发的或收到的；断网时说清楚怎么办；问的不是事实时拒绝', async () => {
  fresh();
  const { alice, bob, carol } = devs;
  await as(alice, 'ask', 'bob', '测试环境的数据库是哪个版本？');
  const qid = latestNotice().id;
  await as(bob, 'reply', qid, 'PostgreSQL 16', '--basis', '查证过');
  const aid = latestNotice().id;
  rmSync(archive(alice.dir), { force: true });
  // 存档里没有、又断网
  assert.match(await offline(() => fails(alice, 'fact', '测试库版本', '--from', qid)), /本机存档（\.team\/notices\.json）里没有 n_[0-9a-f]+，又连不上服务器[^\n]*把事实内容直接写在主题后面/);
  // 联网：服务器查到提问的最新回答
  assert.match(await as(alice, 'fact', '测试库版本', '--from', qid), /依据：查证过，来源：bob/);
  // 回答方自己也能从自己的回答记
  assert.match(await as(bob, 'fact', '测试库版本', '--from', aid), /已经有这一条|已记进/);
  // 别人的通知查不到；收到的提问不是事实
  assert.equal((await signed(carol, 'GET', `/api/v2/notice?${new URLSearchParams({ repoId, id: aid })}`)).status, 403);
  assert.match(await fails(bob, 'fact', '测试库版本', '--from', qid), /是别人问你的提问，不是事实/);
  assert.equal((await signed(alice, 'GET', `/api/v2/notice?${new URLSearchParams({ repoId, id: 'n_0000000000' })}`)).status, 404);
});

test('stats：服务器上运行，按仓库列出提问、回答率、依据、被问得最多的人；--days 不对时报错', async () => {
  const r = await run(process.execPath, [SERVER_BIN, 'stats', '--data', join(tmp, 'server')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^仓库 \S+（r_[0-9a-f]+），最近 30 天（/);
  assert.match(r.out, /\n {2}提问 \d+ 条：已回答 \d+ 条（\d+%）/);
  assert.match(r.out, /\n {2}回答的依据：[^\n]*本人确认 \d+/);
  assert.match(r.out, /\n {2}被问得最多：/);
  const week = await run(process.execPath, [SERVER_BIN, 'stats', '--days', '7', '--data', join(tmp, 'server')]);
  assert.match(week.out, /最近 7 天/);
  const bad = await run(process.execPath, [SERVER_BIN, 'stats', '--days', '0', '--data', join(tmp, 'server')]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /--days 要是 1 到 365 之间的整数/);
});
