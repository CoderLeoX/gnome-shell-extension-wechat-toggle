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

/* Tried in order when the executable is neither configured nor found in PATH. */
const WECHAT_PATHS = ['/usr/bin/wechat', '/usr/local/bin/wechat', '/opt/wechat/wechat'];

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
   restored too early, so the geometry is enforced for a while after the window shows
   up and the polling stops early once position and size have been stable. */
const ENFORCE_MS = 3000;
const SETTLE_TICKS = 12;
const TICK_MS = 60;

/* 20 x 500ms budget for a freshly started WeChat to publish its tray icon. */
const SNI_WAIT_TRIES = 20;
const SNI_WAIT_MS = 500;

export default class WeChatToggleExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        /* Main loop sources and signal handlers created at runtime, all of them tracked
           so that disable() can get rid of them. */
        this._timers = new Set();
        this._sleepers = new Map();
        this._windowHandlers = new Map();
        this._presenting = false;

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

        /* Resolve waits first; the code behind them returns once _settings is null. */
        for (const resolve of this._sleepers.values())
            resolve();
        this._sleepers.clear();

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
        this._settings = null;
    }

    /* Nothing reaches the journal unless debug logging is switched on in the
       preferences, which keeps the log readable for everyone else. */
    _log(message) {
        if (this._settings && this._settings.get_boolean('debug'))
            log(`[wechat-toggle] ${message}`);
    }

    /* ------ WeChat window helpers ------ */

    /* Matches any window belonging to WeChat, including the small login window. Code
       that needs the real main window has to check the size as well. */
    _isWechatWindow(win) {
        if (!win)
            return false;

        if (typeof win.is_attached_dialog === 'function' && win.is_attached_dialog())
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

    /* Stores the current geometry, unless the window is not the main window. Without the
       size check the login window would overwrite the stored geometry with its own. */
    _rememberGeometry(win) {
        try {
            if (this._isTooSmallForMain(win)) {
                this._log('not storing geometry: window is too small to be the main window');
                return;
            }

            const rect = win.get_frame_rect();
            if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y))
                return;

            if (!this._isOnScreen(rect.x, rect.y)) {
                this._log(`not storing geometry: (${rect.x},${rect.y}) is off screen`);
                return;
            }

            const value = `${Math.round(rect.x)},${Math.round(rect.y)},` +
                `${Math.round(rect.width)},${Math.round(rect.height)}`;
            this._settings.set_string('last-geometry', value);
            this._log(`stored geometry ${value}`);
        } catch (e) {
            this._log(`could not store geometry: ${e}`);
        }
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
        if (!target || !win || (typeof win.is_destroyed === 'function' && win.is_destroyed()))
            return;

        this._log(`window created (mapped=${win.mapped}, class=${win.get_wm_class() || '-'})`);

        const startedAt = GLib.get_monotonic_time() / 1000;
        let settledTicks = 0;
        let sourceId = 0;

        const stop = () => {
            this._timers.delete(sourceId);
            return GLib.SOURCE_REMOVE;
        };

        const apply = () => {
            try {
                win.move_resize_frame(true, target.x, target.y, target.width, target.height);
            } catch (e) {
                this._log(`move_resize_frame failed: ${e}`);
            }
        };

        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            const elapsed = GLib.get_monotonic_time() / 1000 - startedAt;

            if (!win || (typeof win.is_destroyed === 'function' && win.is_destroyed()))
                return stop();

            /* WM class and title are still empty right after creation. */
            if (!win.get_wm_class() && !win.get_title())
                return elapsed < 1000 ? GLib.SOURCE_CONTINUE : stop();

            /* Not our window (input method candidates, notifications, ...). */
            if (!this._isWechatWindow(win))
                return stop();

            if (this._isTooSmallForMain(win))
                return elapsed < ENFORCE_MS + 2000 ? GLib.SOURCE_CONTINUE : stop();

            /* The real main window: remember where it was when it goes away. */
            if (!this._windowHandlers.has(win)) {
                const handlerId = win.connect('unmanaged', () => this._rememberGeometry(win));
                this._windowHandlers.set(win, handlerId);
            }

            if (win.mapped) {
                if (!this._matchesTarget(win, target)) {
                    apply();
                    settledTicks = 0;
                } else if (++settledTicks >= SETTLE_TICKS) {
                    this._log('main window is in place');
                    return stop();
                }
            }

            return elapsed < ENFORCE_MS + 2000 ? GLib.SOURCE_CONTINUE : stop();
        });

        this._timers.add(sourceId);
    }

    /* ------ Toggle ------ */

    _onToggle() {
        const win = this._findWechatWindow();

        if (!win) {
            this._log('toggle: no window, showing WeChat');
            this._showWechat().catch(e => this._log(`showing WeChat failed: ${e}`));
            return;
        }

        if (win.minimized) {
            this._log('toggle: minimized, activating');
            win.activate(global.get_current_time());
            return;
        }

        this._log('toggle: visible, hiding');
        this._rememberGeometry(win);

        /* WeChat treats a close request as "minimize to tray". The method was renamed in
           GNOME 50 (close -> delete), so both are tried. */
        const time = global.get_current_time();
        if (typeof win.close === 'function')
            win.close(time);
        else if (typeof win.delete === 'function')
            win.delete(time);
    }

    /* ------ Showing / starting WeChat ------ */

    /* Path of the WeChat executable: the configured one, then PATH, then the known
       locations. Returns null when WeChat is not installed. */
    _wechatBinary() {
        const configured = this._settings.get_string('wechat-path').trim();
        if (configured)
            return configured;

        const inPath = GLib.find_program_in_path('wechat');
        if (inPath)
            return inPath;

        for (const path of WECHAT_PATHS) {
            if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
                return path;
        }

        return null;
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
                    items.push(name);
            } catch (e) {
                /* Without owner information the item is left alone. */
            }
        }

        return items;
    }

    /* Clicks WeChat's tray icon. Returns true when the request was delivered. */
    async _activateTrayItem() {
        for (const name of await this._wechatTrayItems()) {
            try {
                await this._dbusCall(name, SNI_PATH, SNI_IFACE, 'Activate',
                    new GLib.Variant('(ii)', [0, 0]));
                this._log(`tray item activated (${name})`);
                return true;
            } catch (e) {
                this._log(`activating ${name} failed: ${e}`);
            }
        }

        return false;
    }

    /* Sleep that disable() can interrupt; both the source and the resolver are tracked. */
    _sleep(ms) {
        return new Promise(resolve => {
            const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timers.delete(sourceId);
                this._sleepers.delete(sourceId);
                resolve();
                return GLib.SOURCE_REMOVE;
            });

            this._timers.add(sourceId);
            this._sleepers.set(sourceId, resolve);
        });
    }

    /* Shows WeChat: activate the tray icon if it is running, otherwise start it and wait
       for the icon to appear. */
    async _showWechat() {
        if (this._presenting)
            return;

        this._presenting = true;
        try {
            if (await this._activateTrayItem())
                return;

            const binary = this._wechatBinary();
            if (!binary) {
                this._log('WeChat executable not found');
                Main.notify('WeChat Window Toggle',
                    'The WeChat executable could not be found. Set its path in the extension preferences.');
                return;
            }

            this._log(`no tray icon yet, starting ${binary}`);
            try {
                /* WeChat is single instance, so starting it again also wakes up an
                   instance that is running but has not published its tray icon yet. */
                GLib.spawn_command_line_async(binary);
            } catch (e) {
                this._log(`starting WeChat failed: ${e}`);
                Main.notify('WeChat Window Toggle', `Could not start WeChat: ${e.message}`);
                return;
            }

            for (let attempt = 0; attempt < SNI_WAIT_TRIES; attempt++) {
                await this._sleep(SNI_WAIT_MS);

                if (!this._settings)
                    return;

                if (await this._activateTrayItem())
                    return;
            }

            this._log('timed out waiting for the WeChat tray icon');
        } finally {
            this._presenting = false;
        }
    }
}
