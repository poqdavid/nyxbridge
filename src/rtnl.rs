use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::nl::{self, Msg, Sock, NLM_F_CREATE, NLM_F_EXCL, NLM_F_REQUEST};

pub const AF_INET: u8 = 2;
pub const AF_INET6: u8 = 10;
const AF_UNSPEC: u8 = 0;
const AF_BRIDGE: u8 = 7;

pub const RTM_NEWLINK: u16 = 16;
pub const RTM_DELLINK: u16 = 17;
pub const RTM_NEWADDR: u16 = 20;
pub const RTM_DELADDR: u16 = 21;
const RTM_GETADDR: u16 = 22;
pub const RTM_NEWROUTE: u16 = 24;
pub const RTM_DELROUTE: u16 = 25;
const RTM_GETROUTE: u16 = 26;
pub const RTM_NEWNEIGH: u16 = 28;
const RTM_GETNEIGH: u16 = 30;
pub const RTM_NEWRULE: u16 = 32;
pub const RTM_DELRULE: u16 = 33;
const RTM_GETRULE: u16 = 34;

const IFA_ADDRESS: u16 = 1;
const IFA_LOCAL: u16 = 2;
const IFA_FLAGS: u16 = 8;
pub const IFA_F_PERMANENT: u32 = 0x80;
pub const RT_SCOPE_UNIVERSE: u8 = 0;

const RTA_DST: u16 = 1;
const RTA_OIF: u16 = 4;
const RTA_GATEWAY: u16 = 5;
const RTA_PRIORITY: u16 = 6;
const RTA_PREFSRC: u16 = 7;
const RTA_TABLE: u16 = 15;
const RTA_UID: u16 = 25;
const RTN_UNICAST: u8 = 1;
pub const RTPROT_RA: u8 = 9;
const RTM_F_LOOKUP_TABLE: u32 = 0x1000;
pub const RT_TABLE_MAIN: u32 = 254;
pub const RT_TABLE_LOCAL: u32 = 255;
const RT_TABLE_DEFAULT: u32 = 253;

const FRA_DST: u16 = 1;
const FRA_SRC: u16 = 2;
const FRA_IIFNAME: u16 = 3;
const FRA_GOTO: u16 = 4;
const FRA_PRIORITY: u16 = 6;
const FRA_FWMARK: u16 = 10;
const FRA_SUPPRESS_PREFIXLEN: u16 = 14;
const FRA_TABLE: u16 = 15;
const FRA_FWMASK: u16 = 16;
const FRA_OIFNAME: u16 = 17;
const FRA_L3MDEV: u16 = 19;
const FRA_UID_RANGE: u16 = 20;
const FRA_PROTOCOL: u16 = 21;
const FRA_IP_PROTO: u16 = 22;
const FRA_SPORT_RANGE: u16 = 23;
const FRA_DPORT_RANGE: u16 = 24;
const FR_ACT_TO_TBL: u8 = 1;
const FR_ACT_GOTO: u8 = 2;
const FR_ACT_NOP: u8 = 3;
const FR_ACT_BLACKHOLE: u8 = 6;
const FR_ACT_UNREACHABLE: u8 = 7;
const FR_ACT_PROHIBIT: u8 = 8;
const FIB_RULE_INVERT: u32 = 0x2;

const NDA_DST: u16 = 1;
const NDA_LLADDR: u16 = 2;
const NDA_MASTER: u16 = 9;

const IFLA_IFNAME: u16 = 3;

fn ip_of(family: u8, data: &[u8]) -> Option<IpAddr> {
    match family {
        AF_INET => Some(IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(data.get(..4)?).ok()?))),
        AF_INET6 => Some(IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(data.get(..16)?).ok()?))),
        _ => None,
    }
}

fn ip_bytes(ip: &IpAddr) -> Vec<u8> {
    match ip {
        IpAddr::V4(a) => a.octets().to_vec(),
        IpAddr::V6(a) => a.octets().to_vec(),
    }
}

