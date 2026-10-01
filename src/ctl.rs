use std::io::Write;
use std::net::{IpAddr, Ipv4Addr};
use std::os::fd::AsRawFd;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use crate::conf::{self, Config, Paths};
use crate::daemon;
use crate::extras;
use crate::json::Obj;
use crate::lock;
use crate::nl::{self, Sock};
use crate::reconcile;
use crate::rtnl::{self, AF_INET, AF_INET6, RT_SCOPE_UNIVERSE, RT_TABLE_MAIN};
use crate::state::Va;
use crate::sys;

pub fn version() -> &'static str {
    option_env!("NYX_MODULE_VERSION").unwrap_or("unknown")
}

struct Status {
    daemon_pid: Option<u32>,
    daemon: bool,
    monitor: bool,
    module_disabled: bool,
    cfg: Config,
    va: Va,
    bridge_index: Option<u32>,
    subnet: Option<String>,
    host_ip: Option<String>,
    addr4: bool,
    rule4: bool,
    addrs6: Vec<String>,
    rules: Vec<String>,
    rules6: usize,
    v6_targets: Vec<String>,
    file: String,
}

fn gather(p: &Paths, nl: &Sock) -> Status {
    let cfg = Config::load(p);
    let va = Va::load(p);
    let bridge_index = reconcile::if_index(p, &va.bridge);
    let mut s = Status {
        daemon_pid: daemon::pid(p),
        daemon: daemon::running(p),
        monitor: conf::monitor_enabled(p),
        module_disabled: p.module_flagged(),
        bridge_index,
        subnet: None,
        host_ip: None,
        addr4: false,
        rule4: false,
        addrs6: Vec::new(),
        rules: Vec::new(),
        rules6: 0,
        v6_targets: Vec::new(),
        file: conf::read(&p.status),
        cfg,
        va,
    };
    let r4 = reconcile::rules_at(nl, AF_INET, s.cfg.pref);
    let r6 = reconcile::rules_at(nl, AF_INET6, s.cfg.pref);
    if let Some((base, _)) = conf::parse_gw(&s.va.gateway) {
        let subnet = Ipv4Addr::new(base[0], base[1], base[2], 0);
        let host = Ipv4Addr::new(base[0], base[1], base[2], s.cfg.host);
        if let Some(idx) = bridge_index {
            s.addr4 = rtnl::addrs(nl, AF_INET, idx)
                .unwrap_or_default()
                .iter()
                .any(|a| a.ip == IpAddr::V4(host) && a.prefixlen == 24);
        }
        s.rule4 = r4.iter().any(|r| r.is_plain_to(&IpAddr::V4(subnet), 24, RT_TABLE_MAIN));
        s.subnet = Some(format!("{subnet}/24"));
        s.host_ip = Some(host.to_string());
    }
    if let Some(idx) = bridge_index {
        s.addrs6 = rtnl::addrs(nl, AF_INET6, idx)
            .unwrap_or_default()
            .iter()
            .filter(|a| a.scope == RT_SCOPE_UNIVERSE)
            .map(|a| format!("{}/{}", a.ip, a.prefixlen))
            .collect();
        s.v6_targets = reconcile::v6_targets(nl, &s.va.bridge, idx).iter().map(|t| t.line()).collect();
    }
    s.rules6 = r6.len();
    s.rules = r4.iter().chain(r6.iter()).map(|r| format!("{}: {}", r.pref, r.text())).collect();
    s
}

fn b(v: bool) -> &'static str {
    if v {
        "1"
    } else {
        "0"
    }
}

