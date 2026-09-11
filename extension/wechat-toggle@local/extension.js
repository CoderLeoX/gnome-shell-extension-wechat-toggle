import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ============================ 呼出/启动(进程内完成) ============================
// 早先这一步是 spawn 一个外部脚本 toggle-wechat.sh(bash + pgrep + busctl)。
// 其实脚本干的事在 Shell 进程里用会话总线几行就能做完, 于是统一进来:
//   * 不再依赖 bash/pgrep/busctl, 也不用在 deploy 时替换脚本路径;
//   * 少一次进程派生, 更不容易被外部环境(登录 shell、PATH)影响。
// 脚本文件保留作命令行应急/调试用, 扩展本身已不再需要它。
const WECHAT_BIN = '/usr/bin/wechat';            // 与脚本里的 WEIXIN_BIN 保持一致

// 微信系统托盘图标的 StatusNotifierItem(SNI) 约定
// 总线名形如 org.kde.StatusNotifierItem-<pid>-<n>
const SNI_PREFIX = 'org.kde.StatusNotifierItem-';
const SNI_PATH = '/StatusNotifierItem';
const SNI_IFACE = 'org.kde.StatusNotifierItem';
// 微信进程名(用来确认某个 SNI 是不是微信的, 避免误触别的托盘图标)
const WECHAT_COMM = 'wechat';

// org.freedesktop.DBus 上的两个辅助方法
const DBUS_DEST = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';

// 启动微信后等它注册 SNI 的上限(20 x 500ms ≈ 10s)
const SNI_WAIT_TRIES = 20;
const SNI_WAIT_MS = 500;
// 单次 DBus 调用超时(毫秒), 防止托盘项卡住把 Alt+s 拖死
const DBUS_TIMEOUT = 3000;

// ============================ 尺寸门槛(重要) ============================
// 微信启动/登录时, 会先出现一个很小的“登录/自动登录”中转窗口(实测 280x380),
// 它的 wm_class 同样是 wechat、标题同样是“微信”, 单凭类名/标题无法与主窗口区分。
// 这正是这个扩展最容易踩的坑:
//   * 它被当成主窗 → 关闭时触发 unmanaged, 把 "1580,506,280,380" 写进
//     last-geometry, 于是紧接着创建的主窗口被“恢复”成 280x380
//     → 登录成功后窗口又小又别扭。
//   * 它还会被 move_resize 强行放大(它自己不接受, 白折腾)。
// 所以: 比主窗口最小尺寸还小的微信窗口, 一律只观察、不干预、不记忆。
const MAIN_MIN_W = 500;
const MAIN_MIN_H = 400;

// 主窗口出现后继续校准的时长: 微信登录完成/首次显示后还会自己再定一次尺寸,
// 早退就会被它覆盖, 所以要多盯一会儿。单位毫秒。
const ENFORCE_MS = 3000;
// 位置+尺寸连续吻合这么多拍就认为稳定, 提前收工
const SETTLE_TICKS = 12;
// 轮询间隔(毫秒)
const TICK_MS = 60;

export default class WechatToggleExtension extends Extension {
    enable() {
        // GNOME 50: getSettings() 需要显式传 schema id(不再从 uuid 自动推导)
        this._settings = this.getSettings('org.gnome.shell.extensions.wechat-toggle');
        this._timers = new Set();
        this._sleepers = new Map();
        this._presenting = false;
        // 把 schema 里的快捷键(toggle-wechat, 默认 <Alt>s)注册为全局快捷键
        Main.wm.addKeybinding(
            'toggle-wechat',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._onToggle()
        );
        this._keyAdded = true;
        // 监听新窗口出现: 微信被呼出/重新启动时会重建主窗口, 用它恢复上次位置
        const onCreated = (display, win) => this._onWindowCreated(win);
        try {
            this._winSig = global.display.connect('window-created', onCreated);
        } catch (e) {
            this._winSig = global.display.connect('window-added', onCreated);
        }
    }

    disable() {
        // removeKeybinding 需要的是注册时的字符串名 'toggle-wechat'(不是 addKeybinding 的数字返回值)
        if (this._keyAdded) {
            try { Main.wm.removeKeybinding('toggle-wechat'); } catch (e) {}
            this._keyAdded = false;
        }
        if (this._winSig) {
            try { global.display.disconnect(this._winSig); } catch (e) {}
            this._winSig = null;
        }
        // 唤醒还在等待的 _sleep(它们恢复后会因 this._settings 已空而放弃)
        if (this._sleepers) {
            for (const resolve of this._sleepers.values()) {
                try { resolve(); } catch (e) {}
            }
            this._sleepers.clear();
        }
        if (this._timers) {
            for (const id of this._timers) {
                try { GLib.source_remove(id); } catch (e) {}
            }
            this._timers.clear();
        }
        this._presenting = false;
        this._settings = null;
    }

