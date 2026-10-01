use std::collections::BTreeMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::process::{Command, Stdio};

use crate::conf::{self, Paths};
use crate::json::{self, Obj};
use crate::nl::Sock;
use crate::reconcile;
use crate::rtnl::{self, AF_INET, AF_INET6};
use crate::state::Va;

pub fn app_running(pkg: &str) -> bool {
    let Ok(rd) = fs::read_dir("/proc") else { return false };
    rd.filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
        .any(|e| {
            let Ok(c) = fs::read(e.path().join("cmdline")) else { return false };
            let name = c.split(|&b| b == 0).next().unwrap_or(&[]);
            name == pkg.as_bytes() || (name.starts_with(pkg.as_bytes()) && name.get(pkg.len()) == Some(&b':'))
        })
}

fn quiet(prog: &str, args: &[&str]) -> bool {
    Command::new(prog)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn restart_app(pkg: &str, only_if_running: bool) -> Result<bool, String> {
    if !conf::valid_package(pkg) {
        return Err(format!("Not a package name: {pkg}"));
    }
    if only_if_running && !app_running(pkg) {
        return Ok(false);
    }
    if !quiet("am", &["force-stop", pkg]) {
        return Err(format!("Could not stop {pkg}"));
    }
    if !quiet("monkey", &["-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]) {
        return Err(format!("Stopped {pkg}, but could not open it again"));
    }
    Ok(true)
}

fn restart_app_logged(p: &Paths, pkg: &str) {
    match restart_app(pkg, true) {
        Ok(true) => conf::log(p, &format!("Restarted {pkg} so it sees the bridge")),
        Ok(false) => {}
        Err(e) => conf::log(p, &e),
    }
}

pub fn check(p: &Paths, nl: &Sock) -> Option<reconcile::Outcome> {
    let out = reconcile::reconcile_locked(p, nl)?;
    if out.addr_added {
        let app = conf::Config::load(p).restart_app;
        if !app.is_empty() {
            restart_app_logged(p, &app);
        }
    }
    Some(out)
}

struct Device {
    mac: String,
    v4: Vec<Ipv4Addr>,
    v6: Vec<Ipv6Addr>,
}

pub fn devices_json(p: &Paths, nl: &Sock) -> String {
    let va = Va::load(p);
    let Some(idx) = reconcile::if_index(p, &va.bridge) else {
        return Obj::new()
            .str("bridge", &va.bridge)
            .bool("bridge_present", false)
            .raw("devices", "[]")
            .end();
    };
    fn entry(m: &mut BTreeMap<String, Device>, mac: String) -> &mut Device {
        m.entry(mac.clone()).or_insert(Device {
            mac,
            v4: Vec::new(),
            v6: Vec::new(),
        })
    }
    let mut by_mac: BTreeMap<String, Device> = BTreeMap::new();
    for n in rtnl::neighbours(nl, idx).unwrap_or_default() {
        if n.state & (rtnl::NUD_NOARP | rtnl::NUD_INCOMPLETE | rtnl::NUD_FAILED) != 0 {
            continue;
        }
        let Some(mac) = n.mac else { continue };
        match n.ip {
            IpAddr::V4(a) => entry(&mut by_mac, mac).v4.push(a),
            IpAddr::V6(a) if !a.is_multicast() => entry(&mut by_mac, mac).v6.push(a),
            IpAddr::V6(_) => {}
        }
    }
    for mac in rtnl::bridge_macs(nl, idx).unwrap_or_default() {
        entry(&mut by_mac, mac);
    }
    let gw: Option<Ipv4Addr> = va.gateway.parse().ok();
    let mut list: Vec<(bool, Device)> = by_mac
        .into_values()
        .map(|mut d| {
            d.v4.sort();
            // Global and unique-local addresses before link-local ones.
            d.v6.sort_by_key(|a| (a.segments()[0] & 0xffc0 == 0xfe80, *a));
            (gw.is_some_and(|g| d.v4.contains(&g)), d)
        })
        .collect();
    list.sort_by(|(ga, a), (gb, b)| {
        let key = |g: &bool, d: &Device| {
            (
                !*g,
                d.v4.first().copied().map_or(1, |_| 0),
                d.v4.first().copied(),
                d.v6.is_empty(),
                d.mac.clone(),
            )
        };
        key(ga, a).cmp(&key(gb, b))
    });
    let devices: Vec<String> = list
        .iter()
        .map(|(gateway, d)| {
            let v4: Vec<String> = d.v4.iter().map(|a| a.to_string()).collect();
            let v6: Vec<String> = d.v6.iter().map(|a| a.to_string()).collect();
            Obj::new()
                .str("mac", &d.mac)
                .strs("ipv4", &v4)
                .strs("ipv6", &v6)
                .bool("gateway", *gateway)
                .end()
        })
        .collect();
    Obj::new()
        .str("bridge", &va.bridge)
        .bool("bridge_present", true)
        .raw("devices", &json::array(&devices))
        .end()
}

pub fn app_uid(p: &Paths, pkg: &str) -> Option<u32> {
    conf::read(&p.packages_list).lines().find_map(|l| {
        let mut f = l.split_whitespace();
        (f.next()? == pkg).then(|| f.next()?.parse().ok())?
    })
}

fn ifname(p: &Paths, index: u32) -> Option<String> {
    fs::read_dir(&p.sys_net).ok()?.filter_map(|e| e.ok()).find_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        let i: u32 = fs::read_to_string(e.path().join("ifindex")).ok()?.trim().parse().ok()?;
        (i == index).then_some(name)
    })
}

