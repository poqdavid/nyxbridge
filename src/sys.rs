use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::raw::{c_char, c_int, c_ulong, c_void};

pub const AF_NETLINK: c_int = 16;
pub const NETLINK_ROUTE: c_int = 0;
const SOCK_RAW: c_int = 3;
const SOCK_CLOEXEC: c_int = 0o2_000_000;
const SOL_SOCKET: c_int = 1;
const SO_RCVBUF: c_int = 8;
const MSG_DONTWAIT: c_int = 0x40;
const MSG_TRUNC: c_int = 0x20;

pub const POLLIN: i16 = 0x1;

pub const SIGHUP: c_int = 1;
pub const SIGINT: c_int = 2;
pub const SIGKILL: c_int = 9;
pub const SIGTERM: c_int = 15;
const SIG_BLOCK: c_int = 0;
const SFD_CLOEXEC: c_int = 0o2_000_000;
const SFD_NONBLOCK: c_int = 0o4_000;

const IN_CLOEXEC: c_int = 0o2_000_000;
const IN_NONBLOCK: c_int = 0o4_000;
pub const IN_CLOSE_WRITE: u32 = 0x8;
pub const IN_MOVED_FROM: u32 = 0x40;
pub const IN_MOVED_TO: u32 = 0x80;
pub const IN_CREATE: u32 = 0x100;
pub const IN_DELETE: u32 = 0x200;
pub const IN_DELETE_SELF: u32 = 0x400;
pub const IN_MOVE_SELF: u32 = 0x800;
pub const IN_Q_OVERFLOW: u32 = 0x4000;
pub const IN_IGNORED: u32 = 0x8000;

const LOCK_EX: c_int = 2;
const LOCK_NB: c_int = 4;

pub const EINTR: i32 = 4;
pub const EAGAIN: i32 = 11;
pub const ENOBUFS: i32 = 105;

#[repr(C)]
struct SockaddrNl {
    nl_family: u16,
    nl_pad: u16,
    nl_pid: u32,
    nl_groups: u32,
}

#[repr(C)]
pub struct PollFd {
    pub fd: c_int,
    pub events: i16,
    pub revents: i16,
}

#[repr(C)]
struct SigSet([u64; 16]);

extern "C" {
    fn socket(domain: c_int, ty: c_int, proto: c_int) -> c_int;
    fn bind(fd: c_int, addr: *const c_void, len: u32) -> c_int;
    fn getsockname(fd: c_int, addr: *mut c_void, len: *mut u32) -> c_int;
    fn setsockopt(fd: c_int, level: c_int, name: c_int, val: *const c_void, len: u32) -> c_int;
    fn sendto(fd: c_int, buf: *const c_void, len: usize, flags: c_int, addr: *const c_void, alen: u32) -> isize;
    fn recv(fd: c_int, buf: *mut c_void, len: usize, flags: c_int) -> isize;
    fn read(fd: c_int, buf: *mut c_void, len: usize) -> isize;
    fn poll(fds: *mut PollFd, n: c_ulong, timeout: c_int) -> c_int;
    fn kill(pid: c_int, sig: c_int) -> c_int;
    fn setsid() -> c_int;
    fn flock(fd: c_int, op: c_int) -> c_int;
    fn sigemptyset(set: *mut SigSet) -> c_int;
    fn sigaddset(set: *mut SigSet, sig: c_int) -> c_int;
    fn sigprocmask(how: c_int, set: *const SigSet, old: *mut SigSet) -> c_int;
    fn signalfd(fd: c_int, mask: *const SigSet, flags: c_int) -> c_int;
    fn inotify_init1(flags: c_int) -> c_int;
    fn inotify_add_watch(fd: c_int, path: *const c_char, mask: u32) -> c_int;
}

fn check(ret: c_int) -> io::Result<c_int> {
    if ret < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(ret)
    }
}

