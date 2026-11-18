// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `markydowny markychecky task|end`: markychecky's hook, run before anything of the app
    // starts (no window, menu or crash reporting), so it finishes in milliseconds.
    #[cfg(unix)]
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "markychecky")
    {
        let args: Vec<String> = std::env::args_os()
            .skip(2)
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        markydowny_lib::markychecky::main(&args);
        std::process::exit(0);
    }
    #[cfg(unix)]
    markydowny_lib::markychecky::remember_app_image();
    // First, so crashes anywhere in startup are reported. Held until exit.
    let _crash_reporting = markydowny_lib::start_crash_reporting();
    markydowny_lib::run()
}
