# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
