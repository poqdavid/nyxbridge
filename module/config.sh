#!/bin/sh
# NyxBridge persistent config.

# Every key below is read with a safe default, so it's fine to delete a
# line here - it falls back to that default until you set it again from
# the WebUI.

# Give the phone an address on VirtualAP's managed-mode bridge (vap-br0)
# and route traffic for the hotspot subnet to it. 1 = on, 0 = off.
enabled=1

# Watch VirtualAP in the background and apply changes automatically.
# 0 = nothing runs in the background; re-check from the WebUI or the
# Action button after starting or stopping the hotspot.
monitor=1

# Also take an IPv6 address from OpenWrt's router advertisements on the
# bridge. Never uses OpenWrt as the phone's IPv6 gateway. Off by default.
ipv6=0

# Last number of the phone's address: <VirtualAP gateway /24>.host_octet.
# Keep it outside OpenWrt's DHCP range (.100-.249) and off the gateway.
host_octet=2

# Policy-rule priority. Must stay below 10000 so it is checked before
# Android's own rules and any VPN's.
rule_pref=7001

# WebUI appearance.
webui_theme=system
webui_monet=1
webui_fullscreen=1
