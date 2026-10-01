use std::io;
use std::os::fd::OwnedFd;

use crate::sys;

pub const NLMSG_ERROR: u16 = 2;
pub const NLMSG_DONE: u16 = 3;

pub const NLM_F_REQUEST: u16 = 0x1;
pub const NLM_F_ACK: u16 = 0x4;
const NLM_F_DUMP_INTR: u16 = 0x10;
pub const NLM_F_DUMP: u16 = 0x300;
pub const NLM_F_EXCL: u16 = 0x200;
pub const NLM_F_CREATE: u16 = 0x400;

const HDR_LEN: usize = 16;

pub const fn align(n: usize) -> usize {
    (n + 3) & !3
}

pub struct Msg {
    buf: Vec<u8>,
}

impl Msg {
    pub fn new(ty: u16, flags: u16, fixed: &[u8]) -> Msg {
        let mut buf = vec![0u8; HDR_LEN];
        buf[4..6].copy_from_slice(&ty.to_ne_bytes());
        buf[6..8].copy_from_slice(&flags.to_ne_bytes());
        buf.extend_from_slice(fixed);
        buf.resize(align(buf.len()), 0);
        Msg { buf }
    }

    pub fn attr(mut self, ty: u16, data: &[u8]) -> Msg {
        let len = 4 + data.len();
        self.buf.extend_from_slice(&(len as u16).to_ne_bytes());
        self.buf.extend_from_slice(&ty.to_ne_bytes());
        self.buf.extend_from_slice(data);
        self.buf.resize(align(self.buf.len()), 0);
        self
    }

    pub fn attr_u32(self, ty: u16, v: u32) -> Msg {
        self.attr(ty, &v.to_ne_bytes())
    }

    pub fn attr_str(self, ty: u16, s: &str) -> Msg {
        let mut v = s.as_bytes().to_vec();
        v.push(0);
        self.attr(ty, &v)
    }

    #[cfg(test)]
    pub fn test_bytes(mut self) -> Vec<u8> {
        self.finish(1).to_vec()
    }

    fn finish(&mut self, seq: u32) -> &[u8] {
        let len = self.buf.len() as u32;
        self.buf[0..4].copy_from_slice(&len.to_ne_bytes());
        self.buf[8..12].copy_from_slice(&seq.to_ne_bytes());
        &self.buf
    }
}

pub struct Message<'a> {
    pub ty: u16,
    pub flags: u16,
    pub seq: u32,
    pub payload: &'a [u8],
}

pub fn messages(mut buf: &[u8]) -> Vec<Message<'_>> {
    let mut out = Vec::new();
    while buf.len() >= HDR_LEN {
        let len = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        if len < HDR_LEN || len > buf.len() {
            break;
        }
        out.push(Message {
            ty: u16::from_ne_bytes([buf[4], buf[5]]),
            flags: u16::from_ne_bytes([buf[6], buf[7]]),
            seq: u32::from_ne_bytes([buf[8], buf[9], buf[10], buf[11]]),
            payload: &buf[HDR_LEN..len],
        });
        buf = &buf[align(len).min(buf.len())..];
    }
    out
}

pub fn attrs(mut buf: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    while buf.len() >= 4 {
        let len = u16::from_ne_bytes([buf[0], buf[1]]) as usize;
        let ty = u16::from_ne_bytes([buf[2], buf[3]]) & 0x3fff;
        if len < 4 || len > buf.len() {
            break;
        }
        out.push((ty, &buf[4..len]));
        buf = &buf[align(len).min(buf.len())..];
    }
    out
}

pub fn u32_of(data: &[u8]) -> Option<u32> {
    Some(u32::from_ne_bytes(data.get(..4)?.try_into().ok()?))
}

pub fn str_of(data: &[u8]) -> String {
    let end = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    String::from_utf8_lossy(&data[..end]).into_owned()
}

pub type Replies = Vec<(u16, Vec<u8>)>;

pub struct Sock {
    fd: OwnedFd,
    seq: std::cell::Cell<u32>,
    buf: std::cell::RefCell<Vec<u8>>,
}