    // 判断某窗口是否为"微信的窗口"(排除 WeChatAppEx 小程序容器 / 子对话框)。
    // 注意: 这里只按身份判定, 不代表它一定是主窗口(登录小窗也会命中)。
    _isWechatWindow(win) {
        if (!win)
            return false;
        if (typeof win.is_attached_dialog === 'function' && win.is_attached_dialog())
            return false;
        const cls = (win.get_wm_class() || '').toLowerCase();
        const title = (win.get_title() || '').toLowerCase();
        if (/wechat/.test(cls) && !/appex/.test(cls))
            return true;
        return title.startsWith('微信');
    }

    // 尺寸小到不可能是主窗口 → 认定为登录/自动登录中转小窗(这类窗口碰不得)
    _isTooSmallToBeMain(win) {
        try {
            const r = win.get_frame_rect();
            return !r || r.width < MAIN_MIN_W || r.height < MAIN_MIN_H;
        } catch (e) {
            return true;
        }
    }

    // 找到当前微信"主窗口": 在微信窗口里取面积最大的那个
    // (登录小窗、子窗口都比主窗小, 取最大即可稳定命中主窗)
    _findWechatWindow() {
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
        let best = null;
        let bestArea = -1;
        for (const win of wins) {
            if (!this._isWechatWindow(win))
                continue;
            let area = 0;
            try {
                const r = win.get_frame_rect();
                area = (r && r.width > 0 && r.height > 0) ? r.width * r.height : 0;
            } catch (e) {}
            if (area > bestArea) {
                bestArea = area;
                best = win;
            }
        }
        return best;
    }

    // 位置 + 尺寸都要吻合(老版本只比 x/y: 位置一旦对上就收工,
    // 微信随后把尺寸改回去也不会被发现 —— 这是“窗口变小”的另一半原因)
    _matches(win, geo) {
        try {
            const r = win.get_frame_rect();
            return !!r &&
                Math.abs(r.x - geo.x) <= 2 && Math.abs(r.y - geo.y) <= 2 &&
                Math.abs(r.width - geo.width) <= 2 && Math.abs(r.height - geo.height) <= 2;
        } catch (e) {
            return false;
        }
    }

    // 读取记忆的窗口几何 "x,y,w,h"
    _geometry() {
        try {
            const s = this._settings ? this._settings.get_string('last-geometry') : '';
            if (!s)
                return null;
            const [x, y, w, h] = s.split(',').map(Number);
            if (![x, y, w, h].every(n => Number.isFinite(n)))
                return null;
            // 尺寸明显不像主窗口 → 判定为被小窗污染过的坏值, 清掉自愈(绝不用它去恢复)
            if (w < MAIN_MIN_W || h < MAIN_MIN_H) {
                log(`[wt] geometry 疑似被小窗污染(${w}x${h}), 已清除`);
                if (this._settings)
                    this._settings.set_string('last-geometry', '');
                return null;
            }
            return {x, y, width: w, height: h};
        } catch (e) {
            return null;
        }
    }