fn family_of(ip: &IpAddr) -> u8 {
    if ip.is_ipv4() {
        AF_INET
    } else {
        AF_INET6
    }
}

fn max_len(family: u8) -> u8 {
    if family == AF_INET {
        32
    } else {
        128
    }
}

pub fn prefix_text(ip: &IpAddr, len: u8) -> String {
    if len == max_len(family_of(ip)) {
        ip.to_string()
    } else {
        format!("{ip}/{len}")
    }
}

pub fn table_name(t: u32) -> String {
    match t {
        RT_TABLE_MAIN => "main".into(),
        RT_TABLE_LOCAL => "local".into(),
        RT_TABLE_DEFAULT => "default".into(),
        n => n.to_string(),
    }
}

fn ifaddrmsg(family: u8, prefixlen: u8, scope: u8, index: u32) -> [u8; 8] {
    let mut b = [0u8; 8];
    b[0] = family;
    b[1] = prefixlen;
    b[3] = scope;
    b[4..8].copy_from_slice(&index.to_ne_bytes());
    b
}

#[derive(Clone, Debug)]
pub struct Addr {
    pub index: u32,
    pub ip: IpAddr,
    pub prefixlen: u8,
    pub scope: u8,
    pub flags: u32,
}

fn parse_addr(p: &[u8]) -> Option<Addr> {
    let fixed = p.get(..8)?;
    let family = fixed[0];
    let mut flags = fixed[2] as u32;
    let mut local = None;
    let mut address = None;
    for (ty, d) in nl::attrs(p.get(8..)?) {
        match ty {
            IFA_LOCAL => local = ip_of(family, d),
            IFA_ADDRESS => address = ip_of(family, d),
            IFA_FLAGS => flags = nl::u32_of(d).unwrap_or(flags),
            _ => {}
        }
    }
    Some(Addr {
        index: u32::from_ne_bytes(fixed[4..8].try_into().ok()?),
        ip: local.or(address)?,
        prefixlen: fixed[1],
        scope: fixed[3],
        flags,
    })
}

pub fn addrs(s: &Sock, family: u8, index: u32) -> io::Result<Vec<Addr>> {
    let out = s.dump(RTM_GETADDR, &ifaddrmsg(family, 0, 0, 0))?;
    Ok(out
        .iter()
        .filter(|(t, p)| *t == RTM_NEWADDR && p.first() == Some(&family))
        .filter_map(|(_, p)| parse_addr(p))
        .filter(|a| a.index == index)
        .collect())
}

pub fn add_addr(s: &Sock, index: u32, ip: IpAddr, len: u8) -> io::Result<()> {
    s.exec(add_addr_msg(index, ip, len))
}

fn add_addr_msg(index: u32, ip: IpAddr, len: u8) -> Msg {
    let b = ip_bytes(&ip);
    Msg::new(
        RTM_NEWADDR,
        NLM_F_REQUEST | NLM_F_CREATE | NLM_F_EXCL,
        &ifaddrmsg(family_of(&ip), len, RT_SCOPE_UNIVERSE, index),
    )
    .attr(IFA_LOCAL, &b)
    .attr(IFA_ADDRESS, &b)
}

pub fn del_addr(s: &Sock, index: u32, ip: IpAddr, len: u8) -> io::Result<()> {
    let b = ip_bytes(&ip);
    let m = Msg::new(RTM_DELADDR, NLM_F_REQUEST, &ifaddrmsg(family_of(&ip), len, 0, index))
        .attr(IFA_LOCAL, &b)
        .attr(IFA_ADDRESS, &b);
    s.exec(m)
}

