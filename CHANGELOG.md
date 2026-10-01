# Changelog

## [v1.0.0] - 2026-10-01

First release.

### 🌉 Bridge

* **Phone on the hotspot LAN.** While VirtualAP runs in managed mode, the
  phone gets an address on `vap-br0` (`.2` on the hotspot `/24` by
  default) and a policy rule at priority 7001 sends traffic for that
  subnet through `main`, ahead of netd's and any VPN's rules. Internet
  traffic, DNS and Droidspaces containers are unaffected.
* **Follows VirtualAP.** Reads `/data/local/virtualap/run.state`, follows a
  changed gateway, stays out of routed mode, and removes the address and
  rule when the hotspot stops, the module is turned off or disabled in the
  manager, or it is uninstalled.
* **IPv6 (off by default).** VirtualAP 2.0.5 and later create `vap-br0`
  with IPv6 switched off; the IPv6 switch opts the phone in. The bridge
  then accepts OpenWrt's router advertisements without their default
  route — the settings are in place before IPv6 comes on, so not even
  briefly — and NyxBridge adds rules only for the prefixes on the bridge
  and for link-local traffic. Turning IPv6 on waits up to 3 seconds for
  OpenWrt's advertisement, so the rules are in place when the switch
  returns. Every check puts the bridge's IPv6 settings back if something
  else changed them, and turning IPv6 off, turning NyxBridge off,
  disabling or uninstalling the module restores exactly the settings the
  bridge had before. With VirtualAP versions before 2.0.5, which left IPv6
  on, a default route the phone already took from OpenWrt is removed.
* **Status in the manager.** The module description shows Active, Idle or
  Problem with the reason.

### ⚙️ One small native program

* **`bin/nyxbridge`**, written in Rust with the standard library only,
  does all the work: the checks, the background watcher, and the commands
  the WebUI, the Action button and a root shell run. `service.sh`,
  `action.sh`, `uninstall.sh` and `ctl.sh` are thin wrappers around it.
* **Straight to the kernel.** Addresses, rules, routes and change
  notifications go over rtnetlink, so a check is a handful of netlink
  requests and starts no other programs.
* **An event-driven watcher.** One process sleeps until the kernel reports
  a change to the bridge's link, addresses, routes or NyxBridge's rules, or
  VirtualAP's `run.state`, `config.sh` or the module's disable/remove
  flags change, and checks again within half a second. A rule netd flushes
  when it restarts is put back as soon as it goes. A check every 5 minutes
  is the only timer, and while idle it starts no processes at all. Checks
  are idempotent and only log changes.
* **Monitoring switch.** Turning it off on the Main screen stops the
  watcher at once and keeps it off across reboots; turning it on starts it
  again without a reboot. While it's off nothing runs in the background,
  and Check now or the Action button apply changes on demand. Saving the
  switch and starting or stopping the watcher happen as one locked step,
  so quick or simultaneous toggles always end in the state that was saved
  last.
* **Root managers.** A watcher started from the WebUI moves itself out of
  the root manager's app cgroup, so it isn't frozen or killed along with
  the manager on KernelSU, SukiSU-Ultra and KernelSU-Next before 3.2.
* **arm64.** The installer stops with a clear message on other devices,
  and checks that the binary runs before finishing. If it can't run at
  boot, `service.sh` logs one line and exits — never a bootloop.

### 🖥️ WebUI

* **Tabs:** Main, Settings, Logs, About.
* **Live Main screen.** The status and the devices on the hotspot update
  by themselves while the WebUI is open — VirtualAP starting or stopping,
  a rule netd removed and the watcher put back, a device joining —
  through `nyxbridge watch`, run with the manager's `spawn()` so it never
  holds the page. A **Live** chip shows when it's on. On a manager without
  `spawn()` the page reads everything when it opens and on refresh.
* **Fast to open:** one read on open, from a single root shell; switching
  tabs re-reads nothing but the log, and only when it has changed. Actions
  (Check now, the switches, Save) run through `spawn()` so the page stays
  responsive. The WebUI is strict
  TypeScript bundled by esbuild into one script, so the manager serves a
  handful of files.
* **Devices on the hotspot** (Main): every device that has sent anything
  over the hotspot in the last few minutes (from the bridge's forwarding
  table), with the addresses the phone has seen for it; OpenWrt is marked
  as the gateway.
* **Route check** (Main): which way the phone sends traffic to an address
  — over the hotspot, or out through something else such as a VPN — from
  the phone or as a given app (VPNs often pick apps). Tap a device to
  check the route to it. When the answer is "not over the hotspot", it
  says whether NyxBridge's rule is missing, another rule comes first, or
  the address simply isn't on the hotspot network.
* **Restart an app when the bridge comes up** (Settings): apps like
  LocalSend look for networks only when they start. Name one (for example
  `org.localsend.localsend_app`) and NyxBridge closes and reopens it when
  the phone gets its hotspot address — only if it was running. **Restart
  it now** does it on demand.
* **Settings:** on/off, IPv6 with an **IPv6 details** sheet (the bridge's
  IPv6 addresses, the rules installed and the rules the routes call for),
  the phone's address with warnings for OpenWrt's DHCP range and the
  gateway, and the rule priority, with a warning from 10000 up, where
  Android's own rules start, and a **Default** button. Changing the
  priority moves the rules over.
* **Diagnostics** (Logs): one tap copies everything useful for a bug
  report — status, VirtualAP's state, the settings, both rule tables, the
  bridge's addresses, routes and IPv6 settings, and the end of the log.
  **Show** opens it to read or select by hand.
* **Translations:** every string comes from `languages/en.json`; other
  languages drop in next to it and missing keys fall back to English.
  Changing the language redraws every tab.
* **Appearance:** System/Light/Dark theme, Material You when the manager
  serves a palette, and fullscreen, as in NyxSUSFS and NyxProps.

### ⌨️ Command line

`/data/adb/modules/nyxbridge/bin/nyxbridge` takes `status [--json]`,
`apply`, `set KEY VALUE`, `start`, `log`, `report`, `devices`,
`route DEST [APP]`, `diag`, `restart-app [APP]` and `watch [SECONDS]`.
