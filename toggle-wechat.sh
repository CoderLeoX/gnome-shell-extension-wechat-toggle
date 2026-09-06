#!/usr/bin/env bash
# toggle-wechat.sh —— 呼出 / 启动微信 (Linux 4.x, 原生 Wayland)
#
# 为什么这样实现:
#   * 微信 4.0 Linux 主窗口是「原生 Wayland」窗口(自研 Andromeda 引擎),
#     不在 XWayland 上,因此旧版基于 xdotool/wmctrl/xprop 的方案会失效
#     (X11 工具无法看到/控制 Wayland 原生窗口)。
#   * 微信会把自己的系统托盘图标注册为 StatusNotifierItem(SNI),
#     DBus 名为 org.kde.StatusNotifierItem-<pid>-<n>。
#     调用其 org.kde.StatusNotifierItem.Activate 等价于「单击托盘图标」,
#     能把藏在托盘的微信主窗口呼出;微信未运行则先启动。
#
# 限制说明:
#   * GNOME Wayland 下,外部脚本无法把「已显示的微信原生窗口」强隐回托盘
#     (微信无隐藏类 DBus 方法,Wayland 也不允许第三方控制窗口)。
#     想收起来: 点微信窗口右上角 ✕ 即可(微信 Linux 关闭 = 最小化到托盘)。
#
# 依赖: bash / pgrep (procps) / busctl (systemd) —— Ubuntu 均预装。
# 可选: TOGGLE_WECHAT_DEBUG=1 环境变量开启调试日志(输出到 stderr)。

WEIXIN_BIN="/usr/bin/wechat"

log() { [ -n "${TOGGLE_WECHAT_DEBUG:-}" ] && echo "[toggle-wechat] $*" >&2; }

# 返回微信主进程 pid(若有)
get_pid() { pgrep -x wechat 2>/dev/null | head -n 1; }

# 返回某 pid 注册的 SNI 托盘 DBus 名
sni_name_of() {
  local pid="$1"
  busctl --user --no-pager list 2>/dev/null | awk -v p="$pid" '$2==p && $1 ~ /^org\.kde\.StatusNotifierItem-/ { print $1; exit }'
}

# 触发托盘单击(呼出窗口)
activate() {
  busctl --user call "$1" /StatusNotifierItem org.kde.StatusNotifierItem Activate ii 0 0 >/dev/null 2>&1
}

PID="$(get_pid)"
log "当前微信 pid=${PID:-无}"

if [ -z "$PID" ]; then
  # 微信没在运行 → 启动,并等它注册托盘后呼出一次
  log "微信未运行,启动 $WEIXIN_BIN"
  nohup "$WEIXIN_BIN" >/dev/null 2>&1 &
  for _ in $(seq 1 20); do      # 最多约 10s(每 0.5s 探测一次)
    sleep 0.5
    NEWPID="$(get_pid)"
    [ -z "$NEWPID" ] && continue
    NAME="$(sni_name_of "$NEWPID")"
    if [ -n "$NAME" ]; then
      log "SNI 就绪($NAME),呼出窗口"
      activate "$NAME"
      break
    fi
  done
else
  NAME="$(sni_name_of "$PID")"
  if [ -n "$NAME" ]; then
    # 已运行 → 呼出(把窗口从托盘带到屏幕/调到前面)
    log "SNI 就绪($NAME),呼出窗口"
    activate "$NAME"
  else
    # 兜底: SNI 尚未就绪(如刚启动)时,二次运行触发微信单实例唤起
    log "未找到 SNI,尝试二次启动唤起"
    nohup "$WEIXIN_BIN" >/dev/null 2>&1 &
  fi
fi
