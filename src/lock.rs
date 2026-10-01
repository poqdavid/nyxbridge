use std::fs::{File, OpenOptions};
use std::time::{Duration, Instant};

use crate::sys;

pub struct Lock(#[allow(dead_code)] File);

fn open(path: &str) -> Option<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .ok()
}

pub fn try_acquire(path: &str) -> Option<Lock> {
    let f = open(path)?;
    matches!(sys::try_lock(&f), Ok(true)).then_some(Lock(f))
}

pub fn acquire(path: &str, timeout_ms: u64) -> Option<Lock> {
    let start = Instant::now();
    loop {
        if let Some(l) = try_acquire(path) {
            return Some(l);
        }
        if start.elapsed() >= Duration::from_millis(timeout_ms) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn is_held(path: &str) -> bool {
    if !std::path::Path::new(path).exists() {
        return false;
    }
    match open(path) {
        Some(f) => matches!(sys::try_lock(&f), Ok(false)),
        None => false,
    }
}

pub fn proc_start(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(") ")? + 2..];
    rest.split_whitespace().nth(19).map(String::from)
}
