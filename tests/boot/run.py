#!/usr/bin/env python3
"""Boot and watcher tests for bin/nyxbridge.

Each scenario builds a fake Android root with the module installed and runs
in its own network, mount and PID namespaces: service.sh starts the watcher
in a chroot with a static busybox, then the scenario's device events follow
(VirtualAP starting, stopping or changing its gateway, netd flushing rules,
OpenWrt announcing an IPv6 prefix, settings changed from the WebUI or by
hand, the module disabled in the manager, the Action button, uninstall).
After each step the run waits until the watcher has settled and records:

  * the step's exit code and output (for commands),
  * every call to an Android tool (am, monkey, getprop) - through logging stubs,
  * the files the step changed (config, log, status, module.prop, ...),
  * the network state NyxBridge manages: the addresses on the bridge, its
    routes and IPv6 settings, and the policy rules other than the kernel's,
  * how many watchers are running.

The result is compared with tests/boot/expected/<scenario>.json. Run with
--update to rewrite those files after an intended change, and review the diff.

usage: sudo python3 tests/boot/run.py --binary PATH [--update] [scenario ...]

Needs root, unshare(1), chroot(8), ip(8) from iproute2, a kernel with IPv6,
bridges and veth, a statically linked busybox and a static host build, e.g.
  RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target x86_64-unknown-linux-gnu
"""
import argparse
import difflib
import fcntl
import json
import os
import re
import shutil
import stat as st
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
EXPECTED = os.path.join(HERE, "expected")
MOD = "/data/adb/modules/nyxbridge"
DATA = "/data/adb/nyxbridge"
RUN = "/dev/nyxbridge"
VA_DIR = "/data/local/virtualap"
BR = "vap-br0"
APP = "org.localsend.localsend_app"
KNOBS = ["disable_ipv6", "accept_ra", "accept_ra_defrtr", "autoconf"]
DEFAULT_RULES = {"0", "32766", "32767"}
QUIET = float(os.environ.get("NYX_QUIET", "1.2"))  # seconds without a change that count as settled

LOGLINE = r'''__nyx_log() { _l="$1"; shift; for _a in "$@"; do _l="$_l [$_a]"; done; printf '%s\n' "$_l" >> /calls.log; }'''

# Android tools bin/nyxbridge runs; it puts /system/bin first in PATH.
MOCKS = {
    "am": LOGLINE + r'''
__nyx_log am "$@"
if [ "$1" = force-stop ]; then
    for _p in /proc/[0-9]*; do
        [ "$(tr '\0' '\n' < "$_p/cmdline" 2> /dev/null | head -n 1)" = "$2" ] && kill "${_p#/proc/}" 2> /dev/null
    done
fi
exit 0
''',
    "monkey": LOGLINE + '\n__nyx_log monkey "$@"\nexit 0\n',
    "getprop": LOGLINE + '\n__nyx_log getprop "$@"\nexit 0\n',
}

STATE_BRIDGED = f"mode=bridged\ncontainer=openwrt\nbridge={BR}\ngateway=192.168.42.1\n"

