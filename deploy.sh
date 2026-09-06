#!/usr/bin/env bash
# =============================================================================
# 微信 Alt+s 呼出/托盘切换 —— 一键部署脚本 (GNOME / Wayland)
#
# 用法:
#   bash deploy.sh
# 然后【注销并重新登录】一次让 GNOME Shell 加载扩展。
#
# 它会做 5 件事:
#   1) 安装呼出/启动脚本  -> ~/bin/desktop/toggle-wechat.sh
#   2) 安装 GNOME 扩展    -> ~/.local/share/gnome-shell/extensions/wechat-toggle@local/
#   3) 把扩展里硬编码的 /home/<user> 路径适配成当前用户
#   4) 编译 gsettings schema
#   5) 把扩展加入 GNOME 启用列表(org.gnome.shell enabled-extensions)
#
# 依赖: bash / cp / sed / gsettings / glib-compile-schemas / pgrep / busctl
#       GNOME Shell >= 45(ESM 扩展), 建议 Wayland 会话 + 微信 Linux 4.x
# =============================================================================
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="wechat-toggle@local"
EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
BIN_DIR="$HOME/bin/desktop"
BIN_DEST="$BIN_DIR/toggle-wechat.sh"

echo "==> [1/5] 安装呼出/启动脚本 -> $BIN_DEST"
mkdir -p "$BIN_DIR"
cp -f "$PKG_DIR/toggle-wechat.sh" "$BIN_DEST"
chmod +x "$BIN_DEST"

echo "==> [2/5] 安装 GNOME 扩展 -> $EXT_DEST"
rm -rf "$EXT_DEST"
mkdir -p "$EXT_DEST/schemas"
cp -f "$PKG_DIR"/extension/"$EXT_UUID"/extension.js   "$EXT_DEST/"
cp -f "$PKG_DIR"/extension/"$EXT_UUID"/metadata.json  "$EXT_DEST/"
cp -f "$PKG_DIR"/extension/"$EXT_UUID"/schemas/*.xml  "$EXT_DEST/schemas/"

echo "==> [3/5] 适配当前用户 HOME 路径"
# 扩展内部 TOGGLE_SCRIPT 写的是原机器绝对路径, 部署时替换成当前用户
sed -i "s#/home/[^/]*/bin/desktop#$BIN_DIR#g" "$EXT_DEST/extension.js"

echo "==> [4/5] 编译 schema"
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$EXT_DEST/schemas"
else
    echo "    警告: 未找到 glib-compile-schemas, 请手动执行:"
    echo "    glib-compile-schemas $EXT_DEST/schemas"
fi

# 让 metadata 的 shell-version 匹配当前 GNOME 大版本(例如 50), 避免因版本不符被拒绝加载
GV="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
if [ -n "$GV" ]; then
    sed -i -E "s/\"shell-version\": \[[^]]*\]/\"shell-version\": [\"$GV\"]/" "$EXT_DEST/metadata.json"
    echo "==> 已把 shell-version 适配为当前 GNOME $GV"
fi

echo "==> [5/5] 把扩展加入启用列表"
CUR="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || true)"
if printf '%s' "$CUR" | grep -q "$EXT_UUID"; then
    echo "    扩展已在启用列表, 跳过"
else
    inner="$(printf '%s' "$CUR" | sed -E 's/^@as \[\]$//; s/^\[//; s/\]$//' | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [ -z "$inner" ]; then
        NEW="['$EXT_UUID']"
    else
        NEW="[$inner, '$EXT_UUID']"
    fi
    gsettings set org.gnome.shell enabled-extensions "$NEW"
    echo "    已加入启用列表"
fi

echo
echo "========================================================================"
echo " 部署完成! 请【注销 → 重新登录】一次让扩展生效。"
echo " 之后按 Alt+s:"
echo "   微信显示中 -> 收进系统托盘(企鹅图标)"
echo "   在托盘/未开 -> 呼出 / 启动(自动恢复到上次窗口位置)"
echo "========================================================================"
