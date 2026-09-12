// SPDX-License-Identifier: GPL-2.0-or-later
//
// WeChat Window Toggle
//
// Toggles the WeChat for Linux main window between visible and tray with a global
// shortcut, and puts the window back where it was when it is shown again.
//
// Why the implementation looks like this:
//
//  * WeChat 4.x draws its own window and it is a native Wayland window, so X11 tools
//    (xdotool, wmctrl, xprop) can neither see nor control it. Moving, resizing and
//    closing it is only possible from inside the compositor, which is what this
//    extension does.
//
//  * Closing the window is how WeChat minimizes itself to the tray, so hiding is just a
//    close request. Showing it again is the same as clicking the tray icon, which can be
//    replayed by calling Activate() on WeChat's StatusNotifierItem over the session bus.
//    There is no DBus method to hide it again, hence the asymmetry.
//
//  * WeChat does not remember where its window was, so the geometry is kept in GSettings
//    and applied again whenever the window is recreated.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/* StatusNotifierItem (system tray) conventions. WeChat exports a bus name of the form
   org.kde.StatusNotifierItem-<pid>-<n>, with the item on /StatusNotifierItem. */
const SNI_PREFIX = 'org.kde.StatusNotifierItem-';
const SNI_PATH = '/StatusNotifierItem';
const SNI_IFACE = 'org.kde.StatusNotifierItem';

/* Used to check that an SNI item really belongs to WeChat before activating it; other
   applications publish their icons on the same bus. */
const WECHAT_COMM = 'wechat';

const DBUS_DEST = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const DBUS_TIMEOUT_MS = 3000;

/* Before the main window, WeChat shows a small login/auto-login window (280x380 in
   practice). It uses the same WM class and title as the main window, so its size is the
   only usable difference. This matters because the login window is closed as soon as
   login finishes: if its geometry is remembered, the main window is restored to that
   tiny size a moment later. Windows smaller than this are therefore left alone. */
const MAIN_MIN_W = 500;
const MAIN_MIN_H = 400;

/* WeChat applies its own size once login completes, which would override a geometry
   restored too early, so the geometry is enforced for a while after the window shows up.
   The polling stops as soon as position and size are stable, and the number of resizes is
   capped so that a window which refuses to move is not hammered. */
const ENFORCE_MS = 3000;
const SETTLE_TICKS = 6;
const TICK_MS = 100;
const MAX_APPLIES = 12;

/* WeChat creates its window before it sets the WM class, so a window that appears right
   after its tray icon was clicked is identified by its pid instead. Placing it while it is
   still unmapped is what keeps it from visibly jumping from the position the Shell picks
   to the remembered one. */
const EXPECT_MS = 2000;

