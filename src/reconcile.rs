use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::time::{Duration, Instant};

use crate::conf::{self, Config, Paths};
use crate::lock;
use crate::nl::Sock;
use crate::rtnl::{self, Sel, AF_INET, AF_INET6, RT_SCOPE_UNIVERSE, RT_TABLE_LOCAL, RT_TABLE_MAIN};
use crate::state::{self, Applied, Reason, State, Va};

pub struct Outcome {
    pub addr_added: bool,
}

pub fn if_index(p: &Paths, br: &str) -> Option<u32> {
    conf::valid_ifname(br)
        .then(|| fs::read_to_string(format!("{}/{br}/ifindex", p.sys_net)).ok())?
        .and_then(|s| s.trim().parse().ok())
}

fn same_instance(p: &Paths, br: &str, idx: &str) -> bool {
    !br.is_empty() && !idx.is_empty() && if_index(p, br).map(|i| i.to_string()).as_deref() == Some(idx)
}

pub fn rules_at(nl: &Sock, family: u8, pref: u32) -> Vec<rtnl::Rule> {
    rtnl::rules(nl, family)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.pref == pref)
        .collect()
}

pub fn rule_flush(nl: &Sock, family: u8, pref: u32) {
    for _ in 0..64 {
        if rtnl::del_rule_pref(nl, family, pref).is_err() {
            break;
        }
    }
}

fn parse_cidr(s: &str) -> Option<(IpAddr, u8)> {
    let (a, l) = s.split_once('/')?;
    Some((a.parse().ok()?, l.parse().ok()?))
}

const KNOBS: [&str; 4] = ["disable_ipv6", "accept_ra", "accept_ra_defrtr", "autoconf"];

fn knob_path(p: &Paths, br: &str, knob: &str) -> String {
    format!("{}/{br}/{knob}", p.proc_v6)
}

