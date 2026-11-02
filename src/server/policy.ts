// 团队策略存在数据目录的 policy.json：管理员用 teamlink-server policy 修改，每次请求时读，改了立即生效。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_POLICY, type Policy } from '../shared/rules.ts';

/** 读策略；旧版 policy.json 里的其他字段（block、riskyNotices、shareTasks、confirmAfterInjection……）直接忽略。 */
export function loadPolicy(dataDir: string): Policy {
  const path = join(dataDir, 'policy.json');
  if (!existsSync(path)) return { ...DEFAULT_POLICY, allowDomains: [...DEFAULT_POLICY.allowDomains] };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const domains = Array.isArray(raw.allowDomains) ? raw.allowDomains.filter((d): d is string => typeof d === 'string') : null;
  return { allowDomains: (domains ?? DEFAULT_POLICY.allowDomains).map((d) => d.trim().toLowerCase()).filter(Boolean) };
}

export function savePolicy(dataDir: string, policy: Policy): void {
  writeFileSync(join(dataDir, 'policy.json'), JSON.stringify({ allowDomains: policy.allowDomains }, null, 2) + '\n');
}