    // 收起/关闭前记录当前窗口几何(仅当坐标仍落在某块屏幕上, 防存到坏值)
    _rememberPosition(win) {
        try {
            // 关键防线: 登录/自动登录小窗也会走到这里(unmanaged),
            // 若不管尺寸就保存, 会把主窗口的记忆值污染成 280x380。
            if (this._isTooSmallToBeMain(win)) {
                log('[wt] remember SKIP: 窗口过小(登录/自动登录小窗), 不记忆');
                return;
            }
            const r = win.get_frame_rect();
            const desc = r ? `${r.x},${r.y} ${r.width}x${r.height}` : 'null';
            log(`[wt] remember frame=(${desc})`);
            if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y))
                return;
            const onScreen = (px, py) => {
                for (let i = 0; i < global.display.get_n_monitors(); i++) {
                    const m = global.display.get_monitor_geometry(i);
                    if (px >= m.x - 200 && px < m.x + m.width + 200 &&
                        py >= m.y - 200 && py < m.y + m.height + 200)
                        return true;
                }
                return false;
            };
            const ok = onScreen(r.x, r.y);
            log(`[wt] remember onScreen=${ok}`);
            if (ok) {
                const v = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
                this._settings.set_string('last-geometry', v);
                log(`[wt] remember SAVED ${v}`);
            }
        } catch (e) {
            log(`[wt] remember EXC ${e}`);
        }
    }

    // 新窗口出现: 目标是"把微信主窗口摆回上次的位置和尺寸"。
    // 与老实现的区别(就是登录后窗口变小/变别扭的原因):
    //   1) 不再一上来就对任意新窗口 move_resize —— 那会误伤 fcitx 候选框等,
    //      也会去掰微信那个不肯变大的登录小窗;
    //   2) 先等类名/标题就绪, 再确认是"主窗口尺寸", 才开始动手;
    //   3) 位置和尺寸都比对(老版本只比 x/y, 位置一对就收工, 微信随后改回
    //      自己的尺寸也不会被发现);
    //   4) 到位后不马上收工, 继续盯一段时间, 覆盖"登录完成后微信再自定尺寸"。
    _onWindowCreated(win) {
        const geo = this._geometry();
        if (!geo || !win)
            return;
        if (typeof win.is_destroyed === 'function' && win.is_destroyed())
            return;
        log(`[wt] created mapped=${win.mapped} ${win.get_wm_class() || ''}`);
        const place = () => {
            try {
                win.move_resize_frame(true, geo.x, geo.y, geo.width, geo.height);
            } catch (e) {}
        };
        const started = GLib.get_monotonic_time() / 1000;
        let settled = 0;
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            const stop = () => {
                this._timers.delete(id);
                return GLib.SOURCE_REMOVE;
            };
            const elapsed = GLib.get_monotonic_time() / 1000 - started;
            if (!win || (typeof win.is_destroyed === 'function' && win.is_destroyed()))
                return stop();
            // 元数据还没就绪(类名/标题都空) → 再等等; 一直空就放弃
            if (!win.get_wm_class() && !win.get_title())
                return elapsed < 1000 ? GLib.SOURCE_CONTINUE : stop();
            // 不是微信的窗口(fcitx 候选框等) → 绝不碰, 直接收工
            if (!this._isWechatWindow(win)) {
                log('[wt] created: 非微信窗口, 不干预');
                return stop();
            }
            // 微信的登录/自动登录小窗(280x380 那类) → 只观察不干预:
            // 硬掰它既掰不动, 还会在它关闭时把记忆值污染掉。
            if (this._isTooSmallToBeMain(win))
                return elapsed < ENFORCE_MS + 2000 ? GLib.SOURCE_CONTINUE : stop();

            // 到这里才是真正的主窗口: 挂“关闭”钩子 → Alt+s 收起或点 ✕ 都会记位置
            if (!win._wtHooked) {
                win._wtHooked = true;
                try {
                    win.connect('unmanaged', () => this._rememberPosition(win));
                    log('[wt] hooked unmanaged (main)');
                } catch (e) {
                    log(`[wt] hook EXC ${e}`);
                }
            }
            if (win.mapped) {
                if (!this._matches(win, geo)) {
                    // 位置或尺寸偏离 → 再摆一次(覆盖微信自己改尺寸的情况)
                    place();
                    settled = 0;
                } else if (++settled >= SETTLE_TICKS) {
                    log('[wt] created: 主窗已稳定到位');
                    return stop();
                }
            }
            return elapsed < ENFORCE_MS + 2000 ? GLib.SOURCE_CONTINUE : stop();
        });
        this._timers.add(id);
    }

    _onToggle() {
        const win = this._findWechatWindow();
        if (!win) {
            log('[wt] toggle: 无可见窗口 → 托盘呼出 / 启动');
            // 没有可见窗口: 收在托盘或未运行 → 进程内直接呼出或启动
            this._presentWechat().catch(e => log(`[wt] present 异常: ${e}`));
            return;
        }
        if (win.minimized) {
            log('[wt] toggle: minimized → activate');
            // 兼容旧行为: 若之前被最小化到任务栏, 直接唤回
            win.activate(global.get_current_time());
        } else {
            log('[wt] toggle: visible → remember+delete');
            // 显示中 → 先记位置, 再发"关闭窗口"请求; 微信把关闭当"最小化到系统托盘(企鹅)"
            this._rememberPosition(win);
            const time = global.get_current_time();
            if (typeof win.close === 'function')
                win.close(time);
            else if (typeof win.delete === 'function')
                win.delete(time);
        }
    }

    // ==================== 呼出 / 启动微信(等价于原来那个脚本) ====================

    // 会话总线调用, Promise 封装(避免回调金字塔)
    _dbusCall(busName, objectPath, iface, method, params) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                busName, objectPath, iface, method, params || null, null,
                Gio.DBusCallFlags.NONE, DBUS_TIMEOUT, null,
                (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    // 读 /proc/<pid>/comm: 等价于脚本里的 `pgrep -x wechat`
    _commOf(pid) {
        try {
            const [ok, data] = GLib.file_get_contents(`/proc/${pid}/comm`);
            if (!ok || !data)
                return '';
            return new TextDecoder().decode(data).trim().toLowerCase();
        } catch (e) {
            return '';
        }
    }

    // 找出"属于微信"的 SNI 总线名。
    // 必须验证属主: 托盘里还有别的应用, 挨个 Activate 会误触它们。
    // 用 GetConnectionUnixProcessID(总线守护进程提供, 对任意名字都可靠)拿属主 pid,
    // 再看该进程是不是 wechat —— 与 busctl list 里 `$2==pid` 的过滤等价。
    async _wechatSniNames() {
        const found = [];
        let reply;
        try {
            reply = await this._dbusCall(DBUS_DEST, DBUS_PATH, DBUS_IFACE, 'ListNames', null);
        } catch (e) {
            log(`[wt] ListNames 失败: ${e}`);
            return found;
        }
        const [names] = reply.deepUnpack();
        for (const name of names) {
            if (!name.startsWith(SNI_PREFIX))
                continue;
            try {
                const r = await this._dbusCall(DBUS_DEST, DBUS_PATH, DBUS_IFACE,
                    'GetConnectionUnixProcessID', new GLib.Variant('(s)', [name]));
                const [pid] = r.deepUnpack();
                const comm = this._commOf(pid);
                if (comm === WECHAT_COMM) {
                    found.push(name);
                } else {
                    log(`[wt] 跳过非微信托盘项 ${name} (pid=${pid} comm=${comm})`);
                }
            } catch (e) {
                // 拿不到属主信息就不碰它
            }
        }
        return found;
    }

    // 触发托盘单击(呼出窗口)。成功返回 true。
    async _activateWechatSNI() {
        for (const name of await this._wechatSniNames()) {
            try {
                await this._dbusCall(name, SNI_PATH, SNI_IFACE, 'Activate',
                    new GLib.Variant('(ii)', [0, 0]));
                log(`[wt] SNI Activate 成功 (${name})`);
                return true;
            } catch (e) {
                log(`[wt] SNI Activate 失败 (${name}): ${e}`);
            }
        }
        return false;
    }

    // 可被 disable() 打断的 sleep(定时器统一登记在 this._timers 里)
    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timers.delete(id);
                this._sleepers.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.add(id);
            this._sleepers.set(id, resolve);
        });
    }

    // 呼出微信: 在托盘里就直接 Activate; 没在跑就启动, 等 SNI 注册好再 Activate。
    // (与脚本流程一一对应, 只是不再派生外部进程)
    async _presentWechat() {
        if (this._presenting)
            return;                     // 连按 Alt+s 不叠加
        this._presenting = true;
        try {
            if (await this._activateWechatSNI())
                return;                 // 已在托盘 → 已呼出
            log(`[wt] 未发现微信托盘 SNI → 启动/唤起 ${WECHAT_BIN}`);
            try {
                // 已在运行时: 微信是单实例, 再启一次会唤起已有实例(脚本同款兜底)
                GLib.spawn_command_line_async(WECHAT_BIN);
            } catch (e) {
                log(`[wt] 启动微信失败: ${e}`);
            }
            for (let i = 0; i < SNI_WAIT_TRIES; i++) {
                await this._sleep(SNI_WAIT_MS);
                if (!this._settings)    // 扩展已禁用 → 放弃
                    return;
                if (await this._activateWechatSNI()) {
                    log('[wt] 启动后呼出成功');
                    return;
                }
            }
            log('[wt] 等待微信托盘 SNI 超时(约 10s)');
        } catch (e) {
            log(`[wt] present 异常: ${e}`);
        } finally {
            this._presenting = false;
        }
    }
}
