// SPDX-License-Identifier: GPL-2.0-or-later
//
// Preferences for WeChat Window Toggle: the global shortcut, where to find WeChat, and a
// debug switch for troubleshooting.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/* Same fallbacks as the extension itself. */
const WECHAT_PATHS = ['/usr/bin/wechat', '/usr/local/bin/wechat', '/opt/wechat/wechat'];

/* Keys that are not a usable shortcut on their own. */
const MODIFIER_KEYS = new Set([
    Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock, Gdk.KEY_ISO_Level3_Shift,
]);

/* Keyboard layout independent name, e.g. "<Alt>s". */
function acceleratorName(keyval, keycode, mask) {
    try {
        return Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
    } catch (e) {
        return Gtk.accelerator_name(keyval, mask);
    }
}

function detectWechat() {
    const inPath = GLib.find_program_in_path('wechat');
    if (inPath)
        return inPath;

    for (const path of WECHAT_PATHS) {
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }

    return null;
}

/* Modal window that grabs one key combination and emits it as an accelerator string. */
const ShortcutDialog = GObject.registerClass({
    GTypeName: 'WeChatToggleShortcutDialog',
    Signals: {
        'captured': {param_types: [GObject.TYPE_STRING]},
    },
}, class ShortcutDialog extends Gtk.Window {
    _init(parent) {
        super._init({
            title: 'New shortcut',
            transient_for: parent,
            modal: true,
            resizable: false,
            hide_on_close: true,
            default_width: 380,
        });

        this.set_focusable(true);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 18,
            margin_end: 18,
        });
        box.append(new Gtk.Label({
            label: 'Press the key combination to use.\nPress Esc to cancel.',
            justify: Gtk.Justification.CENTER,
        }));

        this._preview = new Gtk.ShortcutLabel({
            disabled_text: 'Waiting for a shortcut…',
            halign: Gtk.Align.CENTER,
        });
        box.append(this._preview);
        this.set_child(box);

        const controller = new Gtk.EventControllerKey();
        controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        controller.connect('key-pressed',
            (_controller, keyval, keycode, state) => this._onKeyPressed(keyval, keycode, state));
        this.add_controller(controller);
    }

    _onKeyPressed(keyval, keycode, state) {
        const mask = state & Gtk.accelerator_get_default_mod_mask();

        if (keyval === Gdk.KEY_Escape && mask === 0) {
            this.destroy();
            return Gdk.EVENT_STOP;
        }

        /* Show modifiers while they are held down, but wait for a real key. */
        if (MODIFIER_KEYS.has(keyval)) {
            this._preview.set_accelerator(Gtk.accelerator_name(keyval, mask) ?? '');
            return Gdk.EVENT_STOP;
        }

        /* A combination without a modifier would take a plain key away from every
           application, so it is not accepted. */
        if (mask === 0)
            return Gdk.EVENT_STOP;

        this.emit('captured', acceleratorName(keyval, keycode, mask));
        this.destroy();
        return Gdk.EVENT_STOP;
    }
});

export default class WeChatTogglePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.search_enabled = false;

        const page = new Adw.PreferencesPage();
        page.add(this._shortcutGroup(window, settings));
        page.add(this._wechatGroup(settings));
        page.add(this._advancedGroup(settings));
        window.add(page);
    }

    _shortcutGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Shortcut',
            description: 'The shortcut only acts on the WeChat main window.',
        });

        const row = new Adw.ActionRow({title: 'Toggle WeChat'});
        const label = new Gtk.ShortcutLabel({valign: Gtk.Align.CENTER});

        const refresh = () => {
            const [accelerator] = settings.get_strv('toggle-wechat');
            label.set_accelerator(accelerator || '');
            row.subtitle = accelerator ? '' : 'No shortcut set';
        };
        refresh();

        const setButton = new Gtk.Button({label: 'Set…', valign: Gtk.Align.CENTER});
        setButton.connect('clicked', () => {
            const dialog = new ShortcutDialog(window);
            dialog.connect('captured', (_dialog, accelerator) => {
                settings.set_strv('toggle-wechat', [accelerator]);
                refresh();
            });
            dialog.present();
        });

        const resetButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Reset to the default shortcut',
        });
        resetButton.add_css_class('flat');
        resetButton.connect('clicked', () => {
            settings.reset('toggle-wechat');
            refresh();
        });

        row.add_suffix(label);
        row.add_suffix(setButton);
        row.add_suffix(resetButton);
        row.activatable_widget = setButton;
        group.add(row);

        return group;
    }

    _wechatGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'WeChat'});

        const pathRow = new Adw.EntryRow({
            title: 'Executable',
            show_apply_button: true,
            text: settings.get_string('wechat-path'),
        });
        pathRow.connect('apply', () => settings.set_string('wechat-path', pathRow.text.trim()));
        group.add(pathRow);

        const detected = detectWechat();
        group.add(new Adw.ActionRow({
            title: 'Detected automatically',
            subtitle: detected ?? 'Not found in PATH or in the usual locations',
        }));

        return group;
    }

    _advancedGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Advanced'});

        const debugRow = new Adw.SwitchRow({
            title: 'Debug logging',
            subtitle: 'Write window and tray activity to the system log.',
        });
        settings.bind('debug', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(debugRow);

        const forgetRow = new Adw.ActionRow({
            title: 'Forget window geometry',
            subtitle: 'The window keeps the position WeChat gives it until it is hidden again.',
        });
        const forgetButton = new Gtk.Button({label: 'Forget', valign: Gtk.Align.CENTER});
        forgetButton.connect('clicked', () => settings.set_string('last-geometry', ''));
        forgetRow.add_suffix(forgetButton);
        forgetRow.activatable_widget = forgetButton;
        group.add(forgetRow);

        return group;
    }
}