#[derive(Clone, Debug, Default)]
pub struct Rule {
    pub pref: u32,
    pub table: u32,
    pub action: u8,
    pub flags: u32,
    pub dst: Option<(IpAddr, u8)>,
    pub src: Option<(IpAddr, u8)>,
    pub iif: Option<String>,
    pub oif: Option<String>,
    pub fwmark: Option<u32>,
    pub fwmask: Option<u32>,
    pub uid_range: Option<(u32, u32)>,
    pub goto: Option<u32>,
    pub suppress_prefixlen: Option<u32>,
    pub tos: u8,
    pub extra: bool,
}

impl Rule {
    pub fn text(&self) -> String {
        let mut s = String::new();
        if self.flags & FIB_RULE_INVERT != 0 {
            s.push_str("not ");
        }
        match &self.src {
            Some((ip, len)) => s.push_str(&format!("from {}", prefix_text(ip, *len))),
            None => s.push_str("from all"),
        }
        if let Some((ip, len)) = &self.dst {
            s.push_str(&format!(" to {}", prefix_text(ip, *len)));
        }
        if self.tos != 0 {
            s.push_str(&format!(" tos 0x{:x}", self.tos));
        }
        if let Some(m) = self.fwmark {
            match self.fwmask {
                Some(k) if k != u32::MAX => s.push_str(&format!(" fwmark 0x{m:x}/0x{k:x}")),
                _ => s.push_str(&format!(" fwmark 0x{m:x}")),
            }
        }
        if let Some(i) = &self.iif {
            s.push_str(&format!(" iif {i}"));
        }
        if let Some(o) = &self.oif {
            s.push_str(&format!(" oif {o}"));
        }
        if let Some((a, b)) = self.uid_range {
            s.push_str(&format!(" uidrange {a}-{b}"));
        }
        match self.action {
            FR_ACT_TO_TBL => s.push_str(&format!(" lookup {}", table_name(self.table))),
            FR_ACT_GOTO => s.push_str(&format!(" goto {}", self.goto.unwrap_or(0))),
            FR_ACT_NOP => s.push_str(" nop"),
            FR_ACT_BLACKHOLE => s.push_str(" blackhole"),
            FR_ACT_UNREACHABLE => s.push_str(" unreachable"),
            FR_ACT_PROHIBIT => s.push_str(" prohibit"),
            a => s.push_str(&format!(" action {a}")),
        }
        if let Some(p) = self.suppress_prefixlen {
            s.push_str(&format!(" suppress_prefixlength {p}"));
        }
        s
    }

    pub fn is_plain_to(&self, ip: &IpAddr, len: u8, table: u32) -> bool {
        self.action == FR_ACT_TO_TBL
            && self.table == table
            && self.dst == Some((*ip, len))
            && self.src.is_none()
            && self.iif.is_none()
            && self.oif.is_none()
            && self.fwmark.is_none()
            && self.uid_range.is_none()
            && self.suppress_prefixlen.is_none()
            && self.tos == 0
            && !self.extra
            && self.flags & FIB_RULE_INVERT == 0
    }
}

fn parse_rule(p: &[u8]) -> Option<Rule> {
    let h = p.get(..12)?;
    let family = h[0];
    let mut r = Rule {
        table: h[4] as u32,
        tos: h[3],
        action: h[7],
        flags: u32::from_ne_bytes(h[8..12].try_into().ok()?),
        ..Default::default()
    };
    let (dst_len, src_len) = (h[1], h[2]);
    for (ty, d) in nl::attrs(p.get(12..)?) {
        match ty {
            FRA_PRIORITY => r.pref = nl::u32_of(d).unwrap_or(0),
            FRA_TABLE => r.table = nl::u32_of(d).unwrap_or(r.table),
            FRA_DST => r.dst = ip_of(family, d).map(|ip| (ip, dst_len)),
            FRA_SRC => r.src = ip_of(family, d).map(|ip| (ip, src_len)),
            FRA_IIFNAME => r.iif = Some(nl::str_of(d)),
            FRA_OIFNAME => r.oif = Some(nl::str_of(d)),
            FRA_FWMARK => r.fwmark = nl::u32_of(d),
            FRA_FWMASK => r.fwmask = nl::u32_of(d),
            FRA_GOTO => r.goto = nl::u32_of(d),
            FRA_SUPPRESS_PREFIXLEN => r.suppress_prefixlen = nl::u32_of(d).filter(|&v| v != u32::MAX),
            FRA_UID_RANGE => {
                if let (Some(a), Some(b)) = (d.get(..4), d.get(4..8)) {
                    r.uid_range = Some((nl::u32_of(a).unwrap_or(0), nl::u32_of(b).unwrap_or(0)));
                }
            }
            FRA_L3MDEV | FRA_IP_PROTO | FRA_SPORT_RANGE | FRA_DPORT_RANGE => r.extra = true,
            FRA_PROTOCOL => {}
            _ => {}
        }
    }
    Some(r)
}

