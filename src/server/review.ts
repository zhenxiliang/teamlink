// 发送时的审核（在服务器端）：只拒收高置信的危险内容——密钥和令牌、明显的指令注入、命令、陌生链接、长串编码。
// 拒收时把原因退给发送方，让它改写；其余一律放行，不分等级，也不改动内容。

import { LINE_BREAKS, normalizeText } from '../shared/render.ts';
import { domainAllowed } from '../shared/rules.ts';

type Rule = [RegExp, string];

/** 密钥和令牌：只认高置信的格式。前面加了“不能紧跟字母数字”，免得 risk-assessment-… 这类词被当成 sk-…。 */
const SECRETS: Rule[] = [
  [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/, '像 AWS 访问密钥的内容（AKIA…）'],
  [/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/, '像 API 密钥的内容（sk-…）'],
  // 细粒度令牌是 github_pat_ 加 22 位、下划线、59 位：github_pat_expiration_days 这类 snake_case 标识符不算
  [/(?<![A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9]{20,}_[A-Za-z0-9]{40,})/, '像 GitHub 令牌的内容（ghp_… 之类）'],
  [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/, '像 Slack 令牌的内容（xox…）'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  // 第一段必须以 eyJ 开头（JSON 头的 base64）：点分的模块路径、文件名、版本号都不会命中
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, '像 JWT 令牌的内容'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/i, '带口令的连接串（scheme://用户:口令@主机）'],
];

/**
 * 写在大写变量里的口令：OKX_API_SECRET=…、SECRET_KEY: …。不用 \b：OKX_ 这类前缀会破坏单词边界；
 * SECRET 后面还可以跟 _ACCESS、_KEY（AWS_SECRET_ACCESS_KEY=）。右边要像口令才算，见 secretValue。
 */
const ENV_SECRET = /(?<![A-Za-z0-9])[A-Z0-9_]*(SECRET|PASSPHRASE|API_KEY|TOKEN|PASSWORD)(_ACCESS)?(_KEY)?\s*[=:]\s*(\S{12,})/g;
const ENV_SECRET_WHY = '写在 XXX_SECRET= 这类变量里的口令';

/**
 * 变量右边像口令：去掉引号后至少 12 位，字母和数字都有。代码写法不算：os.environ["X"]、os.environ.get("X")、
 * process.env.X、getenv("X")、${X}、${{ secrets.X }}；文件路径（config/settings.py）也不算。
 * 只认整个值就是这种写法的：口令里带 $、括号（Abcd1234$efgh5678）照样拦。
 */
