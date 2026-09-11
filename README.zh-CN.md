# 微信 Alt+s 托盘切换（可迁移部署包）

在 **GNOME / Wayland** 下用 `Alt+s` 一键切换微信主窗口：显示中收进系统托盘、在托盘则呼出、未运行则启动，并自动恢复到上次窗口位置。

> 开发背景：微信 Linux 4.x 是原生 Wayland + 自研引擎窗口，外部脚本（xdotool/wmctrl）无法控制它；因此收/放都经由一个 GNOME Shell 扩展在 Shell 进程内操作窗口。
>
> 呼出/启动也**已全部内置进扩展**：不再 spawn 外部脚本，而是在 Shell 进程内直接用会话总线调微信托盘 SNI 的 `Activate`（未运行则启动微信）。原先的 `toggle-wechat.sh` 已删除，扩展零外部脚本依赖。

## 目录结构

```
wechat-hotkey/
├── deploy.sh                      # 一键部署脚本（新环境直接跑）
├── README.md                      # 本说明
└── extension/wechat-toggle@local/
    ├── extension.js               # GNOME 扩展主逻辑（窗口恢复 + 呼出/启动，自带 DBus 调用）
    ├── metadata.json              # 扩展元数据（uuid / shell-version）
    └── schemas/
        └── org.gnome.shell.extensions.wechat-toggle.gschema.xml
```

部署后实际生效位置：

| 文件 | 运行时路径 |
|---|---|
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
- 微信 Linux 4.x，安装于 `/usr/bin/wechat`（若非此路径，改 `extension.js` 顶部 `WECHAT_BIN`）
- 系统工具：仅 `glib-compile-schemas`（运行期不需要 `bash`/`busctl`/`pgrep`）
- 微信设置里勾选“关闭主窗口时最小化到系统托盘”（否则收起的“关闭”行为会退出微信）

## 常用自定义

| 想改什么 | 怎么改 |
|---|---|
| 快捷键（默认 `Alt+s`） | 改 `schemas/*.gschema.xml` 里的 `<Alt>s` 默认值后重跑 deploy；或运行期用 `gsettings --schemadir …/schemas set … toggle-wechat "['<键>']"` |
| 微信可执行路径 | 改 `extension.js` 顶部 `WECHAT_BIN` |
| 关掉“恢复上次位置” | 删掉 `extension.js` 里 `_onWindowCreated` 中恢复逻辑（或把 `last-geometry` 置空） |

## 不用快捷键时怎么手动呼出

扩展的呼出就是“单击托盘企鹅”，命令行等价物（`gdbus` 版，不需要任何脚本）：

```bash
name=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
         --method org.freedesktop.DBus.ListNames | tr ',' '\n' | grep -o 'org\.kde\.StatusNotifierItem-[0-9]*-[0-9]*' | head -1) && \
gdbus call --session --dest "$name" --object-path /StatusNotifierItem \
  --method org.kde.StatusNotifierItem.Activate 0 0
```

## 卸载

```bash
gsettings reset org.gnome.shell enabled-extensions   # 注意：会清空整列，若有其它扩展请手动移除本 uuid
rm -rf ~/.local/share/gnome-shell/extensions/wechat-toggle@local
# 重登一次生效
```

## 设计要点 / 已知限制

- **收起=向窗口发“关闭”请求**（`meta_window.delete`，GNOME 50 中方法名，旧版为 `close`），由微信自己把它收进系统托盘企鹅图标。
- **呼出=进程内调微信托盘 SNI 的 `Activate`**（等价单击企鹅）：`ListNames` 找 `org.kde.StatusNotifierItem-*` → `GetConnectionUnixProcessID` 确认属主进程是 `wechat`（避免误触别的托盘图标）→ 调 `Activate(ii)` 呼出；若找不到（微信没运行）则 `spawn` 启动微信，再以 500ms × 20 次轮询等它注册 SNI 后呼出。全程只用会话总线，**不派生外部脚本、不依赖 `busctl`/`pgrep`**。
- **恢复位置**：主窗口创建时按记忆的几何恢复（位置 + 尺寸），并在其后约 3 秒内持续校准（每 60ms 一次、连续吻合 12 拍后提前收工），以覆盖微信登录完成后自己再定一次尺寸的行为。
- GNOME Wayland 下**改扩展代码必须注销重登**才能生效（GJS 模块缓存，`disable/enable` 不会重读磁盘代码）；改 gsettings 值则即时生效。
- 微信 Linux 本身不会记忆窗口位置，本扩展补上这段。

## 踩坑记录：登录成功后窗口变得又小又别扭

**现象**：微信启动/登录成功那一刻，主窗口被摆成很小的一块（实测被摆成 `280x380`）。

**原因**（日志实证）：

```
22:39:42 created mapped=false              ← 微信启动，先出现 280x380 的“登录/自动登录”中转小窗
22:39:51 remember SAVED 1580,506,280,380   ← 小窗关闭触发 unmanaged，这个尺寸被写进 last-geometry
22:39:51 created mapped=false              ← 主窗口随即创建，读到的正是刚被污染的 280x380
```

微信的登录小窗**同样是 `wm_class=wechat`、标题同样是「微信」**，光靠类名/标题无法与主窗口区分，于是：

1. 它被当成主窗，挂上了 `unmanaged` 记忆钩子；它一关闭就把 `280x380` 存成“上次窗口几何”，污染记忆值；
2. 紧接着真正的主窗创建，就用这个坏值去 `move_resize_frame`；
3. 旧实现只比对 x/y（位置一对上就收工），所以微信随后把尺寸改回自己的默认值也不会被发现。

**对策**（`extension.js`）：

- 新增尺寸门槛 `MAIN_MIN_W=500 / MAIN_MIN_H=400`：小于它的微信窗口一律只观察，**不干预、不记忆**；
- `_rememberPosition` 增加同样的尺寸校验，杜绝小窗污染记忆值；
- `_geometry()` 读到不合尺寸的坏值时**自动清空自愈**；
- 恢复逻辑重写为「等元数据就绪 → 确认是主窗尺寸 → 位置+尺寸都比对 → 到位后再盯 ~0.7s」，并且不再对非微信窗口（如 fcitx 候选框）动手；
- `_findWechatWindow()` 改为在微信窗口里取**面积最大**的那个，确保 `Alt+s` 永远作用在主窗上。

> 若升级前已经被污染：`last-geometry` 若为小值会被自动清除；也可手动 `dconf reset /org/gnome/shell/extensions/wechat-toggle/last-geometry`。
