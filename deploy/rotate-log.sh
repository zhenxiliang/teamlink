#!/usr/bin/env bash
# 日志轮转：日志超过上限就另存一份再清空，保留最近几份（server.log.1 最新）。
# 用法：deploy/rotate-log.sh <日志文件> [上限字节数，默认 10 MB] [保留几份，默认 3]
#
# 写日志的一方不用重启：systemd 的 append: 和 shell 的 >> 都是用追加方式打开文件的，清空以后接着从文件开头写。
# 所以这里是“复制再清空”，不是改名——改名以后对方还在往旧文件里写。复制和清空之间写进来的几行会丢。
set -euo pipefail

LOG=${1:?用法：rotate-log.sh <日志文件> [上限字节数] [保留几份]}
MAX=${2:-10485760}
KEEP=${3:-3}

[ -f "$LOG" ] || exit 0
[ "$(wc -c < "$LOG")" -gt "$MAX" ] || exit 0

rm -f "$LOG.$KEEP"
for ((i = KEEP - 1; i >= 1; i--)); do
  if [ -f "$LOG.$i" ]; then mv -f "$LOG.$i" "$LOG.$((i + 1))"; fi
done
cp "$LOG" "$LOG.1"
: > "$LOG"
