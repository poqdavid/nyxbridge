use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const DEFAULT_BRIDGE: &str = "vap-br0";
pub const DEFAULT_PREF: u32 = 7001;
const MODDIR_FALLBACK: &str = "/data/adb/modules/nyxbridge";

#[derive(Clone, Debug)]
pub struct Paths {
    pub moddir: String,
    pub data: String,
    pub run: String,
    pub va_state: String,
    pub sys_net: String,
    pub proc_v6: String,
    pub cgroups: Vec<String>,
    pub module_prop: String,
    pub packages_list: String,
    pub conf: String,
    pub log: String,
    pub applied: String,
    pub status: String,
    pub daemon_lock: String,
    pub daemon_pid: String,
    pub reconcile_lock: String,
    pub monitor_lock: String,
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn moddir() -> String {
    if let Ok(d) = std::env::var("NYXB_MODDIR") {
        if !d.is_empty() {
            return d;
        }
    }
    let exe = std::env::current_exe().ok();
    match exe.as_deref().and_then(Path::parent) {
        Some(bin) if bin.ends_with("bin") => bin
            .parent()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_else(|| MODDIR_FALLBACK.into()),
        _ => MODDIR_FALLBACK.into(),
    }
}

impl Paths {
    pub fn from_env() -> Paths {
        let moddir = moddir();
        let data = env_or("NYXB_DATA_DIR", "/data/adb/nyxbridge");
        let run = env_or("NYXB_RUN_DIR", "/dev/nyxbridge");
        let cgroups = env_or("NYXB_CGROUP_ROOTS", "/acct /dev/cg2_bpf /sys/fs/cgroup /dev/memcg/apps")
            .split_whitespace()
            .map(String::from)
            .collect();
        Paths {
            module_prop: env_or("NYXB_MODULE_PROP", &format!("{moddir}/module.prop")),
            va_state: env_or("NYXB_VA_STATE", "/data/local/virtualap/run.state"),
            sys_net: env_or("NYXB_SYS_NET", "/sys/class/net"),
            proc_v6: env_or("NYXB_PROC_V6", "/proc/sys/net/ipv6/conf"),
            packages_list: env_or("NYXB_PACKAGES_LIST", "/data/system/packages.list"),
            cgroups,
            conf: format!("{data}/config.sh"),
            log: format!("{data}/nyxbridge.log"),
            applied: format!("{run}/applied"),
            status: format!("{run}/status"),
            daemon_lock: format!("{run}/daemon.lock"),
            daemon_pid: format!("{run}/daemon.pid"),
            reconcile_lock: format!("{run}/reconcile.lock"),
            monitor_lock: format!("{run}/monitor.lock"),
            moddir,
            data,
            run,
        }
    }

