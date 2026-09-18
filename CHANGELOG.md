# Changelog

## 0.2.1

- Desktop shortcut icons are now named for the action a click will take next,
  e.g. `Turn Fan On.lnk` / `Turn Fan Off.lnk` (previously `Fan On.lnk` /
  `Fan Off.lnk`), which was easy to misread as "the switch is currently on."
- Fixed the desktop icon jumping to a different position on the desktop every
  time it was toggled. The self-rename after a toggle now goes through the
  Shell.Application COM API instead of a raw filesystem rename, so Windows
  Explorer keeps treating it as the same icon.
- Fixed a bug (introduced while fixing the above) where a toggle could leave
  behind a broken, blank duplicate shortcut alongside the real one. The
  rename now verifies it landed at the expected path before the tooltip gets
  updated, instead of silently creating a new shortcut if it didn't.

## 0.2.0

- Initial public release: Stream Deck action to toggle TP-Link Kasa
  switches/plugs, plus Windows desktop shortcuts for the same switches.
