// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // First, so crashes anywhere in startup are reported. Held until exit.
    let _crash_reporting = markydowny_lib::start_crash_reporting();
    markydowny_lib::run()
}
