# NyxBridge

[![KernelSU](https://img.shields.io/badge/KernelSU-Supported-green)](https://kernelsu.org/) [![KernelSU-Next](https://img.shields.io/badge/KernelSU--Next-Supported-green)](https://github.com/KernelSU-Next/KernelSU-Next) [![VirtualAP](https://img.shields.io/badge/VirtualAP-Managed_mode-orange)](https://github.com/ravindu644/VirtualAP) [![WebUI](https://img.shields.io/badge/WebUI-Material_You-blueviolet)](#-webui) [![Build](https://github.com/poqdavid/nyxbridge/actions/workflows/build.yml/badge.svg)](https://github.com/poqdavid/nyxbridge/actions/workflows/build.yml) [![Telegram](https://img.shields.io/badge/Join-Support_Chat-blue?logo=telegram&style=flat-square)](https://t.me/poqdavidchat) [![Telegram](https://img.shields.io/badge/Join-Build_Notification-blue?logo=telegram&style=flat-square)](https://t.me/nyxreleases)

A **KernelSU / KernelSU-Next** module that puts the phone itself on **[VirtualAP](https://github.com/ravindu644/VirtualAP)**'s managed-mode hotspot network, so apps on the phone (LocalSend, file servers, anything that talks to the LAN) can reach the devices connected to the hotspot, and they can reach the phone.

---

## ✨ Features

- 🌉 **Phone on the hotspot LAN**: gives the phone an address on VirtualAP's managed-mode bridge (`vap-br0`) and adds the routing rule Android needs to use it
- 🔄 **Follows VirtualAP**: applies when the hotspot starts in managed mode, follows a changed gateway, and removes everything it added when the hotspot stops
- 🛡️ **VPN-safe**: only traffic to the hotspot subnet is routed locally; internet traffic, DNS and your Droidspaces containers keep their routes
- 🌐 **Optional IPv6**: takes an address from OpenWrt's router advertisements without ever using OpenWrt as the phone's IPv6 gateway (off by default)
- 🎨 **Material You WebUI**: Main, Settings, Logs and About tabs, light/dark themes, the wallpaper palette when the manager provides one, and translatable text
- 🪶 **Light**: one small watcher that reacts to network events and re-checks every 30 seconds; no wakelocks, no effect on deep sleep
- ⏯️ **Monitoring switch**: stop the watcher from the Main screen when you don't want anything running in the background, and resume it later, no reboot needed

---

## 📋 Requirements

- **[KernelSU](https://kernelsu.org/)** or **[KernelSU-Next](https://github.com/KernelSU-Next/KernelSU-Next)**
- **[VirtualAP](https://github.com/ravindu644/VirtualAP)** running in **managed mode** (`-K <container>`), usually with an OpenWrt container from **[Droidspaces](https://github.com/ravindu644/Droidspaces-OSS)**

In VirtualAP's routed mode the phone is already the hotspot's gateway, so NyxBridge stays idle there.

---

## 📥 Installation

1. 📦 Download the latest `nyxbridge-*.zip` from the [**Releases**](https://github.com/poqdavid/nyxbridge/releases) page
2. 🧩 Open your **KernelSU / KernelSU-Next** manager → **Modules** → **Install from storage**, and select the zip
3. 🔄 **Reboot**
4. 📡 Start VirtualAP in managed mode. The phone gets `192.168.42.2` (or your chosen number) within a second or two
5. ⚙️ Open the module's **WebUI** from the manager to check status or change settings

> [!TIP]
> Apps that pick their network interfaces at startup, such as LocalSend, need a restart after the address appears.

---

## 🖥️ WebUI

- **Main**: the live status: VirtualAP's mode and gateway, the phone's address, the routing rule and IPv6, the **Monitoring** switch, and **Check now**
- **Settings**: language, on/off, IPv6, and the phone's address on the hotspot subnet (with warnings for OpenWrt's DHCP range and the gateway)
- **Logs**: what the watcher changed and when
- **About**: what the module does, appearance (theme, Material You, fullscreen), credits and license

The manager's **Action** button re-checks and prints the same status.

---

## ⚙️ How it works

In managed mode VirtualAP enslaves its access point to `vap-br0`, a bridge with no address, and hands the network to a container. The phone is not on that network, and an address alone isn't enough: Android routes app traffic through netd's per-network tables (and any VPN's), which never look at the table the bridge's route lands in.

So NyxBridge does two things while VirtualAP reports `mode=bridged` and the bridge exists:

```sh
ip addr add 192.168.42.2/24 dev vap-br0
ip rule add pref 7001 to 192.168.42.0/24 lookup main
```

Priority 7001 sits ahead of netd's and any VPN's rules, and next to VirtualAP's own 7000/7010 without touching them. Traffic to anything outside the hotspot subnet never matches it.

With the **IPv6** switch on, NyxBridge also turns IPv6 on for the bridge (VirtualAP 2.0.5 and later create it with IPv6 off), accepts OpenWrt's router advertisements without their default route, and adds `to <prefix> lookup <table>` rules for the prefixes OpenWrt announces, at the same priority. Android files those routes in a per-interface table (1000 + the bridge's interface index), so the rules point there. Turning the switch off puts back the bridge's original IPv6 settings.

While monitoring is on, a watcher listens to `ip monitor link address` and re-checks within about a second whenever the bridge changes (VirtualAP recreates it on every start). It also re-checks every 30 seconds, because netd flushes all policy rules when it restarts. Every check is idempotent and only logs changes. The module's description in the manager shows the current state.

---

## 🔧 Settings

Kept in `/data/adb/nyxbridge/config.sh` and changed from the WebUI:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `1` | Give the phone an address on the bridge |
| `monitor` | `1` | Run the watcher in the background. With `0` nothing runs in the background and changes apply when you press Check now or the Action button |
| `ipv6` | `0` | Also take an IPv6 address from OpenWrt |
| `host_octet` | `2` | Last number of the phone's address on the hotspot `/24` |
| `rule_pref` | `7001` | Policy-rule priority (keep it below 10000) |
| `webui_theme` | `system` | `system`, `light` or `dark` |
| `webui_monet` | `1` | Use the wallpaper palette |
| `webui_fullscreen` | `1` | Hide the system bars in the WebUI |

Log: `/data/adb/nyxbridge/nyxbridge.log`. From a root shell: `sh /data/adb/modules/nyxbridge/ctl.sh status | apply | set KEY VALUE | log`.

---

## 🌍 Translations

Every language, English included, is a file in `module/webroot/languages/`. Copy `en.json` to `<code>.json`, translate the values, and add the language to `languages.json`. Missing keys fall back to English.

---

## 🔗 Additional Resources

- 📡 [VirtualAP](https://github.com/ravindu644/VirtualAP)
- 📦 [Droidspaces](https://github.com/ravindu644/Droidspaces-OSS)
- 🥷 [NyxSUSFS](https://github.com/poqdavid/nyxsusfs) and 🧩 [NyxProps](https://github.com/poqdavid/nyxprops)
- 📖 [KernelSU Installation Guide](https://kernelsu.org/guide/installation.html)

---

## 💬 Support

If you encounter any issues or need help, feel free to:

- 🐛 Open an issue in this repository
- 💬 Reach out to me directly

---

## ⚠️ Disclaimer

NyxBridge changes the phone's network routing while VirtualAP runs in managed mode. Traffic between the phone and hotspot devices does not go through a VPN. Please make sure to:

- 💾 Back up your data
- 🧠 Understand the changes before proceeding

**🚨 Proceed at your own risk!**

---

## 📱 Contacts

[![Telegram](https://img.shields.io/badge/Telegram-poqdavid-blue?logo=telegram)](https://t.me/poqdavid)

---

## 🌟 Special Thanks

**These amazing people and projects help make this project possible! ❤️**

| 🔧 **Project**          | 👨‍💻 **Developer** | 🔗 **Link**                                              |
| ---------------------- | ----------------- | -------------------------------------------------------- |
| **VirtualAP**          | ravindu644        | [GitHub](https://github.com/ravindu644/VirtualAP)        |
| **Droidspaces**        | ravindu644        | [GitHub](https://github.com/ravindu644/Droidspaces-OSS)  |
| **droidspaces-lan-ip** | yashoswalyo       | [GitHub](https://github.com/yashoswalyo/droidspaces-lan-ip) |
| **KernelSU**           | tiann             | [GitHub](https://github.com/tiann/KernelSU)              |
| **KernelSU-Next**      | rifsxd            | [GitHub](https://github.com/KernelSU-Next/KernelSU-Next) |

*See [NOTICE.md](NOTICE.md) for what comes from where.*

*If you have contributed and are not listed here, please remind me!* 🙏

---

## 📄 License

NyxBridge is released under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`), like NyxSUSFS and NyxProps. [NOTICE.md](NOTICE.md) lists the projects it builds on.

---

## 💝 Donations

Any and all donations are appreciated!

<br/>**BTC Legacy:** 1Q2JQG3iCLZPT2iJfDLow1oQVGKmxheoAh
<br/>**BTC Segwit:** bc1q8gurls0wjkfe43ygmrqmu2pzmyjetnrvgws9sr
<br/>**BCH:** qrks52smlqw7d8700d77uqvmve03d4knzvd2vghaqz
<br/>**ETH:** 0x7218779242a8425879B09969431c20F5eC1a192D