pub fn status_kv(p: &Paths, nl: &Sock) -> String {
    let s = gather(p, nl);
    let f = &s.file;
    let mut o = String::new();
    let mut kv = |k: &str, v: &str| o.push_str(&format!("{k}={v}\n"));
    kv("daemon", if s.daemon { "running" } else { "stopped" });
    kv("monitor", b(s.monitor));
    kv("module_disabled", b(s.module_disabled));
    kv("enabled", b(s.cfg.enabled));
    kv("ipv6", b(s.cfg.ipv6));
    kv("host_octet", &s.cfg.host.to_string());
    kv("rule_pref", &s.cfg.pref.to_string());
    kv("va_mode", &s.va.mode);
    kv("bridge", &s.va.bridge);
    kv("gateway", &s.va.gateway);
    kv("bridge_present", b(s.bridge_index.is_some()));
    if let (Some(sub), Some(host)) = (&s.subnet, &s.host_ip) {
        kv("subnet", sub);
        kv("host_ip", host);
    }
    kv("addr4", b(s.addr4));
    kv("rule4", b(s.rule4));
    kv("addrs6", &s.addrs6.join(" "));
    kv("rules6", &s.rules6.to_string());
    kv("state", &conf::kv(f, "state"));
    kv("reason", &conf::kv(f, "reason"));
    kv("reason_code", &conf::kv(f, "reason_code"));
    kv("reason_arg", &conf::kv(f, "reason_arg"));
    kv("checked", &conf::kv(f, "time"));
    kv("restart_app", &s.cfg.restart_app);
    kv("version", version());
    o
}

pub fn status_json(p: &Paths, nl: &Sock) -> String {
    let s = gather(p, nl);
    let f = &s.file;
    Obj::new()
        .str("version", version())
        .bool("daemon", s.daemon)
        .raw("daemon_pid", &s.daemon_pid.map(|v| v.to_string()).unwrap_or_else(|| "null".into()))
        .bool("monitor", s.monitor)
        .bool("module_disabled", s.module_disabled)
        .bool("enabled", s.cfg.enabled)
        .bool("ipv6", s.cfg.ipv6)
        .num("host_octet", s.cfg.host as i64)
        .num("rule_pref", s.cfg.pref as i64)
        .str("restart_app", &s.cfg.restart_app)
        .str("va_mode", &s.va.mode)
        .str("bridge", &s.va.bridge)
        .str("gateway", &s.va.gateway)
        .bool("bridge_present", s.bridge_index.is_some())
        .opt_str("subnet", s.subnet.as_deref())
        .opt_str("host_ip", s.host_ip.as_deref())
        .bool("addr4", s.addr4)
        .bool("rule4", s.rule4)
        .strs("addrs6", &s.addrs6)
        .num("rules6", s.rules6 as i64)
        .strs("v6_targets", &s.v6_targets)
        .strs("rules", &s.rules)
        .str("state", &conf::kv(f, "state"))
        .str("reason", &conf::kv(f, "reason"))
        .str("reason_code", &conf::kv(f, "reason_code"))
        .str("reason_arg", &conf::kv(f, "reason_arg"))
        .str("checked", &conf::kv(f, "time"))
        .end()
}

fn print_status(p: &Paths, nl: &Sock, json: bool) {
    if json {
        println!("{}", status_json(p, nl));
    } else {
        print!("{}", status_kv(p, nl));
    }
}

fn report(p: &Paths, nl: &Sock) -> String {
    let st = status_kv(p, nl);
    let g = |k: &str| conf::kv(&st, k);
    let mut o = String::new();
    let mut l = |s: String| {
        o.push_str(&s);
        o.push('\n');
    };
    l("***************************************".into());
    l("  NyxBridge - status".into());
    l("***************************************".into());
    match g("state").as_str() {
        "active" => l(format!("[-] Active on {}", g("bridge"))),
        "error" => l(format!("[!] Problem: {}", g("reason"))),
        _ => l(format!("[-] Idle: {}", g("reason"))),
    }
    if g("monitor") == "1" {
        l(format!("[-] Monitoring: on (watcher {})", g("daemon")));
    } else {
        l("[-] Monitoring: off - re-check here or in the WebUI after starting or stopping the hotspot".into());
    }
    l(format!("[-] VirtualAP: {} (gateway {})", g("va_mode"), g("gateway")));
    if g("addr4") == "1" {
        l(format!("[-] Phone: {}/24 on {}", g("host_ip"), g("bridge")));
    } else {
        l("[-] Phone: no address on the bridge".into());
    }
    if g("rule4") == "1" {
        l(format!("[-] Rule: {}: to {} lookup main", g("rule_pref"), g("subnet")));
    } else {
        l("[-] Rule: not installed".into());
    }
    if g("ipv6") == "1" {
        l(format!("[-] IPv6: on - addresses: {}; rules: {}", g("addrs6"), g("rules6")));
    } else {
        l("[-] IPv6: off".into());
    }
    l(format!("[-] Checked: {}", g("checked")));
    o
}

