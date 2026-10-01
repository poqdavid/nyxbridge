use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use crate::conf::{self, Paths};
use crate::extras;
use crate::lock;
use crate::nl::{self, Sock};
use crate::reconcile;
use crate::rtnl::{self, Event};
use crate::state::Va;
use crate::sys;

const GROUPS: u32 = (1 << 0) | (1 << 4) | (1 << 7) | (1 << 8) | (1 << 10) | (1 << 18);

const SETTLE: Duration = Duration::from_millis(300);
const MAX_DELAY: Duration = Duration::from_millis(2000);
const BACKSTOP: Duration = Duration::from_secs(300);

pub fn running(p: &Paths) -> bool {
    lock::is_held(&p.daemon_lock)
}

pub fn pid(p: &Paths) -> Option<u32> {
    if !running(p) {
        return None;
    }
    let t = conf::read(&p.daemon_pid);
    let mut it = t.split_whitespace();
    let pid: u32 = it.next()?.parse().ok()?;
    let start = it.next()?;
    (lock::proc_start(pid).as_deref() == Some(start)).then_some(pid)
}

fn spawn_detached(args: &[&str]) -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(sys::new_session);
    }
    cmd.spawn().map(drop)
}

pub fn start(p: &Paths) -> bool {
    if running(p) {
        return true;
    }
    if spawn_detached(&["daemon"]).is_err() {
        return false;
    }
    for _ in 0..15 {
        if running(p) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    running(p)
}

pub fn boot() -> ExitCode {
    match spawn_detached(&["daemon"]) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

pub fn stop(p: &Paths) {
    if !running(p) {
        return;
    }
    let mut target = None;
    for _ in 0..20 {
        target = pid(p);
        if target.is_some() || !running(p) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let Some(pid) = target else { return };
    let _ = sys::send_signal(pid as i32, sys::SIGTERM);
    for _ in 0..50 {
        if !running(p) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = sys::send_signal(pid as i32, sys::SIGKILL);
    for _ in 0..20 {
        if !running(p) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn in_app_cgroup() -> bool {
    conf::read("/proc/self/cgroup")
        .lines()
        .any(|l| l.split("/uid_").nth(1).is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit())))
}

fn leave_app_cgroups(p: &Paths) {
    if !in_app_cgroup() {
        return;
    }
    let me = std::process::id().to_string();
    for g in &p.cgroups {
        let procs = format!("{g}/cgroup.procs");
        if Path::new(&procs).exists() {
            let _ = std::fs::write(&procs, &me);
        }
    }
    if in_app_cgroup() {
        conf::log(
            p,
            "Watcher is still in the root manager's app cgroup; it may stop when the manager closes",
        );
    } else {
        conf::log(p, "Watcher moved out of the root manager's app cgroup");
    }
}

struct Watch {
    bridge: String,
    index: Option<u32>,
    prefs: [u32; 2],
}

impl Watch {
    fn load(p: &Paths) -> Watch {
        let va = Va::load(p);
        let pref = conf::Config::load(p).pref;
        let applied = conf::num_in(&crate::state::Applied::load(p).pref, 1, 32765)
            .map(|v| v as u32)
            .unwrap_or(pref);
        Watch {
            index: reconcile::if_index(p, &va.bridge),
            bridge: va.bridge,
            prefs: [pref, applied],
        }
    }

    fn relevant(&self, ev: &Event) -> bool {
        match ev {
            Event::Link { index, name } => name.as_deref() == Some(self.bridge.as_str()) || Some(*index) == self.index,
            Event::Addr { index } => Some(*index) == self.index,
            Event::Route { oif } => oif.is_some() && *oif == self.index,
            Event::Rule { pref } => self.prefs.contains(pref),
            Event::Other => false,
        }
    }
}

struct Inotify {
    fd: std::os::fd::OwnedFd,
    va_dir: String,
    va_file: String,
    va_wd: Option<i32>,
    data_wd: Option<i32>,
    mod_wd: Option<i32>,
}

const DIR_MASK: u32 =
    sys::IN_CLOSE_WRITE | sys::IN_MOVED_TO | sys::IN_MOVED_FROM | sys::IN_CREATE | sys::IN_DELETE | sys::IN_DELETE_SELF | sys::IN_MOVE_SELF;

impl Inotify {
    fn new(p: &Paths) -> Option<Inotify> {
        let fd = sys::inotify().ok()?;
        let va = Path::new(&p.va_state);
        let mut i = Inotify {
            va_dir: va.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
            va_file: va.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
            va_wd: None,
            data_wd: sys::inotify_watch(&fd, &p.data, DIR_MASK).ok(),
            mod_wd: sys::inotify_watch(
                &fd,
                &p.moddir,
                sys::IN_CREATE | sys::IN_DELETE | sys::IN_MOVED_TO | sys::IN_MOVED_FROM,
            )
            .ok(),
            fd,
        };
        i.rearm();
        Some(i)
    }

    fn rearm(&mut self) {
        if self.va_wd.is_none() && !self.va_dir.is_empty() {
            self.va_wd = sys::inotify_watch(&self.fd, &self.va_dir, DIR_MASK).ok();
        }
    }

    fn read(&mut self) -> (bool, bool) {
        let mut buf = [0u8; 4096];
        let (mut relevant, mut config) = (false, false);
        while let Ok(n) = sys::read_fd(self.fd.as_raw_fd(), &mut buf) {
            if n == 0 {
                break;
            }
            let mut off = 0;
            while off + 16 <= n {
                let wd = i32::from_ne_bytes(buf[off..off + 4].try_into().unwrap_or([0; 4]));
                let mask = u32::from_ne_bytes(buf[off + 4..off + 8].try_into().unwrap_or([0; 4]));
                let len = u32::from_ne_bytes(buf[off + 12..off + 16].try_into().unwrap_or([0; 4])) as usize;
                let name = nl::str_of(buf.get(off + 16..off + 16 + len).unwrap_or(&[]));
                off += 16 + len;
                if mask & sys::IN_Q_OVERFLOW != 0 {
                    relevant = true;
                    config = true;
                    continue;
                }
                if mask & (sys::IN_IGNORED | sys::IN_DELETE_SELF | sys::IN_MOVE_SELF) != 0 && Some(wd) == self.va_wd {
                    self.va_wd = None;
                    relevant = true;
                    continue;
                }
                if Some(wd) == self.va_wd && name == self.va_file {
                    relevant = true;
                } else if Some(wd) == self.data_wd && name == "config.sh" {
                    relevant = true;
                    config = true;
                } else if Some(wd) == self.mod_wd && (name == "disable" || name == "remove") {
                    relevant = true;
                }
            }
        }
        (relevant, config)
    }
}

fn read_events(fd: &std::os::fd::OwnedFd, buf: &mut [u8], w: &Watch) -> bool {
    let mut relevant = false;
    loop {
        match sys::netlink_recv(fd, buf, false) {
            Ok(n) => {
                for m in nl::messages(&buf[..n]) {
                    if !relevant && w.relevant(&rtnl::classify(m.ty, m.payload)) {
                        relevant = true;
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return relevant,
            Err(e) if e.raw_os_error() == Some(sys::ENOBUFS) => relevant = true,
            Err(_) => return relevant,
        }
    }
}

pub fn run(p: &Paths) -> ExitCode {
    if conf::init_dirs(p).is_err() {
        return ExitCode::FAILURE;
    }
    let Some(_lock) = lock::try_acquire(&p.daemon_lock) else {
        return ExitCode::SUCCESS;
    };
    let me = std::process::id();
    let _ = std::fs::write(&p.daemon_pid, format!("{me} {}\n", lock::proc_start(me).unwrap_or_default()));

    if !conf::monitor_enabled(p) {
        conf::log(p, "Monitoring is off; the watcher stays stopped");
        let _ = std::fs::remove_file(&p.daemon_pid);
        return ExitCode::SUCCESS;
    }
    leave_app_cgroups(p);

    let sig = match sys::stop_signals_fd() {
        Ok(f) => f,
        Err(_) => return fail(p, "Could not set up signal handling; stopping"),
    };
    let ev = match sys::netlink_socket(GROUPS) {
        Ok((f, _)) => f,
        Err(e) => return fail(p, &format!("Could not open the netlink event socket ({e}); stopping")),
    };
    let nl = match Sock::open() {
        Ok(s) => s,
        Err(e) => return fail(p, &format!("Could not open a netlink socket ({e}); stopping")),
    };
    let mut ino = Inotify::new(p);

    conf::log(p, &format!("Watcher started (pid {me})"));
    let mut watch = check(p, &nl);
    let mut last_check = Instant::now();
    let mut pending: Option<(Instant, Instant)> = None;
    let mut buf = vec![0u8; 1 << 16];

    loop {
        let now = Instant::now();
        let due = match pending {
            Some((first, latest)) => (latest + SETTLE).min(first + MAX_DELAY),
            None => last_check + BACKSTOP,
        };
        let timeout = due.saturating_duration_since(now).as_millis().min(i32::MAX as u128) as i32;
        let mut fds = [
            sys::PollFd {
                fd: sig.as_raw_fd(),
                events: sys::POLLIN,
                revents: 0,
            },
            sys::PollFd {
                fd: ev.as_raw_fd(),
                events: sys::POLLIN,
                revents: 0,
            },
            sys::PollFd {
                fd: ino.as_ref().map(|i| i.fd.as_raw_fd()).unwrap_or(-1),
                events: sys::POLLIN,
                revents: 0,
            },
        ];
        if sys::poll_fds(&mut fds, timeout).is_err() {
            std::thread::sleep(Duration::from_millis(500));
        }
        if fds[0].revents != 0 {
            break;
        }
        let mut hit = false;
        if fds[1].revents != 0 && read_events(&ev, &mut buf, &watch) {
            hit = true;
        }
        if fds[2].revents != 0 {
            if let Some(i) = ino.as_mut() {
                let (relevant, _config) = i.read();
                hit |= relevant;
            }
        }
        let now = Instant::now();
        if hit {
            pending = Some(match pending {
                Some((first, _)) => (first, now),
                None => (now, now),
            });
        }
        let ready = match pending {
            Some((first, latest)) => now >= (latest + SETTLE).min(first + MAX_DELAY),
            None => now >= last_check + BACKSTOP,
        };
        if !ready {
            continue;
        }
        pending = None;
        if !conf::monitor_enabled(p) {
            conf::log(p, "Monitoring is off in config.sh");
            break;
        }
        if let Some(i) = ino.as_mut() {
            i.rearm();
        }
        watch = check(p, &nl);
        last_check = Instant::now();
    }
    conf::log(p, "Watcher stopped");
    let _ = std::fs::remove_file(&p.daemon_pid);
    ExitCode::SUCCESS
}

fn fail(p: &Paths, msg: &str) -> ExitCode {
    conf::log(p, msg);
    let _ = std::fs::remove_file(&p.daemon_pid);
    ExitCode::FAILURE
}

fn check(p: &Paths, nl: &Sock) -> Watch {
    extras::check(p, nl);
    Watch::load(p)
}
