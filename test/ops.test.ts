// 运维：每天的数据库备份、日志轮转脚本。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateDeviceKeys } from '../src/shared/crypto.ts';
import { openEngine, startServer } from '../src/server/main.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DAY = 24 * 3600_000;
const tmp = mkdtempSync(join(tmpdir(), 'teamlink-ops-'));

after(() => rmSync(tmp, { recursive: true, force: true }));

test('备份：每天一份、当天不重复，是能直接打开的完整数据库；只保留最近 7 份；backupKeep 为 0 时不备份', () => {
  const dir = join(tmp, 'backup');
  const engine = openEngine(dir, { log: () => {} });
  const store = engine.store;
  engine.join({ invite: store.createInvite(), name: 'alice', publicKey: generateDeviceKeys().publicKey, deviceName: null });
  const real = store.clock;
  const t0 = Date.parse('2026-03-01T10:00:00Z');
  const backups = () => readdirSync(join(dir, 'backups')).sort();
  try {
    store.clock = () => t0;
    const first = engine.backup();
    assert.equal(first, join(dir, 'backups/teamlink-2026-03-01.db'));
    const copy = new DatabaseSync(first as string, { readOnly: true });
    assert.deepEqual(copy.prepare('SELECT name FROM members').all().map((r) => ({ ...r })), [{ name: 'alice' }]);
    copy.close();
    store.clock = () => t0 + 5 * 3600_000;
    assert.equal(engine.backup(), null, '同一天不再做');

    // 上次做到一半留下的临时文件不算数，也不挡着下一次；别的日子留下的（那天被杀掉、第二天才重启）也一起清掉
    writeFileSync(join(dir, 'backups/teamlink-2026-03-02.db.tmp'), '半截');
    writeFileSync(join(dir, 'backups/teamlink-2026-02-20.db.tmp'), '半截');
    for (let d = 1; d <= 8; d++) {
      store.clock = () => t0 + d * DAY;
      assert.ok(engine.backup());
    }
    assert.deepEqual(backups(), ['03', '04', '05', '06', '07', '08', '09'].map((d) => `teamlink-2026-03-${d}.db`), '只有最近 7 份，没有留下临时文件');

    engine.config.backupKeep = 0;
    store.clock = () => t0 + 20 * DAY;
    assert.equal(engine.backup(), null);
    assert.equal(backups().length, 7);
  } finally {
    store.clock = real;
    store.db.close();
  }
});

test('备份：服务器启动时就做当天的一份，记一行日志；目标写不了时记 backup_failed，服务器照常启动', async () => {
  const log: string[] = [];
  const dir = join(tmp, 'backup-start');
  const engine = openEngine(dir, { log: (line) => log.push(line) });
  const s = await startServer({ engine, port: 0 });
  await s.close();
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(existsSync(join(dir, `backups/teamlink-${today}.db`)));
  assert.ok(log.some((l) => l.includes(' backup {') && l.includes(`teamlink-${today}.db`)), log.join('\n'));

  // backups 被一个普通文件占着：建不了目录
  const bad = join(tmp, 'backup-bad');
  const e2 = openEngine(bad, { log: (line) => log.push(line) });
  writeFileSync(join(bad, 'backups'), '');
  const s2 = await startServer({ engine: e2, port: 0 });
  assert.equal((await fetch(`${s2.url}/healthz`)).status, 200);
  await s2.close();
  assert.ok(log.some((l) => l.includes(' backup_failed ')), log.join('\n'));
  engine.store.db.close();
  e2.store.db.close();
});

test('日志轮转：超过上限才轮转，旧的依次后移、只留指定的份数；写日志的一方一直开着文件，轮转以后接着从头写', () => {
  const script = join(ROOT, 'deploy/rotate-log.sh');
  execFileSync('bash', ['-n', script]);
  const dir = mkdtempSync(join(tmp, 'rotate-'));
  const log = join(dir, 'server.log');
  const rotate = () => execFileSync('bash', [script, log, '2000', '2']);
  rotate();
  assert.deepEqual(readdirSync(dir), [], '没有日志文件时什么都不做');

  // 和 systemd 的 append:、shell 的 >> 一样：追加方式打开，一直不关
  const fd = openSync(log, 'a');
  try {
    writeSync(fd, `${'a'.repeat(1500)}\n`);
    rotate();
    assert.deepEqual(readdirSync(dir), ['server.log'], '没超过上限不动');
    writeSync(fd, `${'a'.repeat(1500)}\n`);
    rotate();
    assert.equal(statSync(log).size, 0);
    assert.equal(statSync(`${log}.1`).size, 3002);
    writeSync(fd, '轮转以后写的\n');
    assert.equal(readFileSync(log, 'utf8'), '轮转以后写的\n', '接着从头写，前面没有空洞');

    for (const ch of ['b', 'c']) {
      appendFileSync(log, `${ch.repeat(2500)}\n`);
      rotate();
    }
    assert.deepEqual(readdirSync(dir).sort(), ['server.log', 'server.log.1', 'server.log.2'], '只留 2 份');
    assert.ok(readFileSync(`${log}.1`, 'utf8').startsWith('c'));
    assert.ok(readFileSync(`${log}.2`, 'utf8').endsWith('b\n'));
  } finally {
    closeSync(fd);
  }
});

test('部署脚本：run.sh 每小时调一次日志轮转，后台循环先关掉锁文件的描述符', () => {
  const script = readFileSync(join(ROOT, 'deploy/install-server.sh'), 'utf8');
  execFileSync('bash', ['-n', join(ROOT, 'deploy/install-server.sh')]);
  const loop = script.slice(script.indexOf('flock -n 9'), script.indexOf('trap '));
  assert.match(loop, /\(\n {2}exec 9>&-\n {2}while true; do\n {4}"\$BASE\/app\/deploy\/rotate-log\.sh" "\$BASE\/server\.log" \|\| true\n {4}sleep 3600\n/);
});
