// 团队策略：存在服务器数据目录的 policy.json，只有一项域名白名单，服务器审核消息里的链接时用。

/** 团队策略：管理员用 teamlink-server policy 修改。 */
export interface Policy {
  /** 消息里的链接只允许指向这些域名（含子域名）。 */
  allowDomains: string[];
}

export const DEFAULT_POLICY: Policy = {
  allowDomains: [
    'localhost',
    '127.0.0.1',
    'github.com',
    'githubusercontent.com',
    'gitlab.com',
    'gitee.com',
    'npmjs.org',
    'npmjs.com',
    'npmmirror.com',
    'pypi.org',
    'pythonhosted.org',
    'nodejs.org',
  ],
};

/** 域名在不在名单里（含子域名）。 */
export function domainAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((a) => h === a || h.endsWith(`.${a}`));
}
