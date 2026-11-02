#!/usr/bin/env bash
# 在服务器上运行（由 deploy/push.sh 调用）：切换到新版本、配置开机自启、重启服务。
# 全部装在 ~/teamlink 下，不需要 sudo，也不需要 git、python（服务器不读仓库）。
#
#   ~/teamlink/node/        本服务专用的 Node.js
#   ~/teamlink/releases/    每次部署一个目录，保留最近 5 个
#   ~/teamlink/app          指向当前版本
#   ~/teamlink/data/        数据库和团队策略（升级时保留；从旧版升级时，旧库备份成 teamlink.db.v1.bak）
#   ~/teamlink/env          端口、监听地址（第一次生成，之后保留你的修改）
#   ~/teamlink/server.log   运行日志
set -euo pipefail

SHA=${1:?用法：install-server.sh <版本>}
BASE=$HOME/teamlink
REL=$BASE/releases/$SHA
export PATH=$BASE/node/bin:$PATH

# 服务器只用 Node 自带的模块，没有要装的依赖；先确认这个版本已经上传
cd "$REL"

mkdir -p "$BASE/data"
if [ ! -f "$BASE/env" ]; then
  printf 'PORT=7420\nHOST=0.0.0.0\n' > "$BASE/env"
fi

# 运行脚本：崩溃后 3 秒自动重启；flock 保证同时只跑一份。
# 先写临时文件再 mv，避免改到正在运行的那份脚本。
cat > "$BASE/run.sh.new" <<'EOF'
#!/usr/bin/env bash
BASE=$HOME/teamlink
exec 9>"$BASE/run.lock"
flock -n 9 || { echo "teamlink 已经在运行"; exit 0; }
while true; do
  . "$BASE/env"
  echo "$(date '+%F %T') 启动 teamlink（版本 $(basename "$(readlink "$BASE/app")")）"
  "$BASE/node/bin/node" "$BASE/app/bin/teamlink-server.js" start --data "$BASE/data" --host "$HOST" --port "$PORT"
  echo "$(date '+%F %T') teamlink 退出（代码 $?），3 秒后重启"
  sleep 3
done
EOF
chmod +x "$BASE/run.sh.new"
mv "$BASE/run.sh.new" "$BASE/run.sh"

# 管理命令的快捷方式：~/teamlink/teamlink-server invite / add-repo / policy ...
cat > "$BASE/teamlink-server.new" <<'EOF'
#!/usr/bin/env bash
BASE=$HOME/teamlink
exec "$BASE/node/bin/node" "$BASE/app/bin/teamlink-server.js" --data "$BASE/data" "$@"
EOF
chmod +x "$BASE/teamlink-server.new"
mv "$BASE/teamlink-server.new" "$BASE/teamlink-server"

ln -sfn "$REL" "$BASE/app"
echo "== 当前版本：$SHA"

# 开机自启：优先用户级 systemd（需要 linger，退出登录后也继续跑）；不行就用 crontab @reboot。
loginctl enable-linger "$USER" >/dev/null 2>&1 || true
if [ "$(loginctl show-user "$USER" -p Linger 2>/dev/null | cut -d= -f2)" = "yes" ] && systemctl --user is-system-running >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/teamlink.service" <<'EOF'
[Unit]
Description=teamlink：团队成员的 AI 之间互相传话

[Service]
ExecStart=%h/teamlink/run.sh
StandardOutput=append:%h/teamlink/server.log
StandardError=append:%h/teamlink/server.log
Restart=always

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable teamlink >/dev/null 2>&1
  systemctl --user restart teamlink
  echo "== 自启方式：用户级 systemd（systemctl --user status teamlink）"
else
  LINE="@reboot $BASE/run.sh >> $BASE/server.log 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "$BASE/run.sh"; echo "$LINE" ) | crontab -
  # 先结束旧循环：它还按旧脚本的内容在跑（启动参数是旧的）。再结束它启动的服务器进程，
  # 服务器进程继承了循环的 run.lock，不结束它，新循环拿不到锁
  pkill -f "$BASE/run.sh" || true
  pkill -f "teamlink-server.js start --data $BASE/data" || true
  for _ in $(seq 1 10); do
    pgrep -f "teamlink-server.js start --data $BASE/data" >/dev/null || break
    sleep 1
  done
  nohup setsid "$BASE/run.sh" >> "$BASE/server.log" 2>&1 < /dev/null &
  echo "== 自启方式：crontab @reboot（没有 linger 权限）"
fi

. "$BASE/env"
for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "== 服务已就绪：端口 $PORT"
    break
  fi
  sleep 1
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || { echo "!! 服务没有起来，看看 $BASE/server.log"; tail -20 "$BASE/server.log"; exit 1; }

# 只保留最近 5 个版本
ls -1t "$BASE/releases" | tail -n +6 | while read -r old; do
  [ "$BASE/releases/$old" = "$(readlink "$BASE/app")" ] || rm -rf "${BASE:?}/releases/$old"
done
