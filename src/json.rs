pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

#[derive(Default)]
pub struct Obj {
    parts: Vec<String>,
}

impl Obj {
    pub fn new() -> Obj {
        Obj::default()
    }

    pub fn str(mut self, k: &str, v: &str) -> Obj {
        self.parts.push(format!("{}:{}", esc(k), esc(v)));
        self
    }

    pub fn num(mut self, k: &str, v: i64) -> Obj {
        self.parts.push(format!("{}:{v}", esc(k)));
        self
    }

    pub fn bool(mut self, k: &str, v: bool) -> Obj {
        self.parts.push(format!("{}:{v}", esc(k)));
        self
    }

    pub fn opt_str(self, k: &str, v: Option<&str>) -> Obj {
        match v {
            Some(s) => self.str(k, s),
            None => self.raw(k, "null"),
        }
    }

    pub fn strs(self, k: &str, v: &[String]) -> Obj {
        let a = format!("[{}]", v.iter().map(|s| esc(s)).collect::<Vec<_>>().join(","));
        self.raw(k, &a)
    }

    /// An already-encoded value (an object or array).
    pub fn raw(mut self, k: &str, json: &str) -> Obj {
        self.parts.push(format!("{}:{json}", esc(k)));
        self
    }

    pub fn end(self) -> String {
        format!("{{{}}}", self.parts.join(","))
    }
}

pub fn array(items: &[String]) -> String {
    format!("[{}]", items.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_and_builds() {
        assert_eq!(esc("a\"b\\c\n\u{1}"), r#""a\"b\\c\n\u0001""#);
        let o = Obj::new()
            .str("s", "x")
            .num("n", -3)
            .bool("b", true)
            .opt_str("z", None)
            .strs("l", &["a".into(), "b".into()])
            .end();
        assert_eq!(o, r#"{"s":"x","n":-3,"b":true,"z":null,"l":["a","b"]}"#);
    }
}
