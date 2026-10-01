mod conf;
mod ctl;
mod daemon;
mod extras;
mod json;
mod lock;
mod nl;
mod reconcile;
mod rtnl;
mod state;
mod sys;

use std::process::ExitCode;

fn main() -> ExitCode {
    // The tools it runs (date, am, monkey, getprop) are Android's.
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("/system/bin:/system/xbin:{path}"));
    let args: Vec<String> = std::env::args().skip(1).collect();
    ctl::main(&args)
}