pub fn route_json(p: &Paths, nl: &Sock, dest: &str, app: Option<&str>) -> Result<String, String> {
    let ip: IpAddr = dest.trim().parse().map_err(|_| format!("Not an IP address: {dest}"))?;
    let uid = match app {
        Some(pkg) if !pkg.is_empty() => Some(app_uid(p, pkg).ok_or_else(|| format!("App not found: {pkg}"))?),
        _ => None,
    };
    let r = rtnl::route_get(nl, ip, uid).map_err(|e| format!("No route to {ip}: {e}"))?;
    let va = Va::load(p);
    let dev = r.oif.and_then(|i| ifname(p, i));
    let via_bridge = dev.as_deref() == Some(va.bridge.as_str());
    Ok(Obj::new()
        .str("dest", &ip.to_string())
        .opt_str("app", app.filter(|a| !a.is_empty()))
        .raw("uid", &uid.map(|u| u.to_string()).unwrap_or_else(|| "null".into()))
        .opt_str("dev", dev.as_deref())
        .str("table", &rtnl::table_name(r.table))
        .opt_str("via", r.gateway.map(|g| g.to_string()).as_deref())
        .opt_str("src", r.prefsrc.map(|g| g.to_string()).as_deref())
        .bool("via_bridge", via_bridge)
        .str("bridge", &va.bridge)
        .end())
}

pub fn diag(p: &Paths, nl: &Sock) -> String {
    let mut o = String::new();
    let line = |o: &mut String, s: &str| {
        o.push_str(s);
        o.push('\n');
    };
    line(
        &mut o,
        &format!("NyxBridge {}", option_env!("NYX_MODULE_VERSION").unwrap_or("unknown")),
    );
    line(&mut o, &format!("Time: {}", conf::now_text()));
    for prop in ["ro.product.model", "ro.build.version.release", "ro.build.version.sdk"] {
        let v = Command::new("getprop")
            .arg(prop)
            .stderr(Stdio::null())
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        if !v.is_empty() {
            line(&mut o, &format!("{prop}: {v}"));
        }
    }
    line(&mut o, "\n== Status");
    o.push_str(&crate::ctl::status_kv(p, nl));
    line(&mut o, "\n== VirtualAP run.state");
    let rs = conf::read(&p.va_state);
    o.push_str(if rs.is_empty() { "(none)\n" } else { &rs });
    line(&mut o, "\n== Config");
    for l in conf::read(&p.conf)
        .lines()
        .filter(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty())
    {
        line(&mut o, l);
    }
    for (fam, label) in [(AF_INET, "IPv4"), (AF_INET6, "IPv6")] {
        line(&mut o, &format!("\n== {label} rules"));
        for r in rtnl::rules(nl, fam).unwrap_or_default() {
            line(&mut o, &format!("{}:\t{}", r.pref, r.text()));
        }
    }
    let va = Va::load(p);
    if let Some(idx) = reconcile::if_index(p, &va.bridge) {
        line(&mut o, &format!("\n== {} (ifindex {idx})", va.bridge));
        for fam in [AF_INET, AF_INET6] {
            for a in rtnl::addrs(nl, fam, idx).unwrap_or_default() {
                line(
                    &mut o,
                    &format!("addr {}/{} scope {} flags 0x{:x}", a.ip, a.prefixlen, a.scope, a.flags),
                );
            }
        }
        for r in rtnl::routes(nl, AF_INET6).unwrap_or_default().iter().filter(|r| r.oif == Some(idx)) {
            let dst = r.dst.map(|(ip, l)| rtnl::prefix_text(&ip, l)).unwrap_or_else(|| "default".into());
            line(
                &mut o,
                &format!(
                    "route6 {dst} table {} proto {} type {}",
                    rtnl::table_name(r.table),
                    r.protocol,
                    r.rtype
                ),
            );
        }
        let k: Vec<String> = [
            "disable_ipv6",
            "accept_ra",
            "accept_ra_defrtr",
            "autoconf",
            "accept_ra_rt_table",
            "forwarding",
        ]
        .iter()
        .map(|n| {
            format!(
                "{n}={}",
                fs::read_to_string(format!("{}/{}/{n}", p.proc_v6, va.bridge))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|_| "?".into())
            )
        })
        .collect();
        line(&mut o, &format!("ipv6 {}", k.join(" ")));
    }
    line(&mut o, "\n== Applied");
    o.push_str(&conf::read(&p.applied));
    if let Some(pid) = crate::daemon::pid(p) {
        line(&mut o, &format!("\n== Watcher pid {pid}"));
        o.push_str(&conf::read(&format!("/proc/{pid}/cgroup")));
    }
    line(&mut o, "\n== Log (last 50 lines)");
    let log = conf::read(&p.log);
    let lines: Vec<&str> = log.lines().collect();
    for l in &lines[lines.len().saturating_sub(50)..] {
        line(&mut o, l);
    }
    o
}