pub fn netlink_socket(groups: u32) -> io::Result<(OwnedFd, u32)> {
    unsafe {
        let fd = check(socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE))?;
        let fd = OwnedFd::from_raw_fd(fd);
        if groups != 0 {
            let size: c_int = 1 << 20;
            setsockopt(fd.as_raw_fd(), SOL_SOCKET, SO_RCVBUF, (&size as *const c_int).cast(), 4);
        }
        let addr = SockaddrNl {
            nl_family: AF_NETLINK as u16,
            nl_pad: 0,
            nl_pid: 0,
            nl_groups: groups,
        };
        check(bind(
            fd.as_raw_fd(),
            (&addr as *const SockaddrNl).cast(),
            std::mem::size_of::<SockaddrNl>() as u32,
        ))?;
        let mut got = SockaddrNl {
            nl_family: 0,
            nl_pad: 0,
            nl_pid: 0,
            nl_groups: 0,
        };
        let mut len = std::mem::size_of::<SockaddrNl>() as u32;
        check(getsockname(fd.as_raw_fd(), (&mut got as *mut SockaddrNl).cast(), &mut len))?;
        Ok((fd, got.nl_pid))
    }
}

pub fn netlink_send(fd: &OwnedFd, msg: &[u8]) -> io::Result<()> {
    let to = SockaddrNl {
        nl_family: AF_NETLINK as u16,
        nl_pad: 0,
        nl_pid: 0,
        nl_groups: 0,
    };
    loop {
        let n = unsafe {
            sendto(
                fd.as_raw_fd(),
                msg.as_ptr().cast(),
                msg.len(),
                0,
                (&to as *const SockaddrNl).cast(),
                std::mem::size_of::<SockaddrNl>() as u32,
            )
        };
        if n >= 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(EINTR) {
            return Err(e);
        }
    }
}

pub fn netlink_recv(fd: &OwnedFd, buf: &mut [u8], wait: bool) -> io::Result<usize> {
    let flags = MSG_TRUNC | if wait { 0 } else { MSG_DONTWAIT };
    loop {
        let n = unsafe { recv(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), flags) };
        if n >= 0 {
            let n = n as usize;
            if n > buf.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "netlink message larger than the receive buffer",
                ));
            }
            return Ok(n);
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(EINTR) {
            return Err(e);
        }
    }
}

pub fn read_fd(fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        let n = unsafe { read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n >= 0 {
            return Ok(n as usize);
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(EINTR) {
            return Err(e);
        }
    }
}

pub fn poll_fds(fds: &mut [PollFd], timeout_ms: i32) -> io::Result<usize> {
    let n = unsafe { poll(fds.as_mut_ptr(), fds.len() as c_ulong, timeout_ms) };
    if n >= 0 {
        return Ok(n as usize);
    }
    let e = io::Error::last_os_error();
    if e.raw_os_error() == Some(EINTR) {
        Ok(0)
    } else {
        Err(e)
    }
}

pub fn send_signal(pid: i32, sig: c_int) -> io::Result<bool> {
    // SAFETY: plain syscall.
    if unsafe { kill(pid, sig) } == 0 {
        return Ok(true);
    }
    let e = io::Error::last_os_error();
    if e.raw_os_error() == Some(3) {
        Ok(false)
    } else {
        Err(e)
    }
}

pub fn new_session() -> io::Result<()> {
    check(unsafe { setsid() }).map(|_| ())
}

pub fn try_lock(fd: &impl AsRawFd) -> io::Result<bool> {
    if unsafe { flock(fd.as_raw_fd(), LOCK_EX | LOCK_NB) } == 0 {
        return Ok(true);
    }
    let e = io::Error::last_os_error();
    if e.raw_os_error() == Some(EAGAIN) {
        Ok(false)
    } else {
        Err(e)
    }
}

pub fn stop_signals_fd() -> io::Result<OwnedFd> {
    unsafe {
        let mut set = SigSet([0; 16]);
        sigemptyset(&mut set);
        for s in [SIGTERM, SIGINT, SIGHUP] {
            sigaddset(&mut set, s);
        }
        check(sigprocmask(SIG_BLOCK, &set, std::ptr::null_mut()))?;
        let fd = check(signalfd(-1, &set, SFD_CLOEXEC | SFD_NONBLOCK))?;
        Ok(OwnedFd::from_raw_fd(fd))
    }
}

pub fn inotify() -> io::Result<OwnedFd> {
    let fd = check(unsafe { inotify_init1(IN_CLOEXEC | IN_NONBLOCK) })?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn inotify_watch(fd: &OwnedFd, path: &str, mask: u32) -> io::Result<i32> {
    let c = CString::new(path).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    check(unsafe { inotify_add_watch(fd.as_raw_fd(), c.as_ptr(), mask) })
}
