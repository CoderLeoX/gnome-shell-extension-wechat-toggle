import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// 呼出/启动交给这个脚本: 内部用 busctl 调微信托盘 SNI Activate 呼出主窗口;
// 微信没在运行则启动它。该命令已命令行实测可靠(比在扩展里手工解析 DBus 更稳)。
const TOGGLE_SCRIPT = '/home/ly/bin/desktop/toggle-wechat.sh';

export default class WechatToggleExtension extends Extension {
    enable() {
        // GNOME 50: getSettings() 需要显式传 schema id(不再从 uuid 自动推导)
        this._settings = this.getSettings('org.gnome.shell.extensions.wechat-toggle');
        this._timers = new Set();
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
        if (this._timers) {
            for (const id of this._timers) {
                try { GLib.source_remove(id); } catch (e) {}
            }
            this._timers.clear();
        }
        this._settings = null;
    }

    // 判断某窗口是否为微信"主窗口"(排除 WeChatAppEx / 子对话框)
    _isWechatMainWindow(win) {
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

    // 找到当前微信"主窗口"
    _findWechatWindow() {
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
        for (const win of wins) {
            if (this._isWechatMainWindow(win))
                return win;
        }
        return null;
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
            return {x, y, width: w, height: h};
        } catch (e) {
            return null;
        }
    }

    // 收起/关闭前记录当前窗口几何(仅当坐标仍落在某块屏幕上, 防存到坏值)
    _rememberPosition(win) {
        try {
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

    // 新窗口出现: 若是微信主窗且记录了位置, 尽量在它显示(mapped)之前先放好位置,
    // 避免"先居中显示再跳过去"的闪烁; map 后仍以极短间隔纠正, 把居中可见压到最短。
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
        // 1) 立即放置一次: 若尚未 map, 决定首帧几何(零闪); 若已 map, 则作第一次纠正
        place();
        // 2) 极短间隔密集纠正, 覆盖 map 前后, 让居中可见时间尽量短
        let tries = 0;
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4, () => {
            tries++;
            const gone = !win || tries > 60 ||
                (typeof win.is_destroyed === 'function' && win.is_destroyed());
            if (gone) {
                this._timers.delete(id);
                return GLib.SOURCE_REMOVE;
            }
            if (this._isWechatMainWindow(win)) {
                // 主窗创建成功: 挂上“窗口被关闭”钩子 → 无论 Alt+s 还是点 ✕ 都记录位置
                if (!win._wtHooked) {
                    win._wtHooked = true;
                    try {
                        win.connect('unmanaged', () => this._rememberPosition(win));
                        log('[wt] hooked unmanaged');
                    } catch (e) {
                        log(`[wt] hook EXC ${e}`);
                    }
                }
                // 若几何仍偏离目标则再放一次(快速收敛)
                let near = false;
                try {
                    const r = win.get_frame_rect();
                    near = r && Math.abs(r.x - geo.x) <= 2 && Math.abs(r.y - geo.y) <= 2;
                    if (!near)
                        place();
                } catch (e) {}
                // 已映射且已到位 → 完成
                const m = win.mapped === undefined ? true : win.mapped;
                if (m && near) {
                    this._timers.delete(id);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            }
            // 元数据尚未就绪(标题/类还空)则继续等; 否则是别的窗口, 放弃
            if (!win.get_wm_class() && !win.get_title())
                return GLib.SOURCE_CONTINUE;
            this._timers.delete(id);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    _onToggle() {
        const win = this._findWechatWindow();
        if (!win) {
            log('[wt] toggle: no-window → script');
            // 没有可见窗口: 收在托盘或未运行 → 交给脚本(托盘则呼出, 没运行则启动)
            GLib.spawn_command_line_async(TOGGLE_SCRIPT);
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
}