pub fn rules(s: &Sock, family: u8) -> io::Result<Vec<Rule>> {
    let mut h = [0u8; 12];
    h[0] = family;
    let out = s.dump(RTM_GETRULE, &h)?;
    let mut v: Vec<Rule> = out
        .iter()
        .filter(|(t, p)| *t == RTM_NEWRULE && p.first() == Some(&family))
        .filter_map(|(_, p)| parse_rule(p))
        .collect();
    v.sort_by_key(|r| r.pref);
    Ok(v)
}

pub enum Sel<'a> {
    To(IpAddr, u8),
    Oif(&'a str),
}

pub fn add_rule(s: &Sock, family: u8, pref: u32, sel: Sel, table: u32) -> io::Result<()> {
    s.exec(add_rule_msg(family, pref, sel, table))
}

fn add_rule_msg(family: u8, pref: u32, sel: Sel, table: u32) -> Msg {
    let mut h = [0u8; 12];
    h[0] = family;
    h[4] = if table < 256 { table as u8 } else { 0 };
    h[7] = FR_ACT_TO_TBL;
    if let Sel::To(_, len) = &sel {
        h[1] = *len;
    }
    let mut m = Msg::new(RTM_NEWRULE, NLM_F_REQUEST | NLM_F_CREATE | NLM_F_EXCL, &h).attr_u32(FRA_PRIORITY, pref);
    m = match sel {
        Sel::To(ip, _) => m.attr(FRA_DST, &ip_bytes(&ip)),
        Sel::Oif(name) => m.attr_str(FRA_OIFNAME, name),
    };
    if table >= 256 {
        m = m.attr_u32(FRA_TABLE, table);
    }
    m
}

pub fn del_rule_pref(s: &Sock, family: u8, pref: u32) -> io::Result<()> {
    let mut h = [0u8; 12];
    h[0] = family;
    s.exec(Msg::new(RTM_DELRULE, NLM_F_REQUEST, &h).attr_u32(FRA_PRIORITY, pref))
}

#[derive(Clone, Debug)]
pub struct Route {
    pub family: u8,
    pub dst: Option<(IpAddr, u8)>,
    pub table: u32,
    pub protocol: u8,
    pub scope: u8,
    pub rtype: u8,
    pub oif: Option<u32>,
    pub gateway: Option<IpAddr>,
    pub metric: Option<u32>,
    pub prefsrc: Option<IpAddr>,
}

impl Route {
    pub fn is_unicast(&self) -> bool {
        self.rtype == RTN_UNICAST
    }
}

fn parse_route(p: &[u8]) -> Option<Route> {
    let h = p.get(..12)?;
    let family = h[0];
    let mut r = Route {
        family,
        dst: None,
        table: h[4] as u32,
        protocol: h[5],
        scope: h[6],
        rtype: h[7],
        oif: None,
        gateway: None,
        metric: None,
        prefsrc: None,
    };
    let dst_len = h[1];
    for (ty, d) in nl::attrs(p.get(12..)?) {
        match ty {
            RTA_DST => r.dst = ip_of(family, d).map(|ip| (ip, dst_len)),
            RTA_OIF => r.oif = nl::u32_of(d),
            RTA_GATEWAY => r.gateway = ip_of(family, d),
            RTA_PRIORITY => r.metric = nl::u32_of(d),
            RTA_PREFSRC => r.prefsrc = ip_of(family, d),
            RTA_TABLE => r.table = nl::u32_of(d).unwrap_or(r.table),
            _ => {}
        }
    }
    if r.dst.is_none() && dst_len != 0 {
        r.dst = Some((
            if family == AF_INET {
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            } else {
                IpAddr::V6(Ipv6Addr::UNSPECIFIED)
            },
            dst_len,
        ));
    }
    Some(r)
}

