// 服务器与本地连接器之间的接口：协议版本、每个接口的请求和响应，以及两边都要遵守的几条限制。
// 注入给 AI 的文字一律由服务器渲染好（见 render.ts），连接器原样转交，不再自己拼。

/** 协议版本。连接器的每个请求带请求头 x-teamlink-protocol，服务器的每个响应也带；/healthz 也会报。join 和签名接口都在 /api/v2/ 下。 */
export const PROTOCOL = 2;
export const PROTOCOL_HEADER = 'x-teamlink-protocol';

export type Tool = 'claude' | 'codex';
export const TOOLS: Tool[] = ['claude', 'codex'];

/** 只有三类：提问、回答，其余一律是消息。 */
export type NoticeType = 'message' | 'question' | 'answer';

/**
 * 这条是谁写的：ai 是 AI 会话里发的，person 是本人在终端里亲手写的（渲染时在名字后面标出来）。
 * 连接器按运行环境判断（见 connector/origin.ts），服务器只转交、不核实；旧连接器不带这个字段。
 */
export type NoticeVia = 'ai' | 'person';
export const VIAS: NoticeVia[] = ['ai', 'person'];
/** 本人写的那一条，渲染时跟在发送人名字后面。成员名里不能带它，免得冒充。 */
export const PERSON_MARK = '（本人写的）';

/**
 * 回答的依据：confirmed 是回答方的用户亲口说的，checked 是回答方的 AI 在本机或系统里查到的，guess 是推测。
 * AI 回答时必须写（命令行查），服务器只校验是不是这三个之一；本人在终端里写的回答不用写（本人写的就是最强的依据）。
 * 渲染时跟在发送人后面；团队事实只收 confirmed、checked 和本人写的，推测不收。
 */
export type Basis = 'confirmed' | 'checked' | 'guess';
export const BASES: Basis[] = ['confirmed', 'checked', 'guess'];
export const BASIS_LABEL: Record<Basis, string> = { confirmed: '本人确认', checked: '查证过', guess: '推测' };
/** 命令行里 --basis 认的写法（AI 照着自然语言写也能认出来）。 */
const BASIS_WORDS: Record<Basis, string[]> = {
  confirmed: ['confirmed', 'user', '本人确认', '确认', '用户说的', '用户确认', '本人说的'],
  checked: ['checked', '查证过', '查过', '查证', '本机查到的', '查到的'],
  guess: ['guess', '推测', '猜的', '猜测'],
};

/** --basis 的值认成哪一种；认不出返回 null。 */
export function parseBasis(word: string): Basis | null {
  const w = word.trim().toLowerCase();
  return BASES.find((b) => BASIS_WORDS[b].includes(w)) ?? null;
}

/**
 * 一条通知的结构化内容（送达和 --wait 的响应里带着，连接器存进 .team/notices.json）：
 * teamlink fact --from 据此自动填来源和依据，沙箱里连不上服务器也能用。文字都是原文，没有规整过，用的时候自己规整。
 */
export interface NoticeItem {
  id: string;
  type: NoticeType;
  sender: string;
  via: NoticeVia | null;
  basis: Basis | null;
  summary: string;
  /** 回答：回的是哪一条提问，和那条提问的内容。 */
  replyTo: { id: string; question: string } | null;
  createdAt: string;
}

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
/** 服务器不认这台设备时（被吊销、成员被移出）401 的错误文字的开头：带着新邀请码重跑接入命令时，连接器据此重新加入。 */
export const DEVICE_UNKNOWN = '这台设备没有登记，或者已经被管理员吊销';
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
  // AI 发的消息显示出来会和本人亲手写的一样
  if (name.includes(PERSON_MARK)) return `成员名里不能有${PERSON_MARK}`;
  // 服务器自己发的系统消息显示成“来自 teamlink 服务器”：成员叫这个名字，发的消息就和系统消息分不出来
  if (/teamlink/i.test(name)) return '成员名里不能有 teamlink（留给服务器发的系统消息）';
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
  /**
   * 送达确认：hook 已经输出给 AI、还没向服务器确认过的通知号（没有也带空数组）。
   * 不带这个字段的是旧连接器：服务器照旧在生成响应时就算送达，不重发。
   */
  acks?: string[];
}

/** 一个请求里最多确认这么多条（多出来的留到下一个请求）。 */
export const MAX_ACKS = 200;

/**
 * 三个送达类接口的响应。服务器在生成这个响应时把 ids 里的条目记成“已交出”（给这个会话），没放进去的继续排队，下次操作时再送。
 * 连接器把这段文字输出给 AI 以后，在下一个请求的 acks 里确认。一直没确认的（hook 超时被杀、响应丢在路上）：
 * 同一个会话过 10 秒再来时重发，再没确认就隔得越来越久地重发，直到确认；那个会话结束或下线了，交给这个成员的下一个会话。
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
  /** 和 ids 一一对应的结构化内容（旧服务器不带）。 */
  items?: NoticeItem[];
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

/**
 * POST /api/v2/answers/take：ask --wait 用。取走某条提问已经到了的回答；命令行打印以后回 POST /api/v2/acks { acks } 确认，
 * 没确认的下一次轮询还能再拿到，之后由 hook 重发。请求体：{ repoId, question }；提问必须是自己发的。
 */
export interface TakeAnswersResponse {
  /** 渲染好的回答（带边界标签和开头说明）；还没有回答时为空串。 */
  text: string;
  /** 取走的回答的通知号。 */
  ids: string[];
  /** 被问的人现在在不在线：不在线了就不用再等。 */
  online: boolean;
  /** 和 ids 一一对应的结构化内容（旧服务器不带）。 */
  items?: NoticeItem[];
}

/**
 * GET /api/v2/notice?repoId=…&id=…：查一条自己发的或者收到的通知（teamlink fact --from 在本机存档里找不到时用）。
 * id 是自己发的提问时，返回它最新的一条回答（更正排在后面，以最新的为准）；还没有回答时 404。
 */
export type NoticeLookupResponse = NoticeItem;

/** GET /api/v2/inbox?repoId=…[&all=1]：只看，不记送达，不受注入预算限制。默认看还没交给过 AI 会话的，all=1 看最近 7 天的全部。 */
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
