# Tests

Three suites run in CI on every push and pull request (see
`.github/workflows/build.yml`). All of them run on a Linux machine; none
needs a phone or VirtualAP.

| Suite | What it checks | Run it |
| --- | --- | --- |
| Boot and watcher | `service.sh` and the watcher in 19 device scenarios: every Android tool call, every file written and every address, rule and IPv6 setting on the bridge, step by step | `sudo python3 tests/boot/run.py --binary <static host build>` |
| WebUI | Every page and setting in Chromium against the real program, live updates, route checks, diagnostics, theme and fullscreen, bridge behaviour and system-bar padding | `sudo node tests/webui/run.cjs` |
| Installer | `customize.sh` refuses unsupported CPUs and managers before it touches anything | `python3 scripts/test-install.py` |

The first two need root: each run builds VirtualAP's managed-mode bridge
in network namespaces of its own, so the machine's own network is never
touched. They also need a kernel with IPv6, bridges and veth, and iproute2.

## Boot and watcher

`tests/boot/run.py` builds a fake Android root for each scenario (VirtualAP
running, stopped, late or in routed mode; monitoring off; the module
disabled; custom, odd or missing settings; IPv6 with and without an
announced prefix, with an old VirtualAP or with no IPv6 on the bridge; an app
to restart; a binary that can't run), installs `module/` and the binary
into it and runs `service.sh` in a chroot with a static busybox, in private
network, mount and PID namespaces. Then the scenario's events follow:
VirtualAP starting, stopping or moving to another subnet, netd flushing
the rule, settings changed from the WebUI or by hand, the Action button,
uninstall. After each step the run waits until the watcher has settled and
compares what changed with `tests/boot/expected/<scenario>.json`. `am`,
`monkey` and `getprop` are logging stubs.

It needs a statically linked busybox (Debian/Ubuntu: `busybox-static`) and
a static host build:

```sh
RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target x86_64-unknown-linux-gnu
sudo python3 tests/boot/run.py --binary target/x86_64-unknown-linux-gnu/release/nyxbridge
sudo python3 tests/boot/run.py --binary ... default ipv6   # just these scenarios
```

## WebUI

`tests/webui/run.cjs` builds a hotspot in network namespaces (the bridge,
OpenWrt and a client, plus a VPN-style rule) and a temporary device root
with the module and the program, loads the built `module/webroot` in
Chromium with a mock KernelSU manager whose `exec` and `spawn` behave like
the real bridge and run each command for real, and goes through every page.

```sh
npm ci
npx playwright install chromium
npm run build
cargo build --release
sudo "$(command -v node)" tests/webui/run.cjs
sudo NYX_SH=mksh "$(command -v node)" tests/webui/run.cjs   # the commands under mksh, as on Android
```

`--binary PATH` tests another build of the program;
`NYX_CHROMIUM=/path/to/chrome` uses an existing Chromium; `NYX_DEBUG=1` logs
every command; `VERBOSE=1` lists passing checks too.

## When a change is intended

Both comparison suites take `--update` to rewrite their expected files:

```sh
sudo python3 tests/boot/run.py --binary ... --update
sudo "$(command -v node)" tests/webui/run.cjs --update
```

Review the diff of `tests/*/expected/` before committing it: it should show
exactly the behaviour the change was meant to alter.
