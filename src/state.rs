use std::path::Path;

use crate::conf::{self, Paths};

#[derive(Clone, Debug, PartialEq)]
pub struct Va {
    pub mode: String,
    pub gateway: String,
    pub bridge: String,
}

impl Va {
    pub fn parse(text: Option<&str>) -> Va {
        let Some(t) = text else {
            return Va {
                mode: "stopped".into(),
                gateway: String::new(),
                bridge: conf::DEFAULT_BRIDGE.into(),
            };
        };
        let mode = conf::kv(t, "mode");
        let b = conf::kv(t, "bridge");
        Va {
            mode: if mode.is_empty() { "routed".into() } else { mode },
            gateway: conf::kv(t, "gateway"),
            bridge: if conf::valid_ifname(&b) { b } else { conf::DEFAULT_BRIDGE.into() },
        }
    }

    pub fn load(p: &Paths) -> Va {
        if Path::new(&p.va_state).is_file() {
            Va::parse(Some(&conf::read(&p.va_state)))
        } else {
            Va::parse(None)
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Applied {
    pub a4_addr: String,
    pub a4_br: String,
    pub a4_idx: String,
    pub a6_br: String,
    pub a6_idx: String,
    pub a6_orig: String,
    pub sig6: String,
    pub pref: String,
}

impl Applied {
    pub fn load(p: &Paths) -> Applied {
        let t = conf::read(&p.applied);
        Applied {
            a4_addr: conf::kv(&t, "A4_ADDR"),
            a4_br: conf::kv(&t, "A4_BR"),
            a4_idx: conf::kv(&t, "A4_IDX"),
            a6_br: conf::kv(&t, "A6_BR"),
            a6_idx: conf::kv(&t, "A6_IDX"),
            a6_orig: conf::kv(&t, "A6_ORIG"),
            sig6: conf::kv(&t, "SIG6"),
            pref: conf::kv(&t, "PREF"),
        }
    }

    fn text(&self) -> String {
        format!(
            "A4_ADDR={}\nA4_BR={}\nA4_IDX={}\nA6_BR={}\nA6_IDX={}\nA6_ORIG={}\nSIG6={}\nPREF={}\n",
            self.a4_addr, self.a4_br, self.a4_idx, self.a6_br, self.a6_idx, self.a6_orig, self.sig6, self.pref
        )
    }

    pub fn save(&self, p: &Paths, was: &Applied) {
        if self != was || !Path::new(&p.applied).is_file() {
            let _ = conf::write_atomic(&p.applied, &self.text(), None);
        }
    }

    pub fn clear_v6(&mut self) {
        self.a6_br.clear();
        self.a6_idx.clear();
        self.a6_orig.clear();
        self.sig6.clear();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Active,
    Inactive,
    Error,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Active => "active",
            State::Inactive => "inactive",
            State::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reason {
    pub code: &'static str,
    pub arg: String,
    pub text: String,
}

impl Reason {
    pub fn new(code: &'static str, arg: impl Into<String>, text: impl Into<String>) -> Reason {
        Reason {
            code,
            arg: arg.into(),
            text: text.into(),
        }
    }
}

pub fn write_status(p: &Paths, state: State, reason: &Reason, bridge: &str, a4_addr: &str) {
    let old = conf::read(&p.status);
    let (old_state, old_reason) = (conf::kv(&old, "state"), conf::kv(&old, "reason"));
    let text = format!(
        "state={}\nreason={}\nreason_code={}\nreason_arg={}\ntime={}\n",
        state.as_str(),
        reason.text,
        reason.code,
        reason.arg,
        conf::now_text()
    );
    let _ = conf::write_atomic(&p.status, &text, None);
    if state.as_str() != old_state || reason.text != old_reason {
        if state == State::Active {
            conf::log(p, &format!("Active on {bridge}"));
        } else {
            conf::log(p, &format!("{}: {}", state.as_str(), reason.text));
        }
        update_description(p, state, reason, bridge, a4_addr);
    }
}

pub fn update_description(p: &Paths, state: State, reason: &Reason, bridge: &str, a4_addr: &str) {
    let Ok(prop) = std::fs::read_to_string(&p.module_prop) else {
        return;
    };
    let desc = match state {
        State::Active => format!(
            "[✅ Active] {} on {bridge} — details in the WebUI",
            a4_addr.split('/').next().unwrap_or("")
        ),
        State::Error => format!("[⚠️ Problem] {} — details in the WebUI", reason.text),
        State::Inactive => format!("[💤 Idle] {} — details in the WebUI", reason.text),
    };
    let mut out = String::new();
    let mut done = false;
    for line in prop.lines() {
        if !done && line.starts_with("description=") {
            out.push_str(&format!("description={desc}\n"));
            done = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !done {
        out.push_str(&format!("description={desc}\n"));
    }
    let tmp = format!("{}.nyxtmp", p.module_prop);
    if std::fs::write(&tmp, out).is_ok() {
        let _ = std::fs::rename(&tmp, &p.module_prop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtualap_states() {
        assert_eq!(
            Va::parse(None),
            Va {
                mode: "stopped".into(),
                gateway: "".into(),
                bridge: "vap-br0".into()
            }
        );
        let v = Va::parse(Some("mode=bridged\ncontainer=openwrt\nbridge=vap-br0\ngateway=192.168.42.1\n"));
        assert_eq!(
            (v.mode.as_str(), v.gateway.as_str(), v.bridge.as_str()),
            ("bridged", "192.168.42.1", "vap-br0")
        );
        assert_eq!(Va::parse(Some("gateway=192.168.43.1\n")).mode, "routed");
        assert_eq!(Va::parse(Some("mode=bridged\nbridge=../../etc\n")).bridge, "vap-br0");
    }
}
