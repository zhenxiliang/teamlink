// 服务器与本地连接器之间的接口：协议版本、每个接口的请求和响应，以及两边都要遵守的几条限制。
// 注入给 AI 的文字一律由服务器渲染好（见 render.ts），连接器原样转交，不再自己拼。

/** 协议版本。连接器的每个请求带请求头 x-teamlink-protocol，服务器的每个响应也带；/healthz 也会报。join 和签名接口都在 /api/v2/ 下。 */
export const PROTOCOL = 2;
export const PROTOCOL_HEADER = 'x-teamlink-protocol';

export type Tool = 'claude' | 'codex';
export const TOOLS: Tool[] = ['claude', 'codex'];

/** 只有三类：提问、回答，其余一律是消息。 */
export type NoticeType = 'message' | 'question' | 'answer';

export type ChangeType = 'added' | 'removed' | 'signature_changed' | 'behavior_changed';
export const CHANGE_TYPES: ChangeType[] = ['added', 'removed', 'signature_changed', 'behavior_changed'];

/** 发送方附带的声明：某个文件里的某个符号改了什么。只做格式校验，不核实。 */
export interface Claim {
  file: string;
  symbol: string;
  change: ChangeType;
}

/** 说明最多这么多字（按字符算，不是字节）。 */
export const MAX_SUMMARY_CHARS = 500;
export const MAX_CLAIMS = 20;
/** 一次注入（含边界标签、开头说明、队友段和“另有 N 条”那一行）最多这么多字节（UTF-8）。 */
export const INJECTION_BUDGET_BYTES = 8000;
export const MAX_NAME_CHARS = 32;

/** 控制字符（含 C1）和 Unicode 的行分隔符、段分隔符。 */
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * 看不见的字符（Unicode 的“默认可忽略”字符：零宽字符、方向控制符、变体选择符、标签字符，渲染时都会被删掉）。名字带上它们，
 * 显示出来就和另一个成员一字不差（“阿明”加一个标签字符），AI 和人都分不出是谁发的。
 */
const NAME_INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;

/** 成员名的规矩：join 时服务器校验，命令行也可以先查一遍。合格返回 null，否则返回原因。 */
export function memberNameError(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return '成员名不能为空';
  // 点名时 --to 先去掉首尾空白再按名字找人：名字自己带首尾空白（比如输入法多打的全角空格），就永远点不了名
  if (name.trim() !== name) return '成员名前后不能有空格';
  if (NAME_FORBIDDEN.test(name)) return '成员名不能有控制字符和换行';
  if (NAME_INVISIBLE.test(name)) return '成员名不能有看不见的字符（零宽字符、方向控制符、标签字符）';
  // 尖括号能拼出边界标签（阿明<team-notices-x>），渲染时被删掉后也会和另一个成员一样
  if (/[<>]/.test(name)) return '成员名不能有尖括号';
  if ([...name].length > MAX_NAME_CHARS) return `成员名最长 ${MAX_NAME_CHARS} 个字`;
  return null;
}

/** 声明会显示给收件人：文件路径不能带控制字符、尖括号和反引号，符号名只能是标识符（可以带点，比如 类名.方法名）。 */
const CLAIM_FILE = /^[^\u0000-\u001f\u007f<>`]{1,300}$/;
const CLAIM_SYMBOL = /^[\p{L}_$][\p{L}\p{N}_$.]{0,119}$/u;

/** 一条声明的格式对不对：对就返回 null，不对返回原因。 */
export function claimError(c: unknown): string | null {
  if (!c || typeof c !== 'object') return '每条声明需要 file、symbol 和 change';
  const { file, symbol, change } = c as Record<string, unknown>;
  if (typeof file !== 'string' || typeof symbol !== 'string') return '每条声明需要 file、symbol 和 change';
  if (!CHANGE_TYPES.includes(change as ChangeType)) return `变更类型必须是 ${CHANGE_TYPES.join('、')} 之一，收到：${String(change).slice(0, 40)}`;
  if (!CLAIM_FILE.test(file) || !CLAIM_SYMBOL.test(symbol)) return `声明的文件路径或符号名格式不对：${file.slice(0, 60)}#${symbol.slice(0, 60)}`;
  return null;
}

// —— 不签名的接口 ——

/** GET /healthz */
export interface HealthResponse {
  ok: true;
  protocol: number;
}

/** POST /api/v2/join：用邀请码加入团队，登记这台设备的公钥。 */
export interface JoinResponse {
  memberId: string;
  deviceId: string;
  repos: RepoInfo[];
}

// —— 以下接口都要设备签名，并带协议头 ——

/** GET /api/v2/whoami */
export interface WhoamiResponse {
  member: { id: string; name: string };
}

/** GET /api/v2/repos：link 按 git remote 地址在这里找仓库。 */
export interface RepoInfo {
  id: string;
  url: string;
}

/** 送达类请求都带的会话标识。服务器把会话记成“工具:会话号”。 */
export interface SessionRef {
  repoId: string;
  tool: Tool;
  sessionId: string;
}

/**
 * 三个送达类接口的响应。服务器在生成这个响应时就把 ids 里的条目记成已送达（给这个会话），
 * 没放进去的继续排队，下次操作时再送。
 */
export interface DeliveryResponse {
  /** 渲染好的整段注入文字，原样交给 AI；可能为空串。 */
  text: string;
  /** 只含消息条目的那一段（同一个边界标签和开头说明，不含队友段和“另有 N 条”），给 .team/received.md 用；没有消息时为空串。 */
  messagesText: string;
  /** 这批送到的通知号，按注入里的顺序。 */
  ids: string[];
  /** 和 ids 一一对应的类型：收尾检查据此决定结尾怎么提示。 */
  types: NoticeType[];
  /** 这批里有没有消息、提问或回答（只有队友段、或者只有“已连接”那句时为 false）。 */
  hasMessages: boolean;
  /** 全部成员名（含自己），每次都带：会话中途有人加入时，命令行的名单下一次 hook 就更新。 */
  members?: string[];
}

export interface Presence {
  name: string;
  online: boolean;
  /** 最近一次活动的时间（ISO）；从没在这个仓库开过会话时为 null。 */
  lastSeenAt: string | null;
}

export interface SendResponse {
  id: string;
  /** 实际收件人的名字。 */
  recipients: string[];
  /** 每个收件人现在在不在线。 */
  presence: Presence[];
}

/** GET /api/v2/inbox?repoId=…[&all=1]：只看，不记送达，不受注入预算限制。默认看没送到的，all=1 看最近 7 天的全部。 */
export interface InboxResponse {
  /** 渲染好的文字（带边界标签）；没有消息时是一句说明。 */
  text: string;
  count: number;
}

/** 一位队友的概况。 */
export interface Teammate {
  name: string;
  tool: string;
  online: boolean;
  lastSeenAt: string;
}

/**
 * 旧连接器（没带协议头）的 /api/sessions/start、stop-check、activity 拿到的旧结构：
 * 旧版 renderInbox 能原样渲染 overflow 里的那句升级提示。
 */
export interface LegacyInboxResponse {
  notices: [];
  retractions: [];
  overflow: { id: string; title: string }[];
}
