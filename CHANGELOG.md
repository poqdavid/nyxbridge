# Changelog

## [v1.0.1] - 2026-10-03

### 🌐 IPv6 with VirtualAP 2.0.5

VirtualAP 2.0.5 hands hotspot clients IPv6 from the OpenWrt container and creates `vap-br0` with IPv6 switched off, so the phone stays off that network. NyxBridge's IPv6 switch is how you opt the phone back in, without a default route through OpenWrt.

* **Switching off restores VirtualAP's setting.** Turning the IPv6 switch off, turning NyxBridge off, disabling the module or uninstalling it now puts back exactly the IPv6 settings the bridge had before, including VirtualAP's "IPv6 off". Before, it left IPv6 on with Android's defaults, so the phone took an address and a default route from OpenWrt's advertisements.
* **No default route, not even briefly.** The router-advertisement settings are in place before IPv6 comes on, so an advertisement arriving in between can't install one. With VirtualAP versions before 2.0.5, which left IPv6 on, the default route the phone had already taken from OpenWrt is removed when the switch comes on.
* **Settings stay put.** Every check puts the bridge's IPv6 settings back if something else changed them, and logs it.

### 🐛 Fixes

* **A watcher started from the WebUI stopped later.** On KernelSU, SukiSU-Ultra and KernelSU-Next before 3.2, the WebUI's root shell runs inside the root manager's app cgroup. A watcher started with the Monitoring switch or Start watcher was frozen along with the manager once it went to the background, and killed with it, after which the WebUI showed "On, but the watcher isn't running". The watcher now moves itself out of the manager's cgroups when it starts, as KernelSU-Next 3.2 does for its WebUI shells. A watcher started at boot was never affected.

## [v1.0.0] - 2026-10-01

First release.

### 🌉 Bridge

* **Phone on the hotspot LAN.** While VirtualAP runs in managed mode, the phone gets an address on `vap-br0` (`.2` on the hotspot `/24` by default) and a policy rule at priority 7001 sends traffic for that subnet through `main`, ahead of netd's and any VPN's rules. Internet traffic, DNS and Droidspaces containers are unaffected.
* **Follows VirtualAP.** Reads `/data/local/virtualap/run.state`, follows a changed gateway, stays out of routed mode, and removes the address and rule when the hotspot stops, the module is turned off or disabled in the manager, or it is uninstalled.
* **Watcher.** Reacts to `ip monitor` link and address events for the bridge within about a second, and re-checks every 30 seconds because netd flushes policy rules when it restarts. Checks are idempotent and only log changes. The supervisor of `ip monitor` exits on its own if the watcher is killed.
* **IPv6 (off by default).** Accepts OpenWrt's router advertisements on the bridge without its default route, and adds rules only for the prefixes on the bridge and for link-local traffic.
* **Status in the manager.** The module description shows Active, Idle or Problem with the reason.
* **Monitoring switch.** Turning it off on the Main screen stops the watcher at once and keeps it off across reboots; turning it on starts it again without a reboot. While it's off nothing runs in the background, and Check now or the Action button apply changes on demand. Saving the switch and starting or stopping the watcher happen as one locked step, so quick or simultaneous toggles always end in the state that was saved last, and a stop that arrives during a check lets the check finish first.

### 🖥️ WebUI

* **Tabs:** Main (status box with Check now), Settings, Logs, About.
* **One read on open:** status, settings, log and module info come from a single root shell; switching tabs never runs a command.
* **Translations:** every string comes from `languages/en.json`; other languages drop in next to it and missing keys fall back to English. Changing the language redraws every tab.
* **Appearance:** System/Light/Dark theme, Material You when the manager serves a palette, and fullscreen, as in NyxSUSFS and NyxProps.