fn err(msg: &str, code: u8) -> ExitCode {
    eprintln!("{msg}");
    ExitCode::from(code)
}

fn set(p: &Paths, nl: &Sock, key: &str, val: &str, json: bool) -> ExitCode {
    let reapply = match key {
        "monitor" => {
            if val != "0" && val != "1" {
                return err("monitor must be 0 or 1", 2);
            }
            let Some(guard) = lock::acquire(&p.monitor_lock, 20_000) else {
                return err("Another change is still running; try again", 1);
            };
            let mut ok = true;
            let mut started = false;
            if conf::config_set(p, "monitor", val).is_err() {
                eprintln!("Could not save the setting");
                ok = false;
            } else if val == "1" {
                conf::log(p, "Monitoring turned on");
                let was_running = daemon::running(p);
                if daemon::start(p) {
                    started = !was_running;
                } else {
                    eprintln!("Monitoring is on, but the watcher did not start");
                    ok = false;
                }
            } else {
                conf::log(p, "Monitoring turned off");
                daemon::stop(p);
            }
            drop(guard);
            if !ok {
                return ExitCode::from(1);
            }
            if started {
                extras::check(p, nl);
            }
            print_status(p, nl, json);
            return ExitCode::SUCCESS;
        }
        "enabled" | "ipv6" => {
            if val != "0" && val != "1" {
                return err(&format!("{key} must be 0 or 1"), 2);
            }
            true
        }
        "host_octet" => {
            let Some(n) = conf::num_in(val, 1, 254) else {
                return err("The last number must be between 1 and 254", 2);
            };
            if conf::parse_gw(&Va::load(p).gateway).is_some_and(|(_, g)| g as u64 == n) {
                return err("That is VirtualAP's gateway address; pick another number", 2);
            }
            true
        }
        "rule_pref" => {
            if conf::num_in(val, 1, 32765).is_none() {
                return err("The rule priority must be between 1 and 32765", 2);
            }
            true
        }
        "restart_app" => {
            if !val.is_empty() && !conf::valid_package(val) {
                return err(&format!("Not a package name: {val}"), 2);
            }
            false
        }
        "webui_theme" => {
            if !matches!(val, "system" | "light" | "dark") {
                return err("webui_theme must be system, light or dark", 2);
            }
            false
        }
        "webui_monet" | "webui_fullscreen" => {
            if val != "0" && val != "1" {
                return err(&format!("{key} must be 0 or 1"), 2);
            }
            false
        }
        _ => return err(&format!("Unknown setting: {key}"), 2),
    };
    if conf::config_set(p, key, val).is_err() {
        return err("Could not save the setting", 1);
    }
    if !reapply {
        return ExitCode::SUCCESS;
    }
    conf::log(p, &format!("Setting changed: {key}={val}"));
    if extras::check(p, nl).is_none() {
        return err("Saved, but another check is still running", 1);
    }
    print_status(p, nl, json);
    ExitCode::SUCCESS
}

fn cleanup(p: &Paths) -> ExitCode {
    daemon::stop(p);
    if std::path::Path::new(&p.run).is_dir() || std::path::Path::new(&p.data).is_dir() {
        if let Ok(nl) = Sock::open() {
            let cfg = Config::load(p);
            let mut a = crate::state::Applied::load(p);
            if let Some(old) = conf::num_in(&a.pref, 1, 32765).map(|v| v as u32).filter(|&o| o != cfg.pref) {
                for fam in [AF_INET, AF_INET6] {
                    reconcile::rule_flush(&nl, fam, old);
                }
            }
            reconcile::remove_all(p, &nl, cfg.pref, &mut a);
        }
    }
    let _ = std::fs::remove_dir_all(&p.run);
    let _ = std::fs::remove_dir_all(&p.data);
    ExitCode::SUCCESS
}

