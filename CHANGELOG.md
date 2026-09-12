# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-09-11

### Fixed

- The remembered geometry stopped following the window: the value stored when a window
  disappeared came from a cache that was only filled while that window was being placed, so
  once that was over, moving the window changed nothing. The geometry is read from the
  window when it goes away instead.
- The geometry was never restored and the window stayed centred: the maximized check called
  `get_maximized()`, which `Meta.Window` does not expose in the GJS bindings, and the
  resulting TypeError removed the polling source before anything was applied. Maximized
  state is now read from the `maximized_horizontally` / `maximized_vertically` properties.
- Resizing a window that WeChat had already withdrawn from the window stack crashed GNOME
  Shell (SIGSEGV) and ended the session. Windows are no longer touched once they are
  unmanaged, and the polling stops the moment that happens.
- A window that was maximized while hidden came back maximized: the stored geometry was the
  whole work area, and resizing a window to exactly that size is how Mutter decides it should
  be maximized. Maximized and fullscreen windows are no longer used as the source for the
  stored geometry, and they are left alone when the window appears.

### Changed

- The extension no longer starts WeChat. With no tray icon the shortcut does nothing at
  all: starting a chat client behind the user's back is more than the extension should do,
  and a WeChat that is not running has no window to show. The executable setting and its
  auto-detection were removed along with it.
- The window is placed as soon as the Shell maps it, so it no longer shows up in the middle
  of the screen and jumps to the remembered position a moment later. A geometry set before
  the client's first commit does not survive that commit, and WeChat only sets the WM class
  afterwards, so a window that appears right after its tray icon was clicked is recognised
  by the process id that owns that icon.
- Only windows that turn out to belong to WeChat are logged, so enabling debug logging no
  longer fills the journal with input method candidate windows.
- The geometry is applied with a non-interactive resize, so window tiling extensions no
  longer read it as a user action and snap the window to one of their tiles.
- The number of resize attempts is capped and the polling interval is longer.

## [1.0.0] - 2026-09-11

First public release.

### Added

- Preferences window: shortcut, WeChat executable path, debug logging and a button to
  forget the remembered window geometry.
- The WeChat executable is looked up in `PATH` and in the usual install locations when no
  path is configured, and a notification is shown when it cannot be found.
- Debug logging is off by default and can be enabled in the preferences.

### Changed

- Showing and starting WeChat moved into the extension: the tray icon is activated over
  the session bus (`org.kde.StatusNotifierItem.Activate`) instead of running an external
  script, so there are no runtime dependencies besides GNOME Shell itself.
- Extension uuid changed to `wechat-toggle@coderleox.github.io`.
- Comments and settings descriptions are in English.

### Removed

- `toggle-wechat.sh`. The extension no longer needs a shell script, `busctl` or `pgrep`.

## [0.2.0] - 2026-09-11

### Fixed

- The main window no longer shrinks to the size of WeChat's login window. The login
  window shares its WM class and title with the main window but is much smaller; its
  geometry used to be stored when it closed, and the main window was then restored to
  that size. Windows below a minimum size are now ignored.
- Window geometry is compared including the size, and is enforced for a few seconds after
  the window appears, because WeChat sets its own size once login finishes.

## [0.1.0] - 2026-09-06

### Added

- Initial version: global shortcut to show/hide the WeChat main window, geometry stored
  in GSettings, tray icon activated through `busctl`.