# name -> dict(config overrides or None for no data folder, VirtualAP at boot, flags, steps)
#   va:    None (not running) | "up" (managed mode, bridge up) | "old" (as up, but a
#          VirtualAP before 2.0.5: IPv6 left on and a default route from OpenWrt)
#          | "state" (run.state without the bridge) | "routed"
#   steps: (label, action, *args); see Scenario.do_<action>
SCENARIOS = {
    "default": {"va": "up", "steps": [
        ("boot", "boot"),
        ("netd flushes the rule", "netd_flush"),
        ("VirtualAP stops", "va_down"),
        ("VirtualAP starts again", "va_up"),
        ("Action button", "script", "action.sh"),
    ]},
    "hotspot-later": {"va": None, "steps": [
        ("boot", "boot"),
        ("VirtualAP starts", "va_up"),
        ("VirtualAP moves to another subnet", "va_state", STATE_BRIDGED.replace("192.168.42.1", "192.168.43.1")),
        ("VirtualAP stops", "va_down"),
    ]},
    "bridge-late": {"va": "state", "steps": [
        ("boot", "boot"),
        ("the bridge comes up", "bridge_up"),
        ("the bridge goes away", "bridge_down"),
    ]},
    "routed": {"va": "routed", "steps": [
        ("boot", "boot"),
        ("VirtualAP switches to managed mode", "va_up"),
        ("VirtualAP switches back to routed mode", "va_state", "mode=routed\ngateway=192.168.42.1\n"),
    ]},
    "monitor-off": {"va": "up", "config": {"monitor": "0"}, "steps": [
        ("boot", "boot"),
        ("Action button", "script", "action.sh"),
        ("netd flushes the rule", "netd_flush"),
        ("monitoring on from the WebUI", "ctl", "set", "monitor", "1"),
        ("monitor=0 edited in config.sh", "edit_config", "monitor", "0"),
        ("monitoring on from the WebUI again", "ctl", "set", "monitor", "1"),
        ("monitoring off from the WebUI", "ctl", "set", "monitor", "0"),
    ]},
    "turned-off": {"va": "up", "config": {"enabled": "0"}, "steps": [
        ("boot", "boot"),
        ("turned on from the WebUI", "ctl", "set", "enabled", "1"),
        ("turned off from the WebUI", "ctl", "set", "enabled", "0"),
    ]},
    "module-disabled": {"va": "up", "flags": ["disable"], "steps": [
        ("boot", "boot"),
        ("enabled in the manager", "flag", "disable", False),
        ("disabled in the manager", "flag", "disable", True),
        ("enabled, then marked for removal", "flags_seq", ("disable", False), ("remove", True)),
    ]},
    "custom-settings": {"va": "up", "config": {"host_octet": "50", "rule_pref": "6500"},
                        "va_state": STATE_BRIDGED.replace("192.168.42.1", "10.42.0.1"), "steps": [
        ("boot", "boot"),
        ("rule priority 7002", "ctl", "set", "rule_pref", "7002"),
        ("phone address .60", "ctl", "set", "host_octet", "60"),
        ("refused: the gateway's address", "ctl", "set", "host_octet", "1"),
        ("refused: priority out of range", "ctl", "set", "rule_pref", "40000"),
        ("refused: unknown setting", "ctl", "set", "nope", "1"),
        ("refused: not a package", "ctl", "set", "restart_app", "not a package"),
        ("status --json", "ctl", "status", "--json"),
    ]},
    "host-is-gateway": {"va": "up", "config": {"host_octet": "1"}, "steps": [
        ("boot", "boot"),
        ("host_octet=3 edited in config.sh", "edit_config", "host_octet", "3"),
    ]},
    "odd-values": {"va": "up", "config": {"enabled": "yes", "ipv6": "2", "host_octet": "'07'", "rule_pref": "99999",
                                          "restart_app": "'bad pkg'", "monitor": "'1'"},
                   "va_state": "mode=bridged\r\nbridge=../../etc\r\ngateway=192.168.42.1\r\n", "steps": [
        ("boot", "boot"),
        ("status", "ctl", "status"),
    ]},
    "bad-gateway": {"va": "up", "va_state": f"mode=bridged\nbridge={BR}\ngateway=192.168.42\n", "steps": [
        ("boot", "boot"),
        ("VirtualAP writes a gateway", "va_state", STATE_BRIDGED),
    ]},
    "no-config": {"va": "up", "config": None, "steps": [
        ("boot", "boot"),
    ]},
    "ipv6": {"va": "up", "config": {"ipv6": "1"}, "steps": [
        ("boot", "boot"),
        ("OpenWrt announces a prefix", "ra"),
        ("something else changes accept_ra_defrtr, then Check now", "knob_then_apply", "accept_ra_defrtr", "1"),
        ("IPv6 off from the WebUI", "ctl", "set", "ipv6", "0"),
        ("IPv6 on from the WebUI", "ctl", "set", "ipv6", "1"),
        ("turned off from the WebUI", "ctl", "set", "enabled", "0"),
    ]},
    "ipv6-old-virtualap": {"va": "old", "config": {"ipv6": "1"}, "steps": [
        ("boot", "boot"),
        ("uninstall", "script", "uninstall.sh"),
    ]},
    "ipv6-unavailable": {"va": "up", "config": {"ipv6": "1"}, "no_ipv6_bridge": True, "steps": [
        ("boot", "boot"),
        ("IPv6 off from the WebUI", "ctl", "set", "ipv6", "0"),
    ]},
    "restart-app": {"va": None, "config": {"restart_app": APP}, "app": True, "steps": [
        ("boot", "boot"),
        ("VirtualAP starts while the app runs", "va_up"),
        ("netd flushes the rule", "netd_flush"),
        ("VirtualAP restarts; the app is not running", "va_restart"),
        ("Restart it now from the WebUI", "ctl", "restart-app"),
        ("Restart an app that isn't a package", "ctl", "restart-app", "nope"),
    ]},
    "binary-broken": {"va": "up", "broken_binary": True, "steps": [
        ("boot", "boot"),
    ]},
    "uninstall": {"va": "up", "steps": [
        ("boot", "boot"),
        ("uninstall", "script", "uninstall.sh"),
    ]},
    "watcher-killed": {"va": "up", "steps": [
        ("boot", "boot"),
        ("the watcher is killed", "kill_watcher"),
        ("netd flushes the rule", "netd_flush"),
        ("Action button", "script", "action.sh"),
    ]},
}