export default class WeChatToggleExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        /* Main loop sources and signal handlers created at runtime, all of them tracked
           so that disable() can get rid of them. */
        this._timers = new Set();
        this._windowHandlers = new Map();
        this._presenting = false;
        /* Pid of the process whose window is expected next, and until when. */
        this._expectedPid = 0;
        this._expectedUntil = 0;

        Main.wm.addKeybinding(
            'toggle-wechat',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._onToggle());

        this._winCreatedId = global.display.connect(
            'window-created', (_display, win) => this._onWindowCreated(win));
    }

    disable() {
        Main.wm.removeKeybinding('toggle-wechat');

        if (this._winCreatedId) {
            global.display.disconnect(this._winCreatedId);
            this._winCreatedId = 0;
        }

        for (const sourceId of this._timers)
            GLib.source_remove(sourceId);
        this._timers.clear();

        /* 'unmanaged' is connected to Meta.Window objects, which outlive the extension,
           so those handlers have to be disconnected explicitly. */
        for (const [win, handlerId] of this._windowHandlers) {
            try {
                win.disconnect(handlerId);
            } catch (e) {
                /* The window is already gone, there is nothing to disconnect. */
            }
        }
        this._windowHandlers.clear();

        this._presenting = false;
        this._expectedPid = 0;
        this._settings = null;
    }

    /* Nothing reaches the journal unless debug logging is switched on in the
       preferences, which keeps the log readable for everyone else. */
    _log(message) {
        if (this._settings && this._settings.get_boolean('debug'))
            log(`[wechat-toggle] ${message}`);
    }

    /* ------ WeChat window helpers ------ */

    _isAttachedDialog(win) {
        return typeof win.is_attached_dialog === 'function' && win.is_attached_dialog();
    }

    /* Matches any window belonging to WeChat, including the small login window. Code
       that needs the real main window has to check the size as well. */
    _isWechatWindow(win) {
        if (!win || this._isAttachedDialog(win))
            return false;

        const wmClass = (win.get_wm_class() || '').toLowerCase();
        if (wmClass.includes('wechat') && !wmClass.includes('appex'))
            return true;

        /* The Login window title is localized, the main window title is not. Checking the
           name is a fallback for sessions where the WM class is not set yet. */
        return (win.get_title() || '').startsWith('微信');
    }

    /* True for windows that are too small to be the main window, i.e. the login window
       and the other small helper windows WeChat creates while starting up. */
    _isTooSmallForMain(win) {
        try {
            const rect = win.get_frame_rect();
            return !rect || rect.width < MAIN_MIN_W || rect.height < MAIN_MIN_H;
        } catch (e) {
            return true;
        }
    }

    /* The main window is the largest WeChat window; login and helper windows are smaller
       versions of it. */
    _findWechatWindow() {
        let best = null;
        let bestArea = -1;

        for (const win of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)) {
            if (!this._isWechatWindow(win))
                continue;

            let area = 0;
            try {
                const rect = win.get_frame_rect();
                area = rect ? rect.width * rect.height : 0;
            } catch (e) {
                area = 0;
            }

            if (area > bestArea) {
                bestArea = area;
                best = win;
            }
        }

        return best;
    }

    /* Both position and size have to match. Comparing only the position is not enough:
       the window ends up at the right place with the wrong size, which is exactly what
       WeChat does after login. */
    _matchesTarget(win, target) {
        try {
            const rect = win.get_frame_rect();
            return !!rect &&
                Math.abs(rect.x - target.x) <= 2 &&
                Math.abs(rect.y - target.y) <= 2 &&
                Math.abs(rect.width - target.width) <= 2 &&
                Math.abs(rect.height - target.height) <= 2;
        } catch (e) {
            return false;
        }
    }

    /* ------ Remembered geometry ------ */

    _geometry() {
        try {
            const stored = this._settings ? this._settings.get_string('last-geometry') : '';
            if (!stored)
                return null;

            const [x, y, width, height] = stored.split(',').map(Number);
            if (![x, y, width, height].every(Number.isFinite))
                return null;

            /* A size that cannot be the main window is a leftover from an older version
               that stored the login window geometry; drop it instead of using it. */
            if (width < MAIN_MIN_W || height < MAIN_MIN_H) {
                this._log(`discarding implausible stored geometry ${width}x${height}`);
                if (this._settings)
                    this._settings.set_string('last-geometry', '');
                return null;
            }

            return {x, y, width, height};
        } catch (e) {
            return null;
        }
    }

    /* Maximized state is read through these two properties: Meta.Window has no
       get_maximized() method in the GJS bindings, and calling it threw a TypeError that
       removed the polling source, so the window was never moved and stayed centred. */
    _isMaximized(win) {
        try {
            return !!win.maximized_horizontally || !!win.maximized_vertically ||
                !!win.fullscreen;
        } catch (e) {
            return false;
        }
    }

    /* Frame rect that is safe to restore later, or null when the window is a bad source:
       too small to be the main window (the login window), or maximized, because its rect
       is then the whole work area and restoring that size makes the window come back
       maximized. */
    _safeRect(win) {
        try {
            if (this._isTooSmallForMain(win))
                return null;

            if (this._isMaximized(win))
                return null;

            const rect = win.get_frame_rect();
            if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
                !Number.isFinite(rect.width) || !Number.isFinite(rect.height))
                return null;

            return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
        } catch (e) {
            return null;
        }
    }

    _storeRect(rect) {
        if (!rect)
            return;

        if (!this._isOnScreen(rect.x, rect.y)) {
            this._log(`not storing geometry: (${rect.x},${rect.y}) is off screen`);
            return;
        }

        const value = `${Math.round(rect.x)},${Math.round(rect.y)},` +
            `${Math.round(rect.width)},${Math.round(rect.height)}`;
        this._settings.set_string('last-geometry', value);
        this._log(`stored geometry ${value}`);
    }

    _isOnScreen(x, y) {
        for (let i = 0; i < global.display.get_n_monitors(); i++) {
            const monitor = global.display.get_monitor_geometry(i);
            if (x >= monitor.x - 200 && x < monitor.x + monitor.width + 200 &&
                y >= monitor.y - 200 && y < monitor.y + monitor.height + 200)
                return true;
        }
        return false;
    }

    /* ------ Restoring the window on creation ------ */

    /* WeChat recreates its window every time it is shown, so this is where the stored
       geometry is applied. Small windows are only watched: they are the login window,
       they cannot be resized, and touching them is what caused the main window to shrink
       in the first place. */
    _onWindowCreated(win) {
        const target = this._geometry();
        if (!target || !win)
            return;

        const pid = this._pidOf(win);

        /* WeChat creates the window and only then sets its WM class, while the Shell shows
           it right away at a position of its own. A window created just after WeChat's tray
           icon was clicked is therefore placed before it becomes visible, which is what
           removes the jump from the middle of the screen to the remembered position. */
        if (this._isExpectedWindow(pid) && !this._isAttachedDialog(win) &&
            !this._isTooSmallForMain(win)) {
            this._log(`placing the window of pid ${pid} before it is shown`);
            this._applyGeometry(win, target);
        }

        const startedAt = GLib.get_monotonic_time() / 1000;
        const state = {sourceId: 0, handlerId: 0, applies: 0, unmanaged: false, rect: null};
        let settledTicks = 0;

        const stop = () => {
            if (state.sourceId) {
                this._timers.delete(state.sourceId);
                state.sourceId = 0;
            }
            return GLib.SOURCE_REMOVE;
        };

        state.sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            const elapsed = GLib.get_monotonic_time() / 1000 - startedAt;

            if (state.unmanaged || !win)
                return stop();

            /* The pid gives the window away before WeChat sets the class; afterwards the
               class identifies windows that show up for other reasons. */
            if (!this._isExpectedWindow(pid) && !this._isWechatWindow(win)) {
                /* A fresh window has no class or title yet, give it a moment. */
                if (!win.get_wm_class() && !win.get_title())
                    return elapsed < 1000 ? GLib.SOURCE_CONTINUE : stop();
                return stop();
            }

            if (this._isTooSmallForMain(win))
                return elapsed < ENFORCE_MS ? GLib.SOURCE_CONTINUE : stop();

            this._log(`tracking window (mapped=${win.mapped}, class=${win.get_wm_class() || '-'})`);

            /* The window is about to be touched, so make sure it stops being touched the
               moment it leaves the window stack. WeChat destroys and recreates its window
               whenever it is hidden or shown, and resizing a window that is already
               unmanaged takes the whole Shell down with it (SIGSEGV), which ends the
               session. Hence the flag, which is checked before every operation. */
            if (!state.handlerId) {
                state.handlerId = win.connect('unmanaged', () => {
                    state.unmanaged = true;
                    this._windowHandlers.delete(win);
                    this._storeRect(state.rect);
                    stop();
                });
                this._windowHandlers.set(win, state.handlerId);
            }

            /* Keep the last usable geometry around: it is stored when the window goes away
               even if it is closed without the shortcut. */
            const rect = this._safeRect(win);
            if (rect)
                state.rect = rect;

            /* A maximized or fullscreen window is left alone: its rect is the work area,
               and applying that size is what made the window come back maximized. */
            if (this._isMaximized(win)) {
                this._log('window is maximized, not touching the geometry');
                return stop();
            }

            if (!win.mapped)
                return elapsed < ENFORCE_MS ? GLib.SOURCE_CONTINUE : stop();

            if (!this._matchesTarget(win, target)) {
                if (++state.applies > MAX_APPLIES) {
                    this._log('giving up on the window geometry');
                    return stop();
                }
                this._applyGeometry(win, target);
                settledTicks = 0;
            } else if (++settledTicks >= SETTLE_TICKS) {
                this._log('main window is in place');
                return stop();
            }

            return elapsed < ENFORCE_MS ? GLib.SOURCE_CONTINUE : stop();
        });

        this._timers.add(state.sourceId);
    }

    /* ------ Toggle ------ */

    _onToggle() {
        const win = this._findWechatWindow();

        if (!win) {
            this._log('toggle: no window, clicking the tray icon');
            this._showWechat().catch(e => this._log(`showing WeChat failed: ${e}`));
            return;
        }

        if (win.minimized) {
            this._log('toggle: minimized, activating');
            win.activate(global.get_current_time());
            return;
        }

        this._log('toggle: visible, hiding');
        this._storeRect(this._safeRect(win));

        /* WeChat treats a close request as "minimize to tray". The method was renamed in
           GNOME 50 (close -> delete), so both are tried. */
        const time = global.get_current_time();
        if (typeof win.close === 'function')
            win.close(time);
        else if (typeof win.delete === 'function')
            win.delete(time);
    }

    /* ------ Showing WeChat ------ */

    /* Pid of the window, or 0 when the Shell cannot tell. */
    _pidOf(win) {
        try {
            const pid = win.get_pid();
            return Number.isFinite(pid) && pid > 0 ? pid : 0;
        } catch (e) {
            return 0;
        }
    }

    /* True while a window of the process whose tray icon was just clicked is expected.
       WeChat creates its window before setting the WM class, so this is the only moment at
       which that window can be recognised, and the only chance to place it before the Shell
       shows it somewhere else. */
    _isExpectedWindow(pid) {
        if (!pid || pid !== this._expectedPid)
            return false;
        return GLib.get_monotonic_time() / 1000 < this._expectedUntil;
    }

    _applyGeometry(win, target) {
        try {
            /* user_op is false on purpose: a resize that looks like a user action makes
               window tiling extensions snap the window to a tile of their layout. */
            win.move_resize_frame(false, target.x, target.y, target.width, target.height);
        } catch (e) {
            this._log(`move_resize_frame failed: ${e}`);
        }
    }

    /* Promise wrapper around a call on the session bus. */
    _dbusCall(busName, objectPath, iface, method, params) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                busName, objectPath, iface, method, params || null, null,
                Gio.DBusCallFlags.NONE, DBUS_TIMEOUT_MS, null,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /* /proc/<pid>/comm, used to tell which process owns a bus name. */
    _processName(pid) {
        try {
            const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/comm`);
            if (!ok || !contents)
                return '';
            return new TextDecoder().decode(contents).trim().toLowerCase();
        } catch (e) {
            return '';
        }
    }

    /* Bus names of the SNI items owned by WeChat. The owner has to be resolved because
       other applications register tray icons on the same bus; activating the wrong one
       would toggle an unrelated application. */
    async _wechatTrayItems() {
        const items = [];
        let reply;

        try {
            reply = await this._dbusCall(DBUS_DEST, DBUS_PATH, DBUS_IFACE, 'ListNames', null);
        } catch (e) {
            this._log(`ListNames failed: ${e}`);
            return items;
        }

        const [names] = reply.deepUnpack();
        for (const name of names) {
            if (!name.startsWith(SNI_PREFIX))
                continue;

            try {
                const ownerReply = await this._dbusCall(DBUS_DEST, DBUS_PATH, DBUS_IFACE,
                    'GetConnectionUnixProcessID', new GLib.Variant('(s)', [name]));
                const [pid] = ownerReply.deepUnpack();

                if (this._processName(pid) === WECHAT_COMM)
                    items.push({name, pid});
            } catch (e) {
                /* Without owner information the item is left alone. */
            }
        }

        return items;
    }

    /* Clicks WeChat's tray icon. Returns true when the request was delivered. */
    async _activateTrayItem() {
        for (const {name, pid} of await this._wechatTrayItems()) {
            try {
                await this._dbusCall(name, SNI_PATH, SNI_IFACE, 'Activate',
                    new GLib.Variant('(ii)', [0, 0]));
                this._log(`tray item activated (${name})`);

                /* WeChat is about to open its window: remember whose it will be so that it
                   can be put in place before it appears. */
                this._expectedPid = pid;
                this._expectedUntil = GLib.get_monotonic_time() / 1000 + EXPECT_MS;
                return true;
            } catch (e) {
                this._log(`activating ${name} failed: ${e}`);
            }
        }

        return false;
    }

    /* Shows WeChat by clicking its tray icon: WeChat publishes no method for showing the
       window, so the icon is the only way in.

       Nothing is started when there is no icon. Starting a chat client behind the user's
       back is more than this extension should do, and a WeChat that is not running has no
       window to show, so the shortcut does nothing at all in that case. The tray icon only
       exists while WeChat is running, which makes it the right thing to check. */
    async _showWechat() {
        if (this._presenting)
            return;

        this._presenting = true;
        try {
            if (await this._activateTrayItem())
                return;
            this._log('no WeChat tray icon, nothing to show');
        } catch (e) {
            this._log(`showing WeChat failed: ${e}`);
        } finally {
            this._presenting = false;
        }
    }
}
