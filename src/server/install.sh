#!/usr/bin/env bash
# teamlink 一键接入：安装本地连接器，加入团队，给当前仓库装好 Codex 的 hook。
# 在团队仓库目录里运行：
#   curl -fsSL __TEAMLINK_SERVER__/install.sh | bash -s -- --invite 邀请码 --name 你的名字
# 只安装、先不加入团队：
#   curl -fsSL __TEAMLINK_SERVER__/install.sh | bash
# 重复运行就是升级。
set -euo pipefail

SERVER="__TEAMLINK_SERVER__"
NODE_VERSION="v24.21.0"
DIR="${TEAMLINK_HOME:-${HOME}/.teamlink}"

say() { printf '%s\n' "$*"; }
die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

# 1. Node.js 23.6 以上（teamlink 直接运行 TypeScript，不需要编译）
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>23||(a===23&&b>=6)?0:1)' >/dev/null 2>&1; }
NODE=""
if command -v node >/dev/null 2>&1 && node_ok node; then
  NODE=$(command -v node)
elif [ -x "${DIR}/node/bin/node" ] && node_ok "${DIR}/node/bin/node"; then
  NODE="${DIR}/node/bin/node"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLAT=darwin-arm64 ;;
    Darwin-x86_64) PLAT=darwin-x64 ;;
    Linux-x86_64) PLAT=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) PLAT=linux-arm64 ;;
    *) die "不支持的系统：$(uname -s) $(uname -m)" ;;
  esac
  FILE="node-${NODE_VERSION}-${PLAT}.tar.gz"
  TMP=$(mktemp -d)
  trap 'rm -rf "${TMP}"' EXIT
  ok=""
  for BASE in "https://nodejs.org/dist/${NODE_VERSION}" "https://npmmirror.com/mirrors/node/${NODE_VERSION}"; do
    say "下载 Node.js ${NODE_VERSION}：${BASE}/${FILE}"
    if curl -fsSL -m 600 -o "${TMP}/${FILE}" "${BASE}/${FILE}" && curl -fsSL -m 60 -o "${TMP}/SHASUMS256.txt" "${BASE}/SHASUMS256.txt"; then
      ok=1
      break
    fi
  done
  [ -n "$ok" ] || die "下载 Node.js 失败。请手动安装 Node.js 23.6 以上，再重新运行这条命令。"
  want=$(awk -v f="${FILE}" '$2 == f { print $1 }' "${TMP}/SHASUMS256.txt")
  got=$( (shasum -a 256 "${TMP}/${FILE}" 2>/dev/null || sha256sum "${TMP}/${FILE}") | awk '{ print $1 }')
  [ -n "${want}" ] && [ "${want}" = "${got}" ] || die "Node.js 安装包的 SHA256 校验不通过，已停止安装。"
  mkdir -p "${DIR}"
  rm -rf "${DIR}/node.tmp"
  mkdir -p "${DIR}/node.tmp"
  tar -xzf "${TMP}/${FILE}" --strip-components=1 -C "${DIR}/node.tmp"
  rm -rf "${DIR}/node"
  mv "${DIR}/node.tmp" "${DIR}/node"
  NODE="${DIR}/node/bin/node"
fi
say "使用 Node.js $("${NODE}" -v)（${NODE}）"

# 2. 本地连接器：从团队服务器下载，重复运行就是升级
mkdir -p "${DIR}"
rm -rf "${DIR}/app.tmp"
mkdir -p "${DIR}/app.tmp"
curl -fsSL -m 120 "${SERVER}/download/teamlink.tar.gz" | tar -xz -C "${DIR}/app.tmp" || die "从 ${SERVER} 下载 teamlink 失败"
rm -rf "${DIR}/app"
mv "${DIR}/app.tmp" "${DIR}/app"
say "已安装 teamlink 到 ${DIR}"

# 3. 加进 PATH。Codex 用登录 shell（zsh -lc）执行命令，只读 .zprofile 不读 .zshrc，所以两个都加。
# 路径放在单引号里（里面的单引号写成 '\''）：路径里有 $、反引号、引号时原样保留，不会被当成命令。
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
LINE="export PATH=$(shq "${DIR}/bin"):\"\$PATH\"  # teamlink"
# 两个文件分开放：拼成一个字符串再拆的话，HOME 里带空格就会被拆错
if [ "$(basename "${SHELL:-/bin/zsh}")" = "zsh" ]; then
  RC1="${HOME}/.zprofile"
  RC2="${HOME}/.zshrc"
else
  # bash 的登录 shell 只读 ~/.bash_profile、~/.bash_login、~/.profile 里第一个存在的，写那一个。
  # 不新建 ~/.bash_profile：Ubuntu、Debian 默认只有 ~/.profile，新建了以后它就不再被读。
  RC1="${HOME}/.profile"
  if [ -f "${HOME}/.bash_profile" ]; then
    RC1="${HOME}/.bash_profile"
  elif [ -f "${HOME}/.bash_login" ]; then
    RC1="${HOME}/.bash_login"
  fi
  RC2="${HOME}/.bashrc"
fi
for rc in "${RC1}" "${RC2}"; do
  if ! grep -qF '# teamlink' "${rc}" 2>/dev/null; then
    printf '\n%s\n' "${LINE}" >> "${rc}"
    say "已把 teamlink 加进 PATH：${rc}"
  fi
done
export PATH="${DIR}/bin:$PATH"

# 4. 加入团队，并给当前仓库装 Codex 的 hook。
# 启动脚本 ${DIR}/bin/teamlink 和 node-path 由 setup 第一步写好（和 teamlink install 写的是同一份），hook 命令和 AI 用的 teamlink 命令都走它
TEAMLINK_HOME="${DIR}" "${NODE}" "${DIR}/app/bin/teamlink.js" setup --server "${SERVER}" "$@"