impl Sock {
    pub fn open() -> io::Result<Sock> {
        let (fd, _) = sys::netlink_socket(0)?;
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(1);
        Ok(Sock {
            fd,
            seq: std::cell::Cell::new(seed | 1),
            buf: std::cell::RefCell::new(vec![0u8; 1 << 16]),
        })
    }

    fn next_seq(&self) -> u32 {
        let s = self.seq.get().wrapping_add(1);
        self.seq.set(s);
        s
    }

    pub fn exec(&self, msg: Msg) -> io::Result<()> {
        self.exchange(msg, false).map(|_| ())
    }

    pub fn dump(&self, ty: u16, fixed: &[u8]) -> io::Result<Replies> {
        let mut last = Err(io::Error::new(io::ErrorKind::Interrupted, "netlink dump kept being interrupted"));
        for _ in 0..4 {
            match self.exchange(Msg::new(ty, NLM_F_REQUEST | NLM_F_DUMP, fixed), true) {
                Ok((out, false)) => return Ok(out),
                Ok((_, true)) => continue,
                Err(e) => last = Err(e),
            }
            break;
        }
        last
    }

    pub fn query(&self, msg: Msg) -> io::Result<Replies> {
        self.exchange(msg, false).map(|(v, _)| v)
    }

    fn exchange(&self, mut msg: Msg, dump: bool) -> io::Result<(Replies, bool)> {
        if !dump {
            let flags = u16::from_ne_bytes([msg.buf[6], msg.buf[7]]) | NLM_F_ACK;
            msg.buf[6..8].copy_from_slice(&flags.to_ne_bytes());
        }
        let seq = self.next_seq();
        sys::netlink_send(&self.fd, msg.finish(seq))?;
        let mut out = Vec::new();
        let mut interrupted = false;
        let mut buf = self.buf.borrow_mut();
        loop {
            let n = sys::netlink_recv(&self.fd, &mut buf, true)?;
            for m in messages(&buf[..n]) {
                if m.seq != seq {
                    continue;
                }
                if m.flags & NLM_F_DUMP_INTR != 0 {
                    interrupted = true;
                }
                match m.ty {
                    NLMSG_DONE => return Ok((out, interrupted)),
                    NLMSG_ERROR => {
                        let err = m
                            .payload
                            .get(..4)
                            .map(|b| i32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
                            .unwrap_or(-5);
                        if err == 0 {
                            return Ok((out, interrupted));
                        }
                        return Err(io::Error::from_raw_os_error(-err));
                    }
                    ty => out.push((ty, m.payload.to_vec())),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_header_fixed_part_and_aligned_attributes() {
        let mut m = Msg::new(32, NLM_F_REQUEST, &[1, 2, 3]).attr(6, &[9, 9, 9, 9, 9]).attr_u32(15, 1006);
        let b = m.finish(7).to_vec();
        assert_eq!(b.len(), 16 + 4 + (4 + 8) + 8);
        assert_eq!(u32::from_ne_bytes(b[0..4].try_into().unwrap()) as usize, b.len());
        assert_eq!(u16::from_ne_bytes([b[4], b[5]]), 32);
        assert_eq!(u32::from_ne_bytes(b[8..12].try_into().unwrap()), 7);
        assert_eq!(&b[16..19], &[1, 2, 3]);
        let a = attrs(&b[20..]);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0], (6, &[9u8, 9, 9, 9, 9][..]));
        assert_eq!(u32_of(a[1].1), Some(1006));
    }

    #[test]
    fn splits_messages_and_stops_at_garbage() {
        let mut one = Msg::new(20, 0, &[0; 8]).attr_str(3, "vap-br0");
        let mut two = Msg::new(NLMSG_DONE, 0, &[0; 4]);
        let mut d = one.finish(1).to_vec();
        d.extend_from_slice(two.finish(1));
        d.extend_from_slice(&[0xff; 7]);
        let ms = messages(&d);
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[0].ty, 20);
        assert_eq!(str_of(attrs(&ms[0].payload[8..])[0].1), "vap-br0");
        assert_eq!(ms[1].ty, NLMSG_DONE);
    }

    #[test]
    fn attribute_type_flags_are_masked() {
        let raw = [8u8, 0, 0x01, 0x80, 1, 2, 3, 4];
        assert_eq!(attrs(&raw)[0].0, 1);
    }
}