function secretValue(v: string): boolean {
  // 只看紧跟着的 ASCII 部分：“config/settings.py，不要提交”里的中文不算值的一部分
  const s = v.split(/[^\x21-\x7e]/)[0].replace(/^["'`]+|["'`,;]+$/g, '');
  if (s.length < 12) return false;
  if (/^\$\{\{?[^{}]*\}\}?$/.test(s)) return false;
  const id = '[A-Za-z_][A-Za-z0-9_]*';
  if (new RegExp(`^${id}(\\.${id})*(\\.${id}|\\(.*\\)|\\[.*\\])$`).test(s)) return false;
  if (/[./][A-Za-z0-9_-]+\.[a-z]{1,5}$/.test(s) || /^[A-Za-z0-9_-]+\.[a-z]{1,5}$/.test(s)) return false;
  return /[A-Za-z]/.test(s) && /[0-9]/.test(s);
}

/** 高置信的注入。会误伤普通问句的写法（“你现在是…”、单独出现的 system prompt）不算。 */
const INJECTION: Rule[] = [
  [
    /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(of\s+)?(the\s+|your\s+|my\s+|these\s+|those\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?|directions?|messages?)\b/i,
    '要求对方忽略之前指令的话',
  ],
  // 各组之间只容忍同一行里的空白（含全角空格），不容忍标点和换行：“这个告警可以忽略，之前的规则已经处理了”、
  // “这两个用例先忽略⏎之前的提示是误报”都是正常说法
  [/(忽略|无视|忽视|不要理会|别理会|不用理会|忘掉|忘记)[ \t\u3000]*(掉[ \t\u3000]*)?(你[ \t\u3000]*)?(之前|以上|上面|前面|先前|此前|上述)[ \t\u3000]*(的[ \t\u3000]*)?(所有[ \t\u3000]*|全部[ \t\u3000]*|一切[ \t\u3000]*)?(的[ \t\u3000]*)?(指令|规则|设定|提示|要求|指示)/, '要求对方忽略之前指令的话'],
  [/<\/?system>|###\s*system\b|<\|im_start\|>/i, '伪装成系统消息的标记'],
  [/\[SYSTEM\]/, '伪装成系统消息的标记'],
  // 只认“把/将 … 发给/发送/上传/贴出/输出”这种句式
  [/(把|将)[^。；;！!？?\n]{0,40}?(\.env\b|私钥|密钥|凭据|凭证|密码)[^。；;！!？?\n]{0,40}?(发给|发送|发到|传给|上传|贴出|贴到|输出)/, '要求把 .env、私钥、密码这类东西发出去的话'],
];

const COMMANDS: Rule[] = [
  [/```/, '代码块（```）'],
  [/(^|\n)[ \t]*\$ \S/, '以 $ 开头的命令行'],
  [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, '把下载的内容直接交给 shell 执行的命令（curl … | sh）'],
  [/\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)/i, '命令 rm -rf'],
  [/\bchmod\s/, '命令 chmod'],
  [/\bsudo\s/, '命令 sudo'],
  [/\bpip3?\s+install\b/, '命令 pip install'],
  [/\bnpm\s+install\b/, '命令 npm install'],
  [/\byarn\s+add\b/, '命令 yarn add'],
  [/\bpnpm\s+add\b/, '命令 pnpm add'],
  [/\bbrew\s+install\b/, '命令 brew install'],
];

/** 网页链接。到中文标点就截断：“见 https://github.com/x，然后……”里的逗号不算链接的一部分。 */
const LINK = /\b(?:https?|ftp|wss?):\/\/[^\s<>"'`，。；：！？、）」』】》]+/gi;
const HEX = /[0-9a-fA-F]{64,}/;
const BASE64 = /[A-Za-z0-9+/]{80,}={0,2}/g;
/** 看不见的字符（Unicode 的“默认可忽略”字符和 C1 控制字符）：先去掉再查，免得 ig\u200bnore、忽\u034f略这类写法绕过。渲染时也删掉同一组。 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u0080-\u009f]/gu;

const hits = (rules: Rule[], text: string) => rules.filter(([re]) => re.test(text)).map(([, why]) => why);

/** 像路径那样按 / 分段、每段都很短的，不算 base64。 */
function looksEncoded(run: string): boolean {
  if (!/[A-Za-z]/.test(run) || !/[0-9]/.test(run)) return false;
  return !(run.includes('/') && run.split('/').every((seg) => seg.length <= 24));
}

/**
 * 审核一条消息的全部文字（说明，加上声明里的“文件#符号”）。返回拒收原因，空数组表示放行。
 * allowDomains 只管消息里的链接；带用户名的链接（https://github.com@evil.example/ 这种）一律拒收。
 * 原文查一遍，再按渲染时的规整方式（说明按段落、声明按一行）查一遍：控制字符、边界标签在收件人那边会被删掉，
 * 插在中间挡住审核的东西到了那边就没了。只查规整后的也不行：续行开头的 [ 会变成 ［。
 */
export function reviewMessage(texts: string[], allowDomains: string[]): string[] {
  const raw = texts.join('\n');
  const shown = texts.map((t, i) => normalizeText(t, i > 0)).join('\n');
  return [...new Set([...check(raw, allowDomains), ...(shown === raw ? [] : check(shown, allowDomains))])];
}

/** 按全部规则查一段文字，返回命中的原因（可能重复，由调用方去重）。 */
function check(joined: string, allowDomains: string[]): string[] {
  // 先把各种换行（U+0085、U+2028 这类）换成 \n 再删看不见的字符：收件人那边它们是换行，不能把两句话拼成一句
  const text = joined.replace(LINE_BREAKS, '\n').replace(INVISIBLE, '');
  // 注入规则再按 NFKC 查一遍：全角英文（ｉｇｎｏｒｅ）。只给注入规则用：NFKC 会把中文标点变成英文的，链接规则就截不准了
  const reasons = [...hits(SECRETS, text), ...hits(INJECTION, text), ...hits(INJECTION, text.normalize('NFKC')), ...hits(COMMANDS, text)];
  if ([...text.matchAll(ENV_SECRET)].some((m) => secretValue(m[4]))) reasons.push(ENV_SECRET_WHY);
  for (const m of text.matchAll(LINK)) {
    let url: URL;
    try {
      url = new URL(m[0]);
    } catch {
      reasons.push('解析不了的链接');
      continue;
    }
    if (url.username || url.password) reasons.push('带用户名的链接');
    else if (!domainAllowed(url.hostname.replace(/^\[|\]$/g, ''), allowDomains)) reasons.push(`团队允许的域名以外的链接（${url.hostname}）`);
  }
  // 链接本身已经查过了，里面的长路径（比如带 commit 号的 GitHub 链接）不再按编码内容算
  const rest = text.replace(LINK, ' ');
  if (HEX.test(rest)) reasons.push('一长串十六进制（64 位以上）');
  if ([...rest.matchAll(BASE64)].some((m) => looksEncoded(m[0]))) reasons.push('一长串 base64');
  return reasons;
}

/** 拒收时退给发送方的话（422 的正文）。 */
export function rejectionMessage(reasons: string[]): string {
  return `这条消息没有发出：里面有${reasons.join('、')}。请改写后重发：只写事实，不带命令、代码块和链接；需要对方改依赖、CI、权限，或者涉及密钥的，请你的用户直接和对方沟通。`;
}