pub fn routes(s: &Sock, family: u8) -> io::Result<Vec<Route>> {
    let mut h = [0u8; 12];
    h[0] = family;
    let out = s.dump(RTM_GETROUTE, &h)?;
    Ok(out
        .iter()
        .filter(|(t, p)| *t == RTM_NEWROUTE && p.first() == Some(&family))
        .filter_map(|(_, p)| parse_route(p))
        .collect())
}

pub fn del_route(s: &Sock, r: &Route) -> io::Result<()> {
    let mut h = [0u8; 12];
    h[0] = r.family;
    h[1] = r.dst.map(|(_, l)| l).unwrap_or(0);
    h[4] = if r.table < 256 { r.table as u8 } else { 0 };
    h[5] = r.protocol;
    h[6] = r.scope;
    h[7] = r.rtype;
    let mut m = Msg::new(RTM_DELROUTE, NLM_F_REQUEST, &h).attr_u32(RTA_TABLE, r.table);
    if let Some((ip, _)) = &r.dst {
        m = m.attr(RTA_DST, &ip_bytes(ip));
    }
    if let Some(o) = r.oif {
        m = m.attr_u32(RTA_OIF, o);
    }
    if let Some(g) = &r.gateway {
        m = m.attr(RTA_GATEWAY, &ip_bytes(g));
    }
    if let Some(p) = r.metric {
        m = m.attr_u32(RTA_PRIORITY, p);
    }
    s.exec(m)
}

pub fn route_get(s: &Sock, dst: IpAddr, uid: Option<u32>) -> io::Result<Route> {
    let family = family_of(&dst);
    let mut h = [0u8; 12];
    h[0] = family;
    h[1] = max_len(family);
    h[8..12].copy_from_slice(&RTM_F_LOOKUP_TABLE.to_ne_bytes());
    let mut m = Msg::new(RTM_GETROUTE, NLM_F_REQUEST, &h).attr(RTA_DST, &ip_bytes(&dst));
    if let Some(u) = uid {
        m = m.attr_u32(RTA_UID, u);
    }
    let out = s.query(m)?;
    out.iter()
        .filter(|(t, p)| *t == RTM_NEWROUTE && p.first() == Some(&family))
        .find_map(|(_, p)| parse_route(p))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no route"))
}

#[derive(Clone, Debug)]
pub struct Neigh {
    pub ip: IpAddr,
    pub mac: Option<String>,
    pub state: u16,
}

pub const NUD_INCOMPLETE: u16 = 0x01;
pub const NUD_FAILED: u16 = 0x20;
pub const NUD_NOARP: u16 = 0x40;
pub const NUD_PERMANENT: u16 = 0x80;