def write(path, content, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    os.chmod(path, mode)


def mkdir(path, mode=0o755):
    os.makedirs(path, exist_ok=True)
    os.chmod(path, mode)


def apply_config(base_text, overrides):
    lines = base_text.split("\n")
    for key, val in overrides.items():
        for i, line in enumerate(lines):
            if line.startswith(f"{key}="):
                lines[i] = f"{key}={val}"
                break
        else:
            lines.insert(len(lines) - 1 if lines and lines[-1] == "" else len(lines), f"{key}={val}")
    return "\n".join(lines)


TIME = re.compile(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d")


def normalize_text(text):
    """Output and file content as compared: no clock times, pids or build version."""
    text = TIME.sub("<time>", text)
    text = re.sub(r"\(pid \d+\)", "(pid <pid>)", text)
    text = re.sub(r'"daemon_pid":\d+', '"daemon_pid":"<pid>"', text)
    text = re.sub(r'"version":"[^"]*"', '"version":"<build>"', text)
    text = re.sub(r"^version=.*$", "version=<build>", text, flags=re.M)
    return re.sub(r"^nyxbridge \S+$", "nyxbridge <build>", text, flags=re.M)


class Scenario:
    def __init__(self, name, sc, root, module_dir, binary, tools):
        self.name, self.sc, self.root, self.module_dir, self.binary = name, sc, root, module_dir, binary
        self.ip, self.busybox, self.chroot = tools["ip"], tools["busybox"], tools["chroot"]
        self.ifnames = {}  # ifindex -> name as recorded (a recreated link gets name#2)
        self.seen = {}
        self.app = None
        self.calls_pos = 0

    # ---- the device ---------------------------------------------------------
    def build_root(self):
        root, sc = self.root, self.sc
        mkdir(f"{root}/bin")
        shutil.copy2(self.busybox, f"{root}/bin/busybox")
        for a in subprocess.run([self.busybox, "--list"], capture_output=True, text=True).stdout.split():
            if a != "busybox":
                os.symlink("busybox", f"{root}/bin/{a}")
        mkdir(f"{root}/system/bin")
        os.symlink("/bin/busybox", f"{root}/system/bin/sh")
        for name, body in MOCKS.items():
            write(f"{root}/system/bin/{name}", "#!/bin/sh\n" + body, 0o755)
        mkdir(f"{root}/dev")
        os.mknod(f"{root}/dev/null", 0o666 | st.S_IFCHR, os.makedev(1, 3))
        os.chmod(f"{root}/dev/null", 0o666)
        mkdir(f"{root}/proc")
        mkdir(f"{root}/sys")
        mkdir(f"{root}/tmp", 0o1777)
        write(f"{root}/calls.log", "")
        # The module as KernelSU installs it: set_perm_recursive $MODPATH 0 0 0755 0644,
        # customize.sh makes bin/nyxbridge executable and removes itself and verify.sh.
        mod = root + MOD
        shutil.copytree(self.module_dir, mod, symlinks=True,
                        ignore=shutil.ignore_patterns("*.sha256", "LICENSE*", "NOTICE.md", "webroot", "bin", "customize.sh", "verify.sh"))
        mkdir(f"{mod}/bin")
        if sc.get("broken_binary"):
            write(f"{mod}/bin/nyxbridge", "not a program for this CPU\n")
        else:
            shutil.copy2(self.binary, f"{mod}/bin/nyxbridge")
        for dirpath, dirs, fnames in os.walk(mod):
            os.chmod(dirpath, 0o755)
            for f in fnames:
                os.chmod(os.path.join(dirpath, f), 0o644)
        os.chmod(f"{mod}/bin/nyxbridge", 0o755)
        for flag in sc.get("flags", []):
            write(f"{mod}/{flag}", "")
        # customize.sh: /data/adb/nyxbridge (0700) with config.sh (0600).
        cfg = sc.get("config", {})
        if cfg is not None:
            mkdir(root + DATA, 0o700)
            write(f"{root}{DATA}/config.sh", apply_config(open(os.path.join(self.module_dir, "config.sh")).read(), cfg), 0o600)
        mkdir(root + VA_DIR)
        mkdir(f"{root}/data/system")
        write(f"{root}/data/system/packages.list", f"{APP} 10234 0 /data/user/0/{APP} default:targetSdkVersion=34 3003\n")

    def mount(self):
        subprocess.run(["mount", "-t", "proc", "proc", f"{self.root}/proc"], check=True)
        subprocess.run(["mount", "-t", "sysfs", "sysfs", f"{self.root}/sys"], check=True)
        self.sh_ip("link", "set", "lo", "up")

    def sh_ip(self, *args, check=True):
        p = subprocess.run([self.ip, *args], capture_output=True, text=True)
        if check and p.returncode:
            raise RuntimeError(f"ip {' '.join(args)}: {p.stderr.strip()}")
        return p.stdout

    def set_knob(self, knob, value, dev=BR):
        with open(f"/proc/sys/net/ipv6/conf/{dev}/{knob}", "w") as f:
            f.write(f"{value}\n")

    def write_state(self, text):
        path = f"{self.root}{VA_DIR}/run.state"
        write(path + ".tmp", text)
        os.rename(path + ".tmp", path)

    def bridge_up(self, kind="up"):
        self.sh_ip("link", "add", BR, "address", "02:00:00:00:00:10", "type", "bridge")
        self.sh_ip("link", "add", "vap-veth", "address", "02:00:00:00:00:11", "type", "veth", "peer", "name", "owrt0", "address", "02:00:00:00:00:12")
        if self.sc.get("no_ipv6_bridge"):
            # Below IPv6's minimum MTU the kernel takes IPv6 off the bridge entirely.
            for dev in ["vap-veth", BR]:
                self.sh_ip("link", "set", dev, "mtu", "1200")
        else:
            # VirtualAP 2.0.5 and later create the bridge with IPv6 off; older ones left it on.
            for knob, value in zip(KNOBS, ["0" if kind == "old" else "1", "1", "1", "1"]):
                self.set_knob(knob, value)
        self.sh_ip("link", "set", "vap-veth", "master", BR)
        for dev in ["owrt0", "vap-veth", BR]:
            self.sh_ip("link", "set", dev, "up")
        if kind == "old":
            # What the phone took from OpenWrt's router advertisement before
            # NyxBridge ran: an address and a default route.
            self.wait_for(lambda: "fe80::" in self.sh_ip("-6", "addr", "show", "dev", BR), "link-local address on the bridge")
            self.do_ra()
            self.sh_ip("-6", "route", "add", "default", "via", "fe80::1", "dev", BR, "proto", "ra", "metric", "1024")

    def bridge_down(self):
        self.sh_ip("link", "del", "vap-veth", check=False)
        self.sh_ip("link", "del", BR, check=False)

    def wait_for(self, cond, what, timeout=10):
        end = time.time() + timeout
        while not cond():
            if time.time() > end:
                raise RuntimeError(f"timed out waiting for {what}")
            time.sleep(0.05)

    def initial(self):
        va = self.sc.get("va")
        state = self.sc.get("va_state", STATE_BRIDGED)
        if va in ("up", "old"):
            self.bridge_up(va)
            self.write_state(state)
        elif va == "state":
            self.write_state(state)
        elif va == "routed":
            self.write_state("mode=routed\ngateway=192.168.42.1\n")
        if self.sc.get("app"):
            self.start_app()

    def start_app(self):
        # A process whose argv[0] is the package name, as Android's app processes are.
        self.app = subprocess.Popen([APP, "3600"], executable=shutil.which("sleep"), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # ---- running things in the chroot ---------------------------------------
    def run_in_root(self, argv):
        env = {"PATH": "/system/bin:/bin", "HOME": "/", "KSU": "true"}
        p = subprocess.run([self.chroot, self.root, *argv], env=env, stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=120)
        return p.returncode, normalize_text(p.stdout + p.stderr)

    def script(self, name, *args):
        return self.run_in_root(["/bin/sh", f"{MOD}/{name}", *args])

    # ---- step actions ---------------------------------------------------------
    # A device event made of several changes (VirtualAP deleting its bridge and
    # its run.state, say) reaches the watcher as one: it is stopped while they
    # are made, so the result doesn't depend on how fast this machine makes them.
    FROZEN = {"va_up", "va_down", "va_state", "bridge_up", "bridge_down", "netd_flush", "flag", "flags_seq", "edit_config", "ra"}

    def frozen(self, action, fn, args):
        pids = self.nyx_procs(daemon=True) if action in self.FROZEN else []
        for pid in pids:
            os.kill(int(pid), 19)  # SIGSTOP
        try:
            return fn(*args)
        finally:
            for pid in pids:
                os.kill(int(pid), 18)  # SIGCONT

    def do_boot(self):
        return self.script("service.sh")

    def do_script(self, name):
        return self.script(name)

    def do_ctl(self, *args):
        return self.script("ctl.sh", *args)

    def do_va_up(self):
        self.bridge_up()
        self.write_state(STATE_BRIDGED)

    def do_va_down(self):
        os.remove(f"{self.root}{VA_DIR}/run.state")
        self.bridge_down()

    def do_va_restart(self):
        self.do_va_down()
        self.settle()
        self.do_va_up()

    def do_va_state(self, text):
        self.write_state(text)

    def do_bridge_up(self):
        self.bridge_up()

    def do_bridge_down(self):
        self.bridge_down()

    def do_netd_flush(self):
        pref = self.pref()
        for fam in ["-4", "-6"]:
            for _ in range(16):
                if not any(r.startswith(f"{pref}:") for r in self.rules(fam)):
                    break
                self.sh_ip(fam, "rule", "del", "pref", pref, check=False)

    def do_flag(self, flag, on):
        path = f"{self.root}{MOD}/{flag}"
        if on:
            write(path, "")
        elif os.path.exists(path):
            os.remove(path)

    def do_flags_seq(self, *flags):
        for flag, on in flags:
            self.do_flag(flag, on)

    def do_edit_config(self, key, value):
        path = f"{self.root}{DATA}/config.sh"
        text = open(path).read()
        with open(path, "w") as f:  # in place, as a text editor saves it
            f.write(re.sub(rf"^{key}=.*$", f"{key}={value}", text, flags=re.M))

    def do_ra(self):
        # What OpenWrt's router advertisement leaves on the bridge: an address
        # from the prefix, the prefix route and a more-specific route (RIO).
        self.sh_ip("-6", "addr", "add", "fd00:42::2:aff:fe00:10/64", "dev", BR, "valid_lft", "7200", "preferred_lft", "3600")
        self.sh_ip("-6", "route", "add", "fd00:43::/48", "via", "fe80::1", "dev", BR, "proto", "ra", "metric", "1024")

    def do_knob_then_apply(self, knob, value):
        self.set_knob(knob, value)
        return self.script("ctl.sh", "apply")

    def do_kill_watcher(self):
        for pid in self.nyx_procs(daemon=True):
            os.kill(int(pid), 9)

    # ---- observing --------------------------------------------------------------
    def pref(self):
        try:
            text = open(f"{self.root}{DATA}/config.sh").read()
            m = re.search(r"^rule_pref=(\d+)$", text, re.M)
            return m.group(1) if m else "7001"
        except OSError:
            return "7001"

    def rules(self, fam):
        out = []
        for line in self.sh_ip(fam, "rule", "show", check=False).splitlines():
            pref = line.split(":", 1)[0].strip()
            if pref not in DEFAULT_RULES:
                out.append(re.sub(r"\s+", " ", line.strip()))
        return out

    def links(self):
        """Names of the links now, recording each ifindex the first time it is seen."""
        names = []
        for link in json.loads(self.sh_ip("-j", "link", "show") or "[]"):
            idx, name = str(link["ifindex"]), link["ifname"]
            if idx not in self.ifnames:
                n = self.seen.get(name, 0) + 1
                self.seen[name] = n
                self.ifnames[idx] = name if n == 1 else f"{name}#{n}"
            names.append(name)
        return names

    def net(self):
        """The network state NyxBridge manages."""
        out = {"rules4": self.rules("-4"), "rules6": self.rules("-6")}
        if BR not in self.links():
            out[BR] = None
            return out
        br = {}
        addrs = json.loads(self.sh_ip("-j", "addr", "show", "dev", BR) or "[]")
        info = addrs[0].get("addr_info", []) if addrs else []
        br["addrs"] = sorted(f"{a['family']} {a['local']}/{a['prefixlen']}{'' if a.get('valid_life_time', 4294967295) == 4294967295 else ' dynamic'}"
                             for a in info if a.get("scope") == "global")
        routes = []
        for fam in ["-4", "-6"]:
            for r in json.loads(self.sh_ip("-j", fam, "route", "show", "table", "all", "dev", BR) or "[]"):
                if r.get("table") == "local" or r.get("type", "unicast") != "unicast" or r["dst"].startswith("ff00::"):
                    continue
                gw = f" via {r['gateway']}" if r.get("gateway") else ""
                routes.append(f"{r['dst']}{gw} proto {r.get('protocol', '?')} table {r.get('table', 'main')}")
        br["routes"] = sorted(routes)
        kn = f"/proc/sys/net/ipv6/conf/{BR}"
        br["ipv6"] = ",".join(f"{k}={open(f'{kn}/{k}').read().strip()}" for k in KNOBS) if os.path.isdir(kn) else None
        out[BR] = br
        return out

    def nyx_procs(self, daemon):
        out = []
        for pid in os.listdir(f"{self.root}/proc"):
            if not pid.isdigit():
                continue
            try:
                argv = open(f"{self.root}/proc/{pid}/cmdline", "rb").read().split(b"\0")
            except OSError:
                continue
            if argv[0].endswith(b"/bin/nyxbridge") and (argv[1:2] == [b"daemon"]) == daemon:
                out.append(pid)
        return out

    def checking(self):
        """A check (any command, or the watcher) holds the reconcile lock."""
        path = f"{self.root}{RUN}/reconcile.lock"
        if not os.path.exists(path):
            return False
        fd = os.open(path, os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
            return False
        except OSError:
            return True
        finally:
            os.close(fd)

    def files(self):
        """Everything a step can have changed: path -> [mode, owner, content]."""
        snap = {}
        for w in [DATA, RUN, f"{MOD}/module.prop", f"{MOD}/module.prop.nyxtmp", f"{MOD}/disable", f"{MOD}/remove"]:
            top = self.root + w
            paths = [top]
            if os.path.isdir(top):
                for dirpath, dirs, fnames in os.walk(top):
                    paths += [os.path.join(dirpath, n) for n in sorted(fnames + dirs)]
            for p in paths:
                try:
                    s = os.lstat(p)
                    data = open(p, "rb").read().decode("utf-8", "replace") if st.S_ISREG(s.st_mode) else None
                except OSError:
                    continue  # absent, or gone while walking
                rel = p[len(self.root):]
                snap[rel] = [oct(s.st_mode & 0o7777), f"{s.st_uid}:{s.st_gid}", None if data is None else self.normalize_file(rel, data)]
        return snap

    def normalize_file(self, rel, data):
        if rel.endswith("/module.prop"):
            # The release version changes every release; NyxBridge only sets description=.
            return "\n".join("version=<module.prop>" if l.startswith("version=") else "versionCode=<module.prop>" if l.startswith("versionCode=") else l
                             for l in data.split("\n"))
        if rel.endswith("/config.sh"):
            return "\n".join(l for l in data.split("\n") if l.strip() and not l.lstrip().startswith("#"))
        if rel.endswith("/daemon.pid"):
            return re.sub(r"^\d+ \d+$", "<pid> <start time>", data.strip())
        if rel.endswith("/applied"):
            return re.sub(r"^(A[46]_IDX)=(\d+)$", lambda m: f"{m[1]}=<ifindex of {self.ifnames.get(m[2], '?')}>", data, flags=re.M)
        return normalize_text(data)

    def observe(self):
        return {"files": self.files(), "net": self.net(), "watchers": len(self.nyx_procs(daemon=True))}

    def settle(self, timeout=40):
        """Waits until no check is running and nothing has changed for QUIET seconds."""
        start = time.time()
        last, since = None, time.time()
        while True:
            busy = self.checking() or bool(self.nyx_procs(daemon=False))
            cur = self.observe()
            if cur != last or busy:
                last, since = cur, time.time()
            elif time.time() - since >= QUIET:
                return cur
            if time.time() - start > timeout:
                return {**cur, "settle": "timed out"}
            time.sleep(0.1)

    def calls(self):
        with open(f"{self.root}/calls.log") as f:
            f.seek(self.calls_pos)
            text = f.read()
            self.calls_pos = f.tell()
        return text.splitlines()

    # ---- the scenario -------------------------------------------------------------
    def run(self):
        os.umask(0o022)
        self.build_root()
        self.mount()
        self.initial()
        prev = self.settle()
        out = [{"step": "before boot", "net": prev["net"]}]
        for label, action, *args in self.sc["steps"]:
            r = self.frozen(action, getattr(self, f"do_{action}"), args)
            cur = self.settle()
            files, before = cur["files"], prev["files"]
            changed = {}
            for k, v in sorted(files.items()):
                if before.get(k) == v:
                    continue
                if k.endswith("/nyxbridge.log") and before.get(k) and v[2].startswith(before[k][2]):
                    v = [v[0], v[1], "+" + v[2][len(before[k][2]):]]  # what the step appended
                changed[k] = v
            rec = {"step": label}
            if r is not None:
                rec["exit"], rec["output"] = r
            rec["calls"] = self.calls()
            rec["changed"] = changed
            rec["removed"] = sorted(k for k in before if k not in files)
            rec["net"] = cur["net"]
            rec["watchers"] = cur["watchers"]
            if "settle" in cur:
                rec["settle"] = cur["settle"]
            out.append(rec)
            prev = cur
        return out


def describe(expected, actual):
    """Readable differences between two scenario records."""
    lines = []
    for i in range(max(len(expected), len(actual))):
        e = expected[i] if i < len(expected) else {}
        a = actual[i] if i < len(actual) else {}
        st_lines = []
        if e.get("step") != a.get("step"):
            lines.append(f"  step {i}: expected {e.get('step')!r}, got {a.get('step')!r}")
            continue
        for key in ["exit", "watchers", "settle"]:
            if e.get(key) != a.get(key):
                st_lines.append(f"    {key}: expected {e.get(key)!r}, got {a.get(key)!r}")
        for key in ["output", "calls", "removed"]:
            x, y = e.get(key), a.get(key)
            if x == y:
                continue
            xs = x.split("\n") if isinstance(x, str) else (x or [])
            ys = y.split("\n") if isinstance(y, str) else (y or [])
            for l in difflib.unified_diff(xs, ys, "expected", "actual", lineterm="", n=0):
                if l[:1] in "+-" and not l.startswith(("+++", "---")):
                    st_lines.append(f"    {l[0]} {key}: {l[1:]}")
        ec, ac = e.get("changed", {}), a.get("changed", {})
        for k in sorted(set(ec) | set(ac)):
            x, y = ec.get(k), ac.get(k)
            if x == y:
                continue
            if x is None:
                st_lines.append(f"    + changes {k}")
            elif y is None:
                st_lines.append(f"    - no longer changes {k}")
            else:
                if x[:2] != y[:2]:
                    st_lines.append(f"    ~ {k}: mode/owner {x[0]} {x[1]} -> {y[0]} {y[1]}")
                if x[2] != y[2]:
                    st_lines.append(f"    ~ {k} content:")
                    d = difflib.unified_diff((x[2] or "").split("\n"), (y[2] or "").split("\n"), lineterm="", n=0)
                    st_lines.extend(f"        {l}" for l in list(d)[2:30])
        if e.get("net") != a.get("net"):
            d = difflib.unified_diff(json.dumps(e.get("net"), indent=1).split("\n"), json.dumps(a.get("net"), indent=1).split("\n"), lineterm="", n=0)
            st_lines.append("    ~ network:")
            st_lines.extend(f"        {l}" for l in list(d)[2:30])
        if st_lines:
            lines.append(f"  [{e.get('step')}]")
            lines.extend(st_lines)
    return lines


def find_tool(names, why):
    for n in names:
        path = shutil.which(n) or (n if os.path.isabs(n) and os.path.exists(n) else None)
        if path:
            return path
    sys.exit(f"run.py: {why} not found (looked for {', '.join(names)})")


def inner(a):
    """One scenario, already inside its own network, mount and PID namespaces."""
    tools = {"ip": a.ip, "busybox": a.busybox, "chroot": a.chroot}
    root = os.path.join(a.work, a.inner)
    s = Scenario(a.inner, SCENARIOS[a.inner], root, a.module, a.binary, tools)
    try:
        result = s.run()
    except Exception as e:  # reported as a failed scenario
        result = {"error": f"{type(e).__name__}: {e}"}
    with open(a.out, "w") as f:
        json.dump(result, f)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--binary", required=True, help="static host build of nyxbridge")
    ap.add_argument("--module", default=os.path.join(REPO, "module"), help="module directory (default: the repo's module/)")
    ap.add_argument("--update", action="store_true", help="rewrite the expected files instead of comparing")
    ap.add_argument("scenarios", nargs="*", help="default: all")
    for hidden in ["--inner", "--work", "--out", "--ip", "--busybox", "--chroot"]:
        ap.add_argument(hidden, help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.inner:
        return inner(a)
    if os.geteuid() != 0:
        sys.exit("run.py: needs root (namespaces, chroot) - run with sudo")
    busybox = find_tool(["busybox", "/bin/busybox", "/usr/bin/busybox"], "busybox")
    chroot = find_tool(["chroot", "/usr/sbin/chroot"], "chroot")
    ip = find_tool(["ip", "/sbin/ip", "/usr/sbin/ip", "/bin/ip"], "ip (iproute2)")
    unshare = find_tool(["unshare", "/usr/bin/unshare"], "unshare")
    if "statically linked" not in subprocess.run(["file", "-L", busybox], capture_output=True, text=True).stdout:
        sys.exit(f"run.py: {busybox} must be statically linked (Debian/Ubuntu: busybox-static)")
    if not os.path.isdir("/proc/sys/net/ipv6"):
        sys.exit("run.py: this kernel has no IPv6")
    names = a.scenarios or list(SCENARIOS)
    unknown = [n for n in names if n not in SCENARIOS]
    if unknown:
        sys.exit(f"run.py: unknown scenario(s): {', '.join(unknown)}")
    failed = 0
    with tempfile.TemporaryDirectory(prefix="nyxbridge-boot-") as work:
        work = os.path.realpath(work)
        for n in names:
            t0 = time.time()
            out = os.path.join(work, f"{n}.json")
            subprocess.run([unshare, "--net", "--mount", "--pid", "--fork", "--kill-child", sys.executable, os.path.abspath(__file__),
                            "--inner", n, "--work", work, "--out", out, "--binary", os.path.abspath(a.binary), "--module", os.path.abspath(a.module),
                            "--ip", ip, "--busybox", busybox, "--chroot", chroot], timeout=600)
            actual = json.load(open(out)) if os.path.exists(out) else {"error": "the scenario did not finish"}
            shutil.rmtree(os.path.join(work, n), ignore_errors=True)
            path = os.path.join(EXPECTED, f"{n}.json")
            if isinstance(actual, dict):
                failed += 1
                print(f"FAIL  {n:<20} {actual['error']}")
                continue
            nsteps = len(actual) - 1
            if a.update:
                os.makedirs(EXPECTED, exist_ok=True)
                with open(path, "w") as f:
                    json.dump({"scenario": n, "steps": actual}, f, indent=1, ensure_ascii=False)
                    f.write("\n")
                print(f"WROTE {n:<20} ({nsteps} steps, {time.time() - t0:.1f}s)")
                continue
            if not os.path.exists(path):
                failed += 1
                print(f"FAIL  {n:<20} no expected file {os.path.relpath(path, REPO)} (run with --update)")
                continue
            with open(path) as f:
                expected = json.load(f)["steps"]
            diff = describe(expected, actual)
            if diff:
                failed += 1
                print(f"FAIL  {n:<20} ({nsteps} steps)")
                for l in diff[:120]:
                    print(l)
            else:
                print(f"PASS  {n:<20} ({nsteps} steps, {time.time() - t0:.1f}s)")
    if not a.update:
        print(f"== {len(names) - failed}/{len(names)} scenarios match tests/boot/expected/")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