    pub fn module_flagged(&self) -> bool {
        Path::new(&format!("{}/disable", self.moddir)).exists() || Path::new(&format!("{}/remove", self.moddir)).exists()
    }
}

pub fn kv(text: &str, key: &str) -> String {
    for line in text.split('\n') {
        if let Some(v) = line.strip_prefix(key).and_then(|r| r.strip_prefix('=')) {
            return v.strip_suffix('\r').unwrap_or(v).to_string();
        }
    }
    String::new()
}

pub fn read(path: &str) -> String {
    fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

pub fn write_atomic(path: &str, text: &str, mode: Option<u32>) -> io::Result<()> {
    let tmp = format!("{path}.{}", std::process::id());
    let r = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        if let Some(m) = mode {
            f.set_permissions(fs::Permissions::from_mode(m))?;
        }
        fs::rename(&tmp, path)
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

pub fn num_in(s: &str, min: u64, max: u64) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) || s.len() > 10 {
        return None;
    }
    let v: u64 = s.parse().ok()?;
    (min..=max).contains(&v).then_some(v)
}

pub fn valid_ifname(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 15
        && s != "."
        && s != ".."
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

pub fn parse_gw(s: &str) -> Option<([u8; 3], u8)> {
    let p: Vec<&str> = s.split('.').collect();
    if p.len() != 4 {
        return None;
    }
    let a = num_in(p[0], 0, 255)? as u8;
    let b = num_in(p[1], 0, 255)? as u8;
    let c = num_in(p[2], 0, 255)? as u8;
    let d = num_in(p[3], 1, 254)? as u8;
    Some(([a, b, c], d))
}

pub fn valid_package(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() >= 2
        && s.len() <= 255
        && parts.iter().all(|p| {
            let mut b = p.bytes();
            matches!(b.next(), Some(c) if c.is_ascii_alphabetic()) && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub enabled: bool,
    pub ipv6: bool,
    pub host: u8,
    pub pref: u32,
    pub restart_app: String,
}

pub fn cfg_value(text: &str, key: &str) -> String {
    let v = kv(text, key);
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        v[1..v.len() - 1].to_string()
    } else {
        v
    }
}

impl Config {
    pub fn parse(text: &str) -> Config {
        let flag = |k: &str, def: bool| match cfg_value(text, k).as_str() {
            "0" => false,
            "1" => true,
            _ => def,
        };
        let app = cfg_value(text, "restart_app");
        Config {
            enabled: flag("enabled", true),
            ipv6: flag("ipv6", false),
            host: num_in(&cfg_value(text, "host_octet"), 1, 254).unwrap_or(2) as u8,
            pref: num_in(&cfg_value(text, "rule_pref"), 1, 32765).unwrap_or(DEFAULT_PREF as u64) as u32,
            restart_app: if valid_package(&app) { app } else { String::new() },
        }
    }

    pub fn load(p: &Paths) -> Config {
        Config::parse(&read(&p.conf))
    }
}

pub fn monitor_enabled(p: &Paths) -> bool {
    cfg_value(&read(&p.conf), "monitor") != "0"
}

const INLINE_DEFAULTS: &str =
    "enabled=1\nmonitor=1\nipv6=0\nhost_octet=2\nrule_pref=7001\nrestart_app=\nwebui_theme=system\nwebui_monet=1\nwebui_fullscreen=1\n";

pub fn write_default_config(p: &Paths) -> io::Result<()> {
    let text = fs::read_to_string(format!("{}/config.sh", p.moddir)).unwrap_or_else(|_| INLINE_DEFAULTS.to_string());
    write_atomic(&p.conf, &text, Some(0o600))
}

pub fn config_set(p: &Paths, key: &str, value: &str) -> io::Result<()> {
    if !Path::new(&p.conf).is_file() {
        write_default_config(p)?;
    }
    let old = read(&p.conf);
    let mut out = String::new();
    let mut found = false;
    let body = old.strip_suffix('\n').unwrap_or(&old);
    if !old.is_empty() {
        for line in body.split('\n') {
            if line.strip_prefix(key).is_some_and(|r| r.starts_with('=')) {
                if !found {
                    out.push_str(&format!("{key}={value}\n"));
                }
                found = true;
            } else {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if !found {
        out.push_str(&format!("{key}={value}\n"));
    }
    write_atomic(&p.conf, &out, Some(0o600))
}

/// Create the data and run folders (root only) and a default config.
pub fn init_dirs(p: &Paths) -> io::Result<()> {
    for d in [&p.data, &p.run] {
        fs::create_dir_all(d)?;
        let _ = fs::set_permissions(d, fs::Permissions::from_mode(0o700));
    }
    if !Path::new(&p.conf).is_file() {
        write_default_config(p)?;
    }
    Ok(())
}

fn utc_offset() -> i64 {
    static CACHE: Mutex<Option<(Instant, i64)>> = Mutex::new(None);
    let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, off)) = *c {
        if at.elapsed().as_secs() < 600 {
            return off;
        }
    }
    let off = std::process::Command::new("date")
        .arg("+%z")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .and_then(|o| parse_offset(String::from_utf8_lossy(&o.stdout).trim()))
        .unwrap_or(0);
    *c = Some((Instant::now(), off));
    off
}

fn parse_offset(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 5 || !(b[0] == b'+' || b[0] == b'-') {
        return None;
    }
    let h: i64 = s[1..3].parse().ok()?;
    let m: i64 = s[3..5].parse().ok()?;
    let v = h * 3600 + m * 60;
    Some(if b[0] == b'-' { -v } else { v })
}

fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn format_time(unix: i64) -> String {
    let (y, m, d) = civil(unix.div_euclid(86_400));
    let s = unix.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

pub fn now_text() -> String {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_time(unix + utc_offset())
}

pub fn log(p: &Paths, msg: &str) {
    let line = format!("{} {msg}\n", now_text());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p.log) {
        let _ = f.write_all(line.as_bytes());
    }
    if fs::metadata(&p.log).map(|m| m.len() > 65_536).unwrap_or(false) {
        let text = read(&p.log);
        let lines: Vec<&str> = text.lines().collect();
        let keep = lines[lines.len().saturating_sub(300)..].join("\n") + "\n";
        let _ = write_atomic(&p.log, &keep, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kv_takes_the_first_match_and_drops_cr() {
        let t = "# x=1\nmode=bridged\r\nbridge=vap-br0\nmode=routed\ngateway=192.168.42.1";
        assert_eq!(kv(t, "mode"), "bridged");
        assert_eq!(kv(t, "gateway"), "192.168.42.1");
        assert_eq!(kv(t, "x"), "");
        assert_eq!(kv("modex=1\nmode=2", "mode"), "2");
    }

    #[test]
    fn config_defaults_and_validation() {
        let c = Config::parse("");
        assert_eq!(
            c,
            Config {
                enabled: true,
                ipv6: false,
                host: 2,
                pref: 7001,
                restart_app: String::new()
            }
        );
        let c = Config::parse("enabled='0'\nipv6=1\nhost_octet=050\nrule_pref=40000\nrestart_app=org.localsend.localsend_app");
        assert_eq!(
            c,
            Config {
                enabled: false,
                ipv6: true,
                host: 2,
                pref: 7001,
                restart_app: "org.localsend.localsend_app".into()
            }
        );
        let c = Config::parse("enabled=yes\nipv6=2\nhost_octet=254\nrule_pref=6500\nrestart_app=bad pkg");
        assert_eq!(
            c,
            Config {
                enabled: true,
                ipv6: false,
                host: 254,
                pref: 6500,
                restart_app: String::new()
            }
        );
        assert_eq!(Config::parse("host_octet=0").host, 2);
        assert_eq!(Config::parse("host_octet=255").host, 2);
    }

    #[test]
    fn numbers_gateways_and_names() {
        assert_eq!(num_in("0", 0, 5), Some(0));
        assert_eq!(num_in("05", 0, 9), None);
        assert_eq!(num_in("", 0, 9), None);
        assert_eq!(num_in("-1", 0, 9), None);
        assert_eq!(num_in("99999999999", 0, u64::MAX), None);
        assert_eq!(parse_gw("192.168.42.1"), Some(([192, 168, 42], 1)));
        for bad in [
            "192.168.42",
            "192.168.42.1.5",
            "192.168.042.1",
            "192.168.42.0",
            "192.168.42.255",
            "a.b.c.d",
            "",
            "1..2.3",
        ] {
            assert_eq!(parse_gw(bad), None, "{bad}");
        }
        assert!(valid_ifname("vap-br0"));
        for bad in ["", ".", "..", "a/b", "abcdefghijklmnop", "br 0", "ä"] {
            assert!(!valid_ifname(bad), "{bad}");
        }
        assert!(valid_package("org.localsend.localsend_app"));
        for bad in ["localsend", "org..x", "1org.x", "org.x;rm", "org.x-y"] {
            assert!(!valid_package(bad), "{bad}");
        }
    }

    #[test]
    fn time_formatting() {
        assert_eq!(format_time(0), "1970-01-01 00:00:00");
        assert_eq!(format_time(1_791_040_000), "2026-10-03 15:06:40");
        assert_eq!(format_time(951_782_400), "2000-02-29 00:00:00");
        assert_eq!(parse_offset("+0200"), Some(7200));
        assert_eq!(parse_offset("-0530"), Some(-19800));
        assert_eq!(parse_offset("UTC"), None);
    }
}