pub fn neighbours(s: &Sock, index: u32) -> io::Result<Vec<Neigh>> {
    let h = [AF_UNSPEC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let out = s.dump(RTM_GETNEIGH, &h)?;
    let mut v = Vec::new();
    for (t, p) in &out {
        if *t != RTM_NEWNEIGH || p.len() < 12 {
            continue;
        }
        let family = p[0];
        let ifindex = i32::from_ne_bytes(p[4..8].try_into().unwrap_or([0; 4])) as u32;
        if ifindex != index {
            continue;
        }
        let state = u16::from_ne_bytes([p[8], p[9]]);
        let mut ip = None;
        let mut mac = None;
        for (ty, d) in nl::attrs(&p[12..]) {
            match ty {
                NDA_DST => ip = ip_of(family, d),
                NDA_LLADDR if d.len() == 6 => mac = Some(mac_text(d)),
                _ => {}
            }
        }
        if let Some(ip) = ip {
            v.push(Neigh { ip, mac, state });
        }
    }
    Ok(v)
}

fn mac_text(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

pub fn bridge_macs(s: &Sock, bridge: u32) -> io::Result<Vec<String>> {
    let h = [AF_BRIDGE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let out = s.dump(RTM_GETNEIGH, &h)?;
    let mut v = Vec::new();
    for (t, p) in &out {
        if *t != RTM_NEWNEIGH || p.len() < 12 || p[0] != AF_BRIDGE {
            continue;
        }
        let state = u16::from_ne_bytes([p[8], p[9]]);
        if state & (NUD_PERMANENT | NUD_NOARP) != 0 {
            continue;
        }
        let mut mac = None;
        let mut master = None;
        for (ty, d) in nl::attrs(&p[12..]) {
            match ty {
                NDA_LLADDR if d.len() == 6 && d[0] & 1 == 0 => mac = Some(mac_text(d)),
                NDA_MASTER => master = nl::u32_of(d),
                _ => {}
            }
        }
        if let (Some(m), Some(b)) = (mac, master) {
            if b == bridge && !v.contains(&m) {
                v.push(m);
            }
        }
    }
    Ok(v)
}

#[derive(Debug, PartialEq)]
pub enum Event {
    Link { index: u32, name: Option<String> },
    Addr { index: u32 },
    Route { oif: Option<u32> },
    Rule { pref: u32 },
    Other,
}

pub fn classify(ty: u16, p: &[u8]) -> Event {
    match ty {
        RTM_NEWLINK | RTM_DELLINK if p.len() >= 16 => {
            let index = i32::from_ne_bytes(p[4..8].try_into().unwrap_or([0; 4])) as u32;
            let name = nl::attrs(&p[16..])
                .into_iter()
                .find(|(t, _)| *t == IFLA_IFNAME)
                .map(|(_, d)| nl::str_of(d));
            Event::Link { index, name }
        }
        RTM_NEWADDR | RTM_DELADDR if p.len() >= 8 => Event::Addr {
            index: u32::from_ne_bytes(p[4..8].try_into().unwrap_or([0; 4])),
        },
        RTM_NEWROUTE | RTM_DELROUTE => match parse_route(p) {
            Some(r) => Event::Route { oif: r.oif },
            None => Event::Other,
        },
        RTM_NEWRULE | RTM_DELRULE => match parse_rule(p) {
            Some(r) => Event::Rule { pref: r.pref },
            None => Event::Other,
        },
        _ => Event::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_match_iproute2() {
        let check = |m: Msg, ty: u16, payload: &[u8]| {
            let b = m.test_bytes();
            let msg = &nl::messages(&b)[0];
            assert_eq!(msg.ty, ty);
            assert_eq!(msg.flags, NLM_F_REQUEST | NLM_F_CREATE | NLM_F_EXCL);
            assert_eq!(msg.payload, payload);
        };
        check(
            add_rule_msg(AF_INET, 7001, Sel::To("192.168.42.0".parse().unwrap(), 24), RT_TABLE_MAIN),
            RTM_NEWRULE,
            &[
                2, 24, 0, 0, 254, 0, 0, 1, 0, 0, 0, 0, 8, 0, 6, 0, 0x59, 0x1b, 0, 0, 8, 0, 1, 0, 192, 168, 42, 0,
            ],
        );
        check(
            add_rule_msg(AF_INET6, 7001, Sel::Oif("vap-br0"), 1081),
            RTM_NEWRULE,
            &[
                10, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 8, 0, 6, 0, 0x59, 0x1b, 0, 0, 12, 0, 17, 0, b'v', b'a', b'p', b'-', b'b', b'r', b'0',
                0, 8, 0, 15, 0, 0x39, 0x04, 0, 0,
            ],
        );
        check(
            add_addr_msg(5, "192.168.42.2".parse().unwrap(), 24),
            RTM_NEWADDR,
            &[2, 24, 0, 0, 5, 0, 0, 0, 8, 0, 2, 0, 192, 168, 42, 2, 8, 0, 1, 0, 192, 168, 42, 2],
        );
    }

    fn rule_payload(family: u8, dst_len: u8, table: u8, action: u8, attrs: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut m = Msg::new(RTM_NEWRULE, 0, &[family, dst_len, 0, 0, table, 0, 0, action, 0, 0, 0, 0]);
        for (t, d) in attrs {
            m = m.attr(*t, d);
        }
        let b = m.test_bytes();
        nl::messages(&b)[0].payload.to_vec()
    }

    #[test]
    fn parses_and_prints_rules_like_ip() {
        let p = rule_payload(
            AF_INET,
            24,
            254,
            FR_ACT_TO_TBL,
            &[(FRA_PRIORITY, 7001u32.to_ne_bytes().to_vec()), (FRA_DST, vec![192, 168, 42, 0])],
        );
        let r = parse_rule(&p).unwrap();
        assert_eq!(r.pref, 7001);
        assert_eq!(r.text(), "from all to 192.168.42.0/24 lookup main");
        assert!(r.is_plain_to(&"192.168.42.0".parse().unwrap(), 24, RT_TABLE_MAIN));
        assert!(!r.is_plain_to(&"192.168.43.0".parse().unwrap(), 24, RT_TABLE_MAIN));

        let mut uid = 10000u32.to_ne_bytes().to_vec();
        uid.extend_from_slice(&19999u32.to_ne_bytes());
        let p = rule_payload(
            AF_INET6,
            0,
            0,
            FR_ACT_TO_TBL,
            &[
                (FRA_PRIORITY, 13000u32.to_ne_bytes().to_vec()),
                (FRA_TABLE, 1043u32.to_ne_bytes().to_vec()),
                (FRA_UID_RANGE, uid),
                (FRA_IIFNAME, b"lo\0".to_vec()),
            ],
        );
        let r = parse_rule(&p).unwrap();
        assert_eq!(r.text(), "from all iif lo uidrange 10000-19999 lookup 1043");
        assert!(!r.is_plain_to(&"::".parse().unwrap(), 0, 1043));

        let p = rule_payload(
            AF_INET6,
            0,
            0,
            FR_ACT_TO_TBL,
            &[
                (FRA_PRIORITY, 7001u32.to_ne_bytes().to_vec()),
                (FRA_TABLE, 1006u32.to_ne_bytes().to_vec()),
                (FRA_OIFNAME, b"vap-br0\0".to_vec()),
            ],
        );
        assert_eq!(parse_rule(&p).unwrap().text(), "from all oif vap-br0 lookup 1006");

        let p = rule_payload(
            AF_INET,
            0,
            0,
            FR_ACT_UNREACHABLE,
            &[(FRA_PRIORITY, 32000u32.to_ne_bytes().to_vec())],
        );
        assert_eq!(parse_rule(&p).unwrap().text(), "from all unreachable");
    }

    #[test]
    fn prefixes_print_like_iproute2() {
        assert_eq!(prefix_text(&"fe80::".parse().unwrap(), 64), "fe80::/64");
        assert_eq!(prefix_text(&"fdaa:bbbb:cccc:1::".parse().unwrap(), 64), "fdaa:bbbb:cccc:1::/64");
        assert_eq!(prefix_text(&"fdaa::1".parse().unwrap(), 128), "fdaa::1");
        assert_eq!(prefix_text(&"192.168.42.0".parse().unwrap(), 24), "192.168.42.0/24");
        assert_eq!(table_name(254), "main");
        assert_eq!(table_name(1006), "1006");
    }
}