fn watch_line(status: Option<&str>, devices: Option<&str>) -> String {
    let mut o = Obj::new();
    if let Some(s) = status {
        o = o.raw("status", s);
    }
    if let Some(d) = devices {
        o = o.raw("devices", d);
    }
    o.end()
}

fn watch(p: &Paths, nl: &Sock, seconds: u64) -> ExitCode {
    let mut out = std::io::stdout().lock();
    let mut status = status_json(p, nl);
    let mut devices = extras::devices_json(p, nl);
    if writeln!(out, "{}", watch_line(Some(&status), Some(&devices)))
        .and_then(|_| out.flush())
        .is_err()
    {
        return ExitCode::SUCCESS;
    }
    let groups = (1 << 0) | (1 << 2) | (1 << 4) | (1 << 7) | (1 << 8) | (1 << 10) | (1 << 18);
    let Ok((ev, _)) = sys::netlink_socket(groups) else {
        return ExitCode::FAILURE;
    };
    let ino = sys::inotify().ok();
    if let Some(i) = &ino {
        let mask = sys::IN_CLOSE_WRITE | sys::IN_MOVED_TO | sys::IN_CREATE | sys::IN_DELETE;
        for d in [p.run.clone(), p.data.clone(), p.moddir.clone()] {
            let _ = sys::inotify_watch(i, &d, mask);
        }
        if let Some(d) = std::path::Path::new(&p.va_state).parent() {
            let _ = sys::inotify_watch(i, &d.to_string_lossy(), mask);
        }
    }
    let end = Instant::now() + Duration::from_secs(seconds);
    let mut buf = vec![0u8; 1 << 16];
    let mut pending: Option<Instant> = None;
    let mut beat = Instant::now();
    while Instant::now() < end {
        let now = Instant::now();
        let mut wait = end
            .saturating_duration_since(now)
            .min(Duration::from_secs(15).saturating_sub(beat.elapsed()));
        if let Some(t) = pending {
            wait = wait.min((t + Duration::from_millis(200)).saturating_duration_since(now));
        }
        let mut fds = [
            sys::PollFd {
                fd: ev.as_raw_fd(),
                events: sys::POLLIN,
                revents: 0,
            },
            sys::PollFd {
                fd: ino.as_ref().map(|i| i.as_raw_fd()).unwrap_or(-1),
                events: sys::POLLIN,
                revents: 0,
            },
        ];
        let _ = sys::poll_fds(&mut fds, wait.as_millis() as i32);
        if fds[0].revents != 0 {
            loop {
                match sys::netlink_recv(&ev, &mut buf, false) {
                    Ok(n) if n > 0 => {
                        if !nl::messages(&buf[..n]).is_empty() {
                            pending.get_or_insert_with(Instant::now);
                        }
                    }
                    Ok(_) => break,
                    Err(e) if e.raw_os_error() == Some(sys::ENOBUFS) => {
                        pending.get_or_insert_with(Instant::now);
                    }
                    Err(_) => break,
                }
            }
        }
        if fds[1].revents != 0 {
            if let Some(i) = &ino {
                while matches!(sys::read_fd(i.as_raw_fd(), &mut buf), Ok(n) if n > 0) {}
                pending.get_or_insert_with(Instant::now);
            }
        }
        if pending.is_some_and(|t| t.elapsed() >= Duration::from_millis(200)) {
            pending = None;
            let s = status_json(p, nl);
            let d = extras::devices_json(p, nl);
            let s_changed = s != status;
            let d_changed = d != devices;
            if s_changed || d_changed {
                let line = watch_line(s_changed.then_some(s.as_str()), d_changed.then_some(d.as_str()));
                status = s;
                devices = d;
                if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
                    return ExitCode::SUCCESS;
                }
                beat = Instant::now();
            }
        }
        if beat.elapsed() >= Duration::from_secs(15) {
            if writeln!(out).and_then(|_| out.flush()).is_err() {
                return ExitCode::SUCCESS;
            }
            beat = Instant::now();
        }
    }
    ExitCode::SUCCESS
}

