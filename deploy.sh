#!/usr/bin/env bash
# =============================================================================
# 微信 Alt+s 呼出/托盘切换 —— 一键部署脚本 (GNOME / Wayland)
#
# 用法:
#   bash deploy.sh
# 然后【注销并重新登录】一次让 GNOME Shell 加载扩展。
#
# 它会做 3 件事:
#   1) 安装 GNOME 扩展    -> ~/.local/share/gnome-shell/extensions/wechat-toggle@local/
#   2) 编译 gsettings schema, 并把 metadata 的 shell-version 适配为当前 GNOME 版本
#   3) 把扩展加入 GNOME 启用列表(org.gnome.shell enabled-extensions)
#
# 说明: 呼出/启动已全部内置在扩展里(会话总线直接调微信托盘 SNI), 没有外部脚本依赖。
#
# 依赖: bash / cp / sed / gsettings / glib-compile-schemas
#       GNOME Shell >= 45(ESM 扩展), 建议 Wayland 会话 + 微信 Linux 4.x
# =============================================================================
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="wechat-toggle@local"
EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "==> [1/3] 安装 GNOME 扩展 -> $EXT_DEST"
rm -rf "$EXT_DEST"
mkdir -p "$EXT_DEST/schemas"
cp -f "$PKG_DIR"/extension/"$EXT_UUID"/extension.js   "$EXT_DEST/"
cp -f "$PKG_DIR"/extension/"$EXT_UUID"/metadata.json  "$EXT_DEST/"
cp -f "$PKG_DIR"/extension/"$EXT_UUID"/schemas/*.xml  "$EXT_DEST/schemas/"

echo "==> [2/3] 编译 schema"
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

echo "==> [3/3] 把扩展加入启用列表"
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