fn knob(p: &Paths, br: &str, k: &str) -> String {
    fs::read_to_string(knob_path(p, br, k))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn set_knob(p: &Paths, br: &str, k: &str, v: &str) {
    let _ = fs::write(knob_path(p, br, k), format!("{v}\n"));
}

fn knobs(p: &Paths, br: &str) -> [String; 4] {
    KNOBS.map(|k| knob(p, br, k))
}

fn v6_snapshot(p: &Paths, br: &str) -> String {
    let k = knobs(p, br);
    let ok = conf::num_in(&k[0], 0, 1).is_some()
        && conf::num_in(&k[1], 0, 2).is_some()
        && conf::num_in(&k[2], 0, 1).is_some()
        && conf::num_in(&k[3], 0, 1).is_some();
    if ok {
        k.join(",")
    } else {
        String::new()
    }
}

fn v6_knobs_ok(p: &Paths, br: &str) -> bool {
    knobs(p, br) == ["0", "2", "0", "1"]
}

fn has_v6_global(nl: &Sock, idx: u32) -> bool {
    rtnl::addrs(nl, AF_INET6, idx)
        .unwrap_or_default()
        .iter()
        .any(|a| a.scope == RT_SCOPE_UNIVERSE)
}

fn v6_prepare(p: &Paths, nl: &Sock, br: &str, idx: u32) {
    set_knob(p, br, "accept_ra", "2");
    set_knob(p, br, "accept_ra_defrtr", "0");
    set_knob(p, br, "autoconf", "1");
    for r in rtnl::routes(nl, AF_INET6).unwrap_or_default() {
        if r.dst.is_none() && r.oif == Some(idx) && r.protocol == rtnl::RTPROT_RA {
            let _ = rtnl::del_route(nl, &r);
        }
    }
    if knob(p, br, "disable_ipv6") != "0" {
        set_knob(p, br, "disable_ipv6", "0");
    } else if !has_v6_global(nl, idx) {
        set_knob(p, br, "disable_ipv6", "1");
        set_knob(p, br, "disable_ipv6", "0");
    }
}

fn v6_restore(p: &Paths, nl: &Sock, br: &str, orig: &str) {
    let v: Vec<&str> = orig.split(',').collect();
    let valid = v.len() == 4
        && conf::num_in(v[0], 0, 1).is_some()
        && conf::num_in(v[1], 0, 2).is_some()
        && conf::num_in(v[2], 0, 1).is_some()
        && conf::num_in(v[3], 0, 1).is_some();
    if valid {
        if v[0] == "1" {
            set_knob(p, br, "disable_ipv6", "1");
        }
        set_knob(p, br, "accept_ra", v[1]);
        set_knob(p, br, "accept_ra_defrtr", v[2]);
        set_knob(p, br, "autoconf", v[3]);
    } else {
        for k in ["accept_ra", "accept_ra_defrtr", "autoconf"] {
            if let Ok(d) = fs::read_to_string(format!("{}/default/{k}", p.proc_v6)) {
                set_knob(p, br, k, d.trim());
            }
        }
    }
    if let Some(idx) = if_index(p, br) {
        for a in rtnl::addrs(nl, AF_INET6, idx).unwrap_or_default() {
            if a.scope == RT_SCOPE_UNIVERSE && a.flags & rtnl::IFA_F_PERMANENT == 0 {
                let _ = rtnl::del_addr(nl, idx, a.ip, a.prefixlen);
            }
        }
    }
}

pub struct Target {
    pub key: String,
    pub prefix: Option<(IpAddr, u8)>,
    pub table: u32,
}

impl Target {
    pub fn line(&self) -> String {
        format!("{} lookup {}", self.key, rtnl::table_name(self.table))
    }
}

fn wait_for_prefix(nl: &Sock, br: &str, idx: u32) {
    let end = Instant::now() + Duration::from_millis(3000);
    while Instant::now() < end {
        if v6_targets(nl, br, idx).iter().any(|t| t.prefix.is_some()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn v6_targets(nl: &Sock, br: &str, idx: u32) -> Vec<Target> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for r in rtnl::routes(nl, AF_INET6).unwrap_or_default() {
        if r.oif != Some(idx) || !r.is_unicast() || r.table == RT_TABLE_LOCAL {
            continue;
        }
        let Some((ip, len)) = r.dst else { continue };
        if len == 0 || len >= 128 {
            continue;
        }
        let link_local = matches!(ip, IpAddr::V6(a) if a.segments()[0] == 0xfe80);
        let (key, prefix) = if link_local {
            (format!("oif {br}"), None)
        } else {
            (format!("to {}", rtnl::prefix_text(&ip, len)), Some((ip, len)))
        };
        if seen.insert(key.clone()) {
            out.push(Target {
                key,
                prefix,
                table: r.table,
            });
        }
    }
    out.sort_by_key(|t| t.line());
    out
}

struct Check<'a> {
    p: &'a Paths,
    nl: &'a Sock,
    cfg: Config,
    a: Applied,
    reason: Reason,
    addr_added: bool,
}

impl Check<'_> {
    fn log(&self, m: &str) {
        conf::log(self.p, m);
    }

    fn apply_v4(&mut self, br: &str, base: [u8; 3], idx: u32) -> bool {
        let want_ip = Ipv4Addr::new(base[0], base[1], base[2], self.cfg.host);
        let want = format!("{want_ip}/24");
        let subnet = IpAddr::V4(Ipv4Addr::new(base[0], base[1], base[2], 0));

        if !self.a.a4_addr.is_empty() && self.a.a4_addr != want {
            if let Some((ip, len)) = parse_cidr(&self.a.a4_addr) {
                if rtnl::del_addr(self.nl, idx, ip, len).is_ok() {
                    self.log(&format!("Removed old {} from {br}", self.a.a4_addr));
                }
            }
            self.a.a4_addr.clear();
        }
        let present = rtnl::addrs(self.nl, AF_INET, idx)
            .unwrap_or_default()
            .iter()
            .any(|a| a.ip == IpAddr::V4(want_ip) && a.prefixlen == 24);
        if !present {
            if rtnl::add_addr(self.nl, idx, IpAddr::V4(want_ip), 24).is_ok() {
                self.log(&format!("Added {want} to {br}"));
                self.addr_added = true;
            } else {
                self.reason = Reason::new("addr_failed", want.clone(), format!("Could not add {want} to {br}"));
                self.log(&self.reason.text.clone());
                return false;
            }
        }
        self.a.a4_addr = want;
        self.a.a4_br = br.to_string();
        self.a.a4_idx = idx.to_string();

        let pref = self.cfg.pref;
        let rules = rules_at(self.nl, AF_INET, pref);
        if rules.len() != 1 || !rules[0].is_plain_to(&subnet, 24, RT_TABLE_MAIN) {
            rule_flush(self.nl, AF_INET, pref);
            if rtnl::add_rule(self.nl, AF_INET, pref, Sel::To(subnet, 24), RT_TABLE_MAIN).is_ok() {
                self.log(&format!("Added rule {pref}: to {subnet}/24 lookup main"));
            } else {
                self.reason = Reason::new("rule_failed", "", "Could not add the IPv4 routing rule");
                self.log(&self.reason.text.clone());
                return false;
            }
        }
        true
    }

    fn apply_v6(&mut self, br: &str, idx: u32) -> bool {
        if !Path::new(&format!("{}/{br}", self.p.proc_v6)).is_dir() {
            self.reason = Reason::new("ipv6_unavailable", br, format!("IPv6 is not available on {br}"));
            return false;
        }
        if self.a.a6_idx.is_empty() {
            self.a.a6_orig = v6_snapshot(self.p, br);
            v6_prepare(self.p, self.nl, br, idx);
            self.a.a6_br = br.to_string();
            self.a.a6_idx = idx.to_string();
            self.log(&format!(
                "IPv6 on: {br} now accepts OpenWrt's router advertisements (no default route)"
            ));
            wait_for_prefix(self.nl, br, idx);
        } else if !v6_knobs_ok(self.p, br) {
            v6_prepare(self.p, self.nl, br, idx);
            self.log(&format!("IPv6 settings on {br} were changed by something else; set them again"));
            wait_for_prefix(self.nl, br, idx);
        }
        let targets = v6_targets(self.nl, br, idx);
        let lines: Vec<String> = targets.iter().map(Target::line).collect();
        let sig = lines.join(";");
        let pref = self.cfg.pref;
        if rules_at(self.nl, AF_INET6, pref).len() != targets.len() || sig != self.a.sig6 {
            rule_flush(self.nl, AF_INET6, pref);
            let mut fails = Vec::new();
            for t in &targets {
                let sel = match t.prefix {
                    Some((ip, len)) => Sel::To(ip, len),
                    None => Sel::Oif(br),
                };
                if rtnl::add_rule(self.nl, AF_INET6, pref, sel, t.table).is_err() {
                    fails.push(t.key.clone());
                }
            }
            if sig != self.a.sig6 {
                if lines.is_empty() {
                    self.log(&format!("IPv6: waiting for OpenWrt to announce a prefix on {br}"));
                } else {
                    self.log(&format!("IPv6 rules: {}", lines.join(", ")));
                }
                if !fails.is_empty() {
                    self.log(&format!("IPv6 rule failed: {}", fails.join(", ")));
                }
            }
            self.a.sig6 = sig;
        }
        true
    }

    fn remove_v6_only(&mut self) {
        let pref = self.cfg.pref;
        if !rules_at(self.nl, AF_INET6, pref).is_empty() {
            rule_flush(self.nl, AF_INET6, pref);
            self.log(&format!("Removed IPv6 rules {pref}"));
        }
        if !self.a.a6_idx.is_empty() {
            if same_instance(self.p, &self.a.a6_br, &self.a.a6_idx) {
                v6_restore(self.p, self.nl, &self.a.a6_br, &self.a.a6_orig);
                self.log(&format!("IPv6 off: settings on {} restored", self.a.a6_br));
            }
            self.a.clear_v6();
        }
    }
}

pub fn remove_all(p: &Paths, nl: &Sock, pref: u32, a: &mut Applied) {
    if !rules_at(nl, AF_INET, pref).is_empty() {
        rule_flush(nl, AF_INET, pref);
        conf::log(p, &format!("Removed IPv4 rule {pref}"));
    }
    if !rules_at(nl, AF_INET6, pref).is_empty() {
        rule_flush(nl, AF_INET6, pref);
        conf::log(p, &format!("Removed IPv6 rules {pref}"));
    }
    if !a.a4_addr.is_empty() && same_instance(p, &a.a4_br, &a.a4_idx) {
        if let (Some((ip, len)), Some(idx)) = (parse_cidr(&a.a4_addr), if_index(p, &a.a4_br)) {
            if rtnl::del_addr(nl, idx, ip, len).is_ok() {
                conf::log(p, &format!("Removed {} from {}", a.a4_addr, a.a4_br));
            }
        }
    }
    if !a.a6_idx.is_empty() && same_instance(p, &a.a6_br, &a.a6_idx) {
        v6_restore(p, nl, &a.a6_br, &a.a6_orig);
        conf::log(p, &format!("IPv6 settings on {} restored", a.a6_br));
    }
    *a = Applied::default();
}

fn clear_old_pref(p: &Paths, nl: &Sock, a: &Applied, pref: u32) {
    let Some(old) = conf::num_in(&a.pref, 1, 32765).map(|v| v as u32) else {
        return;
    };
    if old == pref {
        return;
    }
    let mut removed = false;
    for fam in [AF_INET, AF_INET6] {
        if !rules_at(nl, fam, old).is_empty() {
            rule_flush(nl, fam, old);
            removed = true;
        }
    }
    if removed {
        conf::log(
            p,
            &format!("Rule priority changed from {old} to {pref}; removed the rules at {old}"),
        );
    }
}

pub fn reconcile(p: &Paths, nl: &Sock) -> Outcome {
    let cfg = Config::load(p);
    let va = Va::load(p);
    let was = Applied::load(p);
    let mut c = Check {
        p,
        nl,
        cfg,
        a: was.clone(),
        reason: Reason::default(),
        addr_added: false,
    };
    let br = va.bridge.clone();
    let mut st = State::Inactive;
    let mut base = [0u8; 3];

    clear_old_pref(p, nl, &c.a, c.cfg.pref);
    c.a.pref = c.cfg.pref.to_string();

    if p.module_flagged() {
        c.reason = Reason::new("module_disabled", "", "Module is disabled in the root manager");
    } else if !c.cfg.enabled {
        c.reason = Reason::new("turned_off", "", "Turned off in settings");
    } else if va.mode == "stopped" {
        c.reason = Reason::new("va_stopped", "", "VirtualAP is not running");
    } else if va.mode != "bridged" {
        c.reason = Reason::new(
            "va_routed",
            "",
            "VirtualAP is in routed mode (the phone is already the gateway there)",
        );
    } else if let Some((b, gwo)) = conf::parse_gw(&va.gateway) {
        if !Path::new(&format!("{}/{br}", p.sys_net)).is_dir() {
            c.reason = Reason::new("waiting_bridge", br.clone(), format!("Waiting for {br}"));
        } else if c.cfg.host == gwo {
            st = State::Error;
            let h = c.cfg.host;
            c.reason = Reason::new(
                "host_is_gateway",
                format!(".{h}"),
                format!("Phone address .{h} is the gateway's address; pick another"),
            );
        } else {
            st = State::Active;
            base = b;
        }
    } else {
        c.reason = Reason::new("bad_gateway", "", "VirtualAP's gateway address is missing or invalid");
    }

    if st == State::Active {
        match if_index(p, &br) {
            Some(idx) => {
                let ids = idx.to_string();
                if c.a.a4_br != br || c.a.a4_idx != ids {
                    c.a.a4_addr.clear();
                }
                if c.a.a6_br != br || c.a.a6_idx != ids {
                    c.a.clear_v6();
                }
                if !c.apply_v4(&br, base, idx) {
                    st = State::Error;
                } else if c.cfg.ipv6 {
                    if !c.apply_v6(&br, idx) {
                        st = State::Error;
                    }
                } else {
                    c.remove_v6_only();
                }
            }
            None => {
                st = State::Inactive;
                c.reason = Reason::new("waiting_bridge", br.clone(), format!("Waiting for {br}"));
                remove_all(p, nl, c.cfg.pref, &mut c.a);
                c.a.pref = c.cfg.pref.to_string();
            }
        }
    } else {
        remove_all(p, nl, c.cfg.pref, &mut c.a);
        c.a.pref = c.cfg.pref.to_string();
    }

    c.a.save(p, &was);
    state::write_status(p, st, &c.reason, &br, &c.a.a4_addr);
    Outcome { addr_added: c.addr_added }
}

pub fn reconcile_locked(p: &Paths, nl: &Sock) -> Option<Outcome> {
    let _guard = lock::acquire(&p.reconcile_lock, 20_000)?;
    Some(reconcile(p, nl))
}
