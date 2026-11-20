// 两段文字像不像：中文按相邻两个字切（二元组），英文和数字按词切，都转小写。不分词、不用模型，结果可以预期。
// 两处用：连接器在 ask 之前查团队事实里是不是已经有答案；服务器统计同一个问题是不是被问了好几次。
// 宁可漏报，不能乱报：漏了顶多多问一次，乱报会挡住该问的问题。

/** 提问里常见、不说明问的是什么的二元组：“……是多少”“怎么……”。不算进特征，免得两句不相干的问句因为它们显得很像。 */
const FILLER = new Set([
  '多少', '是多', '什么', '是什', '怎么', '怎样', '如何', '为什', '这个', '那个', '一下', '是不', '不是', '是否', '可以', '能不',
  '现在', '我们', '你们', '他们', '有没', '没有', '的是', '时候', '么时', '么样', '请问', '一个', '哪个', '哪些',
]);
const WORD_STOP = new Set(['the', 'is', 'are', 'what', 'how', 'which', 'does', 'do', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'it', 'we', 'you']);

/** 一段文字的特征：中文二元组（单独一个汉字时就是它自己）、两个字母以上的英文词和数字。 */
export function grams(text: string): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  for (const m of t.matchAll(/[a-z0-9_]{2,}/g)) if (!WORD_STOP.has(m[0])) out.add(m[0]);
  for (const m of t.matchAll(/\p{Script=Han}+/gu)) {
    const cs = [...m[0]];
    if (cs.length === 1) out.add(cs[0]);
    for (let i = 0; i + 1 < cs.length; i++) {
      const g = cs[i] + cs[i + 1];
      if (!FILLER.has(g)) out.add(g);
    }
  }
  return out;
}

/** a 的特征有多大比例也在 b 里（0 到 1）：a 是短的那个（事实的主题），b 是长的那个（提问）。a 没有特征时为 0。 */
export function coverage(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / a.size;
}

/** 两段文字的相似度（Dice 系数，0 到 1）。 */
export function similarity(a: string | Set<string>, b: string | Set<string>): number {
  const x = typeof a === 'string' ? grams(a) : a;
  const y = typeof b === 'string' ? grams(b) : b;
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}
