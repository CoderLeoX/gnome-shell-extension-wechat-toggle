# 微信 Alt+s 托盘切换（可迁移部署包）

在 **GNOME / Wayland** 下用 `Alt+s` 一键切换微信主窗口：显示中收进系统托盘、在托盘则呼出、未运行则启动，并自动恢复到上次窗口位置。

> 开发背景：微信 Linux 4.x 是原生 Wayland + 自研引擎窗口，外部脚本（xdotool/wmctrl）无法控制它；因此收/放都经由一个 GNOME Shell 扩展在 Shell 进程内操作窗口，呼出则复用成熟可靠的 `busctl` 托盘(SNI)调用。

## 目录结构

```
wechat-hotkey/
├── deploy.sh                      # 一键部署脚本（新环境直接跑）
├── README.md                      # 本说明
├── toggle-wechat.sh               # 呼出/启动微信脚本（busctl 调托盘 SNI）
└── extension/wechat-toggle@local/
    ├── extension.js               # GNOME 扩展主逻辑
    ├── metadata.json              # 扩展元数据（uuid / shell-version）
    └── schemas/
        └── org.gnome.shell.extensions.wechat-toggle.gschema.xml
```

部署后实际生效位置：

| 文件 | 运行时路径 |
|---|---|
| 呼出脚本 | `~/bin/desktop/toggle-wechat.sh` |
| GNOME 扩展 | `~/.local/share/gnome-shell/extensions/wechat-toggle@local/` |
| 快捷键 schema | `~/…/wechat-toggle@local/schemas/`（需编译成 `gschemas.compiled`） |

## 快速部署

```bash
bash ~/bin/desktop/wechat-hotkey/deploy.sh
# 然后注销 → 重新登录一次
```

## 前提与依赖

- GNOME Shell ≥ 45（扩展用 ESM 写法；`deploy.sh` 会把 `shell-version` 自动改成当前大版本）
- Wayland 会话（X11 会话下另有一套做法，本包面向 Wayland）
- 微信 Linux 4.x，安装于 `/usr/bin/wechat`（若非此路径，改 `toggle-wechat.sh` 里的 `WEIXIN_BIN`）
- 系统工具：`bash`、`busctl`（systemd）、`pgrep`（procps）、`glib-compile-schemas`
- 微信设置里勾选“关闭主窗口时最小化到系统托盘”（否则收起的“关闭”行为会退出微信）

## 常用自定义

| 想改什么 | 怎么改 |
|---|---|
| 快捷键（默认 `Alt+s`） | 改 `schemas/*.gschema.xml` 里的 `<Alt>s` 默认值后重跑 deploy；或运行期用 `gsettings --schemadir …/schemas set … toggle-wechat "['<键>']"` |
| 微信可执行路径 | 改 `toggle-wechat.sh` 顶部 `WEIXIN_BIN` |
| 关掉“恢复上次位置” | 删掉 `extension.js` 里 `_onWindowCreated` 中恢复逻辑（或把 `last-geometry` 置空） |

## 卸载

```bash
gsettings reset org.gnome.shell enabled-extensions   # 注意：会清空整列，若有其它扩展请手动移除本 uuid
rm -rf ~/.local/share/gnome-shell/extensions/wechat-toggle@local
rm -f ~/bin/desktop/toggle-wechat.sh
# 重登一次生效
```

## 设计要点 / 已知限制

- **收起=向窗口发“关闭”请求**（`meta_window.delete`，GNOME 50 中方法名，旧版为 `close`），由微信自己把它收进系统托盘企鹅图标。
- **呼出=调微信托盘 SNI 的 `Activate`**（等价单击企鹅），比在扩展里手工解析 DBus 更可靠；未运行时该脚本会直接启动微信。
- **恢复位置**：收起/关闭时记录窗口几何到 gsettings；`window-created` 时在窗口显示前预置几何 + 密集微调，尽量减少“先居中再跳”的闪烁。
- GNOME Wayland 下**改扩展代码必须注销重登**才能生效（GJS 模块缓存，`disable/enable` 不会重读磁盘代码）；改 gsettings 值则即时生效。
- 微信 Linux 本身不会记忆窗口位置，本扩展补上这段。