const USAGE: &str = "usage: nyxbridge status|apply [--json] | set KEY VALUE [--json] | start | log | report\n       nyxbridge watch [SECONDS] | devices | route DEST [APP] | diag | restart-app [APP]\n       nyxbridge daemon | boot | cleanup | --version";

pub fn main(args: &[String]) -> ExitCode {
    let mut args: Vec<&str> = args.iter().map(String::as_str).collect();
    let json = args.last() == Some(&"--json");
    if json {
        args.pop();
    }
    let p = Paths::from_env();
    match args.as_slice() {
        ["--version"] => {
            println!("nyxbridge {}", version());
            return ExitCode::SUCCESS;
        }
        ["daemon"] => return daemon::run(&p),
        ["boot"] => return daemon::boot(),
        ["cleanup"] => return cleanup(&p),
        _ => {}
    }
    if conf::init_dirs(&p).is_err() {
        return err("Cannot create the module data directories", 1);
    }
    let nl = match Sock::open() {
        Ok(s) => s,
        Err(e) => return err(&format!("Cannot open a netlink socket: {e}"), 1),
    };
    match args.as_slice() {
        ["status"] => print_status(&p, &nl, json),
        ["apply"] => {
            if extras::check(&p, &nl).is_none() {
                return err("Another check is still running; try again", 1);
            }
            print_status(&p, &nl, json);
        }
        ["set", key, val] => return set(&p, &nl, key, val, json),
        ["set", key] => return set(&p, &nl, key, "", json),
        ["set"] => return set(&p, &nl, "", "", json),
        ["start"] => {
            if conf::monitor_enabled(&p) && !daemon::running(&p) && daemon::start(&p) {
                extras::check(&p, &nl);
            }
            print_status(&p, &nl, json);
        }
        ["log"] => {
            let t = conf::read(&p.log);
            let lines: Vec<&str> = t.lines().collect();
            for l in &lines[lines.len().saturating_sub(200)..] {
                println!("{l}");
            }
        }
        ["report"] => {
            extras::check(&p, &nl);
            print!("{}", report(&p, &nl));
        }
        ["watch"] => return watch(&p, &nl, 300),
        ["watch", secs] => return watch(&p, &nl, secs.parse().unwrap_or(300).min(3600)),
        ["devices"] => println!("{}", extras::devices_json(&p, &nl)),
        ["route", dest] => return route(&p, &nl, dest, None),
        ["route", dest, app] => return route(&p, &nl, dest, Some(app)),
        ["diag"] => print!("{}", extras::diag(&p, &nl)),
        ["restart-app"] => {
            let app = Config::load(&p).restart_app;
            if app.is_empty() {
                return err("No app is set to restart", 2);
            }
            return restart(&p, &app);
        }
        ["restart-app", app] => return restart(&p, app),
        _ => return err(USAGE, 2),
    }
    ExitCode::SUCCESS
}

fn route(p: &Paths, nl: &Sock, dest: &str, app: Option<&str>) -> ExitCode {
    match extras::route_json(p, nl, dest, app) {
        Ok(j) => {
            println!("{j}");
            ExitCode::SUCCESS
        }
        Err(e) => err(&e, 1),
    }
}

fn restart(p: &Paths, app: &str) -> ExitCode {
    match extras::restart_app(app, false) {
        Ok(_) => {
            conf::log(p, &format!("Restarted {app} from the WebUI"));
            println!("Restarted {app}");
            ExitCode::SUCCESS
        }
        Err(e) => err(&e, 1),
    }
}
