# Stream Deck Plugin for TP-Link Kasa Switches (+ Desktop Shortcuts)

**Version 0.2.0**

Turn TP-Link Kasa smart switches, plugs, and power-strip outlets on and off from an
Elgato Stream Deck key — plus optional Windows desktop icons/shortcuts that toggle
the same switches, no Stream Deck required.

Everything talks to your devices directly over the local network. There's no
cloud account, no TP-Link login, and no internet dependency — control keeps
working even if your internet is down, as long as the switch is on your LAN.

> [!WARNING]
> **Does not work with newer Kasa devices/firmware that use TP-Link's "KLAP"
> protocol.** This plugin only speaks Kasa's older, unencrypted local-control
> protocol (TCP port 9999). Some devices — notably KP303 hardware v2.0 after
> a firmware update — have been switched by TP-Link to KLAP and are
> **unsupported**: discovery won't find them, and a known IP will refuse the
> connection outright. See [Limitations](#limitations) for details; there is
> currently no workaround.

## What it does

- **One key, always accurate.** The key draws its own title and icon from the
  device's real, live state (name + ON/OFF, green/gray icon) every time it's
  shown — it's never just a static toggle that can drift out of sync with
  reality.
- **Stays in sync automatically.** If a switch is turned on or off some other
  way — the Kasa app, a physical button on the strip, or one of the desktop
  shortcuts below — the key updates itself within a few seconds, without you
  needing to flip pages or reopen anything.
- **Built-in LAN discovery.** No need to look up IP addresses yourself: the
  key's settings can scan your network and list the Kasa devices it finds.
- **Power-strip outlets, individually.** Multi-outlet strips (e.g. HS300,
  KP303) show a per-outlet picker, so one key can control just one outlet
  while another key controls a different outlet on the same strip.
- **Choose the action.** Each key can be set to toggle, always turn on, or
  always turn off — handy for e.g. a "shutdown" key that only ever turns
  things off.
- **Desktop shortcuts (Windows).** A companion command-line tool and script
  can generate ordinary desktop `.lnk` shortcuts that toggle a switch with a
  double-click — useful for a switch you want to reach without opening Stream
  Deck at all. Each shortcut renames itself to describe the *next* action
  (e.g. `Fan On` while it's off, flipping to `Fan Off` once it's on), so the
  desktop icon itself tells you the current state.

## Requirements

- Stream Deck app 6.5 or later (Windows 10+ or macOS 12+).
- A TP-Link Kasa switch, plug, or power strip on the same local network as
  your computer, using Kasa's classic local-control protocol on port 9999
  (see [Limitations](#limitations) below).
- [Node.js](https://nodejs.org/) 20 or later, to build the plugin from
  source — there's no pre-built package yet, so installing means building it
  yourself once.

## Install

1. Clone this repository somewhere permanent (don't delete it after
   installing — the plugin runs from this folder).
2. Install dependencies and build:
   ```
   npm install
   npm run build
   ```
3. Link the plugin into Stream Deck and start it:
   ```
   npx streamdeck link com.caffecter.kasa.sdPlugin
   npx streamdeck restart com.caffecter.kasa
   ```
4. Open the Stream Deck app — "Kasa Switch" should now appear in the action
   list (search or check the category list on the right).

To update after pulling new changes, rebuild and restart:
```
npm run build
npx streamdeck restart com.caffecter.kasa
```

## Usage

1. Drag the **Kasa Switch** action onto any key.
2. Open that key's settings (the property inspector):
   - **Discover** — click to scan your network; pick a found device to fill
     in **Device IP**, or type the IP in yourself if you already know it (or
     if discovery doesn't find it — see [Limitations](#limitations)).
   - **On press** — choose **Toggle**, **Turn On**, or **Turn Off**.
   - **Outlet** — for a multi-outlet strip only, pick which outlet this key
     controls. Leave blank for a single switch or plug.
3. That's it — the key immediately shows the device's current state, and
   keeps itself updated from then on.

You can add multiple keys pointing at the same strip (one per outlet) or at
different switches entirely; each key is configured independently.

## Desktop shortcuts (optional, Windows only)

If you want to flip a switch without touching Stream Deck at all, you can
generate desktop shortcuts for it:

```
npm run build:toggle
powershell -ExecutionPolicy Bypass -File scripts\make-desktop-shortcuts.ps1
```

By default this creates shortcuts for a single 3-outlet strip at an example
IP — edit the `-Switches` default in the script to match your own setup, or
pass it explicitly to target your own switch(es) and outlet names:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-desktop-shortcuts.ps1 -Switches @(
  @{ Host = '192.168.1.42'; Outlets = @('Outlet 1', 'Outlet 2', 'Outlet 3') },  # a strip
  @{ Host = '192.168.1.43'; Name = 'Fan' }                                     # a single switch
)
```

Each run creates one `.lnk` per outlet (or one per single switch) on your
desktop, named for the action a click will take next — e.g. `Fan On.lnk`.
Clicking it toggles the switch silently (no console window) and renames
itself to match the new state.

Re-running the script for the same switches is safe — it looks up each
outlet's current state and replaces any existing shortcut for it.

## Limitations

- **Newer/updated Kasa firmware may not respond.** Some devices — notably the
  KP303 hardware v2.0 after a firmware update — have been switched by TP-Link
  to a newer, encrypted local protocol ("KLAP") that this plugin doesn't
  speak. If discovery can't find a device you know is on your network, or a
  known IP refuses the connection outright, this is the likely cause. There's
  no workaround short of a KLAP-capable client, which this plugin doesn't
  currently include.
- **Local network only.** Devices on a different subnet/VLAN than your
  computer (a separate guest network, a mesh satellite acting as its own
  segment, etc.) won't show up in discovery and can't be controlled, even if
  they're reachable from your phone's Kasa app over the internet.
- **Desktop shortcuts are Windows-only** and assume the default Node.js
  install location (`C:\Program Files\nodejs\node.exe`).
