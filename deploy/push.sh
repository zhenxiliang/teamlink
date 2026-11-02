#!/usr/bin/env bash
# 从这台电脑把当前提交（HEAD）部署到服务器。
# 用法：deploy/push.sh 用户@主机 [ssh 密钥文件]
# 例如：deploy/push.sh deploy@your-server.example ~/.ssh/id_ed25519
set -euo pipefail

TARGET=${1:?用法：deploy/push.sh 用户@主机 [ssh 密钥文件]}
KEY=${2:-}
NODE_VERSION=v24.21.0
ROOT=$(cd "$(dirname "$0")/.." && pwd)

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
if [ -n "$KEY" ]; then SSH+=(-i "$KEY" -o IdentitiesOnly=yes); fi
remote() { "${SSH[@]}" "$TARGET" "$@"; }

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "注意：工作区有未提交的改动，部署的是最后一次提交。"
fi
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
echo "== 部署版本 $SHA 到 $TARGET"

# 1. 本服务专用的 Node.js。服务器能上外网就直接下载；不行就从这台电脑下载后传上去。
if [ "$(remote '~/teamlink/node/bin/node -v 2>/dev/null || true')" != "$NODE_VERSION" ]; then
  case "$(remote 'uname -m')" in
    x86_64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) echo "不支持的服务器架构"; exit 1 ;;
  esac
  TARBALL=node-$NODE_VERSION-linux-$ARCH.tar.xz
  URL=https://nodejs.org/dist/$NODE_VERSION/$TARBALL
  echo "== 安装 Node.js $NODE_VERSION 到 ~/teamlink/node"
  if ! remote "set -e; rm -rf ~/teamlink/node.tmp; mkdir -p ~/teamlink/node.tmp; curl -fsSL -m 300 $URL | tar -xJ --strip-components=1 -C ~/teamlink/node.tmp; rm -rf ~/teamlink/node; mv ~/teamlink/node.tmp ~/teamlink/node"; then
    echo "   服务器下载失败，改为从这台电脑下载后上传"
    CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/teamlink
    mkdir -p "$CACHE"
    [ -f "$CACHE/$TARBALL" ] || curl -fL -o "$CACHE/$TARBALL" "$URL"
    remote "set -e; rm -rf ~/teamlink/node.tmp; mkdir -p ~/teamlink/node.tmp; tar -xJ --strip-components=1 -C ~/teamlink/node.tmp; rm -rf ~/teamlink/node; mv ~/teamlink/node.tmp ~/teamlink/node" < "$CACHE/$TARBALL"
  fi
fi

# 2. 上传代码：用 git archive 打包这次提交，不会带上 node_modules 和本地数据
echo "== 上传代码"
git -C "$ROOT" archive --format=tar HEAD | remote "rm -rf ~/teamlink/releases/$SHA && mkdir -p ~/teamlink/releases/$SHA && tar -x -C ~/teamlink/releases/$SHA"

# 3. 在服务器上安装、切换版本、重启
remote "bash ~/teamlink/releases/$SHA/deploy/install-server.sh $SHA"

echo
echo "完成。常用命令（在服务器上）："
echo "  ~/teamlink/teamlink-server init --repo <团队仓库地址>   第一次部署时登记仓库"
echo "  ~/teamlink/teamlink-server invite                        给队友生成邀请码"
echo "  ~/teamlink/teamlink-server policy                        查看团队策略"
echo "  tail -f ~/teamlink/server.log                            看日志"
