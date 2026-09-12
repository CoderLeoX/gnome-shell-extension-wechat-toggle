# WeChat Window Toggle（微信窗口切换）

[![Check](https://github.com/CoderLeoX/gnome-shell-extension-wechat-toggle/actions/workflows/check.yml/badge.svg)](https://github.com/CoderLeoX/gnome-shell-extension-wechat-toggle/actions/workflows/check.yml)

一个 GNOME Shell 扩展：用一个快捷键在「显示」和「收进系统托盘」之间切换 **微信 Linux 版**
的主窗口，并让窗口回到收起前的位置和尺寸。

微信 Linux 4.x 的主窗口是原生 Wayland 窗口，`xdotool`、`wmctrl`、`xprop` 这类 X11 工具
既看不到也控制不了它。因此扩展运行在 GNOME Shell 进程内，只用微信提供的两条通道：
调托盘图标来呼出窗口、发关闭请求来收起窗口。

## 环境要求

- GNOME Shell 45 或更新版本，**Wayland** 会话（X11 会话有更简单的做法）
- 微信 Linux 4.x
- 从源码安装时需要 `glib-compile-schemas`

## 安装

### 从源码安装

```bash
git clone https://github.com/CoderLeoX/gnome-shell-extension-wechat-toggle.git
cd gnome-shell-extension-wechat-toggle
./install.sh       # 然后注销重新登录一次
```

GNOME Shell 只在启动时加载扩展，Wayland 会话又无法原地重载，所以安装完需要注销一次。

### 从 extensions.gnome.org 安装

尚未发布，提交正在准备中。

## 使用

默认快捷键 <kbd>Alt</kbd>+<kbd>s</kbd>。

| 微信当前状态 | 按下快捷键之后 |
| --- | --- |
| 主窗口显示中 | 向窗口发关闭请求，微信自己收进系统托盘 |
| 收在托盘里 | 相当于单击托盘图标，窗口带着原来的位置和尺寸回来 |
| 还没运行 | 什么都不做：扩展不会替你启动微信 |

> **重要**：收起依赖微信自身的「关闭主窗口时最小化到系统托盘」行为，请保持
> *设置 → 通用 → 关闭主窗口 → 最小化到系统托盘* 开启，否则快捷键会直接退出微信。

## 界面截图

![设置界面](docs/screenshots/preferences.png)

窗口会带着收起前的尺寸和位置回来，中间这段时间它待在系统托盘里：

![收在托盘里](docs/screenshots/hidden-to-tray.png)

![窗口恢复原位](docs/screenshots/window-restored.png)

截图里的会话列表是刻意打码的。

## 设置界面

```bash
gnome-extensions prefs wechat-toggle@coderleox.github.io
```

- **快捷键** —— 任意组合键（至少要带一个修饰键）
- **调试日志** —— 默认关闭；不开启时扩展不往系统日志里写任何内容
- **忘记窗口几何** —— 清除记住的位置和尺寸

## 实现要点

1. **收起 = 发关闭请求**（`Meta.Window.close()`/`delete()`），微信把它当成「最小化到托盘」。
   微信没有提供隐藏窗口的 DBus 方法，所以收起和呼出并不对称。
2. **呼出 = 重放一次托盘单击**：先列出会话总线上的名字，对每个
   `org.kde.StatusNotifierItem-*` 用 `GetConnectionUnixProcessID` 拿到属主进程、
   再读 `/proc/<pid>/comm` 确认它属于微信，最后调它的 `Activate`。
   没有托盘图标就说明微信没在运行，此时**什么都不做** —— 扩展不会替你启动微信。
3. **窗口几何**存在 GSettings 里：窗口关闭时记录，微信重建窗口时恢复，并在之后几秒内
   持续校准 —— 因为微信会在登录完成后自己再定一次尺寸。几何只从"既不过小、也没有最大化"
   的窗口上采集：最大化窗口报出来的是整个工作区，把窗口调到正好那尺寸正是 Mutter 判定
   "应该最大化"的依据。窗口一旦离开窗口栈就绝不再被触碰 —— 这一步曾导致 Shell 崩溃。
   为避免肉眼可见的跳变，点过托盘图标后新建的窗口会被**摆两次**：先立即摆一次，再在
   **Shell 把它 mapped 的那一刻**（首帧绘制之前）摆一次 —— 因为客户端首次提交会覆盖掉
   我们提前设好的几何。那一刻靠托盘图标属主的进程 id 认出它（微信是先建窗口、后设 WM class）。
4. **登录小窗的坑**：主窗口之前，微信会短暂显示一个登录/自动登录小窗（实测 280×380），
   它的 WM class 和标题与主窗口**完全相同**。扩展刻意不碰它：它本来也调不了大小，
   而记住它的几何正是「登录成功后主窗口变得又小又别扭」的根因。

## 已知限制

- 需要微信先启动过一次，扩展才能找到它的托盘图标；登录后的首次启动由扩展自己完成。
- 扩展只针对微信 Linux 桌面版及其托盘实现。
- 改动 `extension.js` 后需要注销重登才会生效。
- 在 GNOME Shell 50.1（Ubuntu / Wayland）+ 微信 Linux 4.1.9 上开发验证。
  `metadata.json` 里声明了更早的 Shell 版本，但未逐一验证，欢迎反馈。

## 排查问题

在设置界面打开「调试日志」，然后盯 Shell 日志：

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep wechat-toggle
```

确认微信注册了托盘图标：

```bash
busctl --user list | grep StatusNotifierItem
```

确认扩展处于启用状态：

```bash
gnome-extensions info wechat-toggle@coderleox.github.io
```

## 参与开发

欢迎提 issue 和 PR。遇到问题时，附上上面的调试日志、Shell 版本、微信版本
（`wechat --version`）以及会话类型（Wayland/X11），会好定位很多。

## 许可证

GPL-2.0-or-later，见 [LICENSE](LICENSE)。

这是一个非官方扩展，与腾讯无隶属、背书或支持关系。「微信」「WeChat」是腾讯控股有限公司的
商标，此处仅用于说明扩展的适用对象。
