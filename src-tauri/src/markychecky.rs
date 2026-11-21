//! markychecky's hook, run by the app: `markydowny markychecky task|end|notify|respond`, with
//! the hook's JSON on stdin, and the `waiting add|remove|list` commands sessions run themselves.
//! It does what `plugins/markychecky/scripts/markychecky.py` does, which stays as the fallback
//! when Markydowny isn't installed, so the two must write byte-identical boards and share the
//! same state files: a session can switch from one to the other mid-way.
//!
//! `main.rs` runs this before anything of the app starts (no Tauri, window, menu or crash
//! reporting), so a call takes milliseconds. A hook never fails the session: it always exits 0,
//! prints nothing, and logs problems to `markychecky.log` in the plugin's data folder. A
//! `waiting` command says what it did, and exits non-zero when it couldn't.
//!
//! The Python script's regular expressions use lookbehind and backreferences, which the
//! `regex` crate doesn't have, so the matchers here are written out by hand, each next to the
//! expression it follows. Text is matched as Python's `re` does: `\w` and whitespace are Unicode.

use std::collections::hash_map::RandomState;
use std::ffi::{CStr, CString};
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

/// In the binary so the plugin's launcher can tell a Markydowny that has this mode, with every
/// command the plugin runs, from an older one: one without the mode would start its window, and
/// engine 1 has no `notify`, `respond` or `waiting`, and engine 2 doesn't name sessions and adds
/// "waiting for your input" lines (`markychecky.sh` greps for it).
pub const ENGINE_MARKER: &str = "markychecky-hook-engine-3";

const TITLE: &str =
    "# Markychecky\n\nWhat each Claude Code session is working on. Sessions update their own sections.\n";
const START: &str = "<!-- markychecky:start ";
const STATUSES: [&str; 3] = ["completed", "in_progress", "pending"];
const WAITING_HEADING: &str = "## Waiting on you";
const ITEM: &str = "<!-- markychecky:item ";
const NOTIFY: &str = "<!-- markychecky:notify ";

/// The notifications that mean a session is stopped on a question for the user, each a dialog
/// in the middle of a tool call, answered when the call's batch resolves, whether the user
/// approved or denied it. Every other type isn't on the board: a session that's only idle,
/// waiting for its next prompt, isn't something to do (idle_prompt, agent_needs_input,
/// quota_auto_resume_stale), and nor is a background agent finishing or a sign-in. Items from
/// before 0.5 may still wait on a "prompt", which a prompt answers.
const WAITS: [(&str, &str); 4] = [
    ("permission_prompt", "tool"),
    ("worker_permission_prompt", "tool"),
    ("elicitation_dialog", "tool"),
    ("elicitation_url_dialog", "tool"),
];

/// The entries in a session's transcript that name it: the name /rename gave it, and the one
/// Claude Code made up for it. A name given by /rename wins.
const TITLES: [(&str, &str); 2] = [("custom-title", "customTitle"), ("ai-title", "aiTitle")];

type Result<T> = std::result::Result<T, String>;

/// `markydowny markychecky <args>`, returning the exit code. A hook never panics or prints, and
/// exits 0; its problems go to the log. A `waiting` command prints what it did, and its problems.
pub fn main(args: &[String]) -> i32 {
    std::panic::set_hook(Box::new(|_| {}));
    let panic_message = |panic: Box<dyn std::any::Any + Send>| {
        panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "panic".into())
    };
    if args.first().map(String::as_str) == Some("waiting") {
        let outcome = std::panic::catch_unwind(|| run_waiting(&args[1..]));
        return match outcome {
            Ok(Ok(code)) => code,
            Ok(Err(error)) => {
                eprintln!("markychecky: {error}");
                1
            }
            Err(panic) => {
                eprintln!("markychecky: {}", panic_message(panic));
                1
            }
        };
    }
    let outcome = std::panic::catch_unwind(|| run(args));
    let message = match outcome {
        Ok(Ok(())) => return 0,
        Ok(Err(error)) => error,
        Err(panic) => panic_message(panic),
    };
    log(args, &message);
    0
}

/// Run as an AppImage, saves its path where markychecky's launcher looks for it: an AppImage is
/// compressed, so the launcher can't find the marker in it, and it's rarely on PATH. Only an
/// AppImage with this mode saves itself, so the launcher can trust the path.
pub fn remember_app_image() {
    if let Some(app_image) = std::env::var_os("APPIMAGE").filter(|p| !p.is_empty()) {
        let dir = format!("{}/.cache/markychecky", expand_user("~"));
        let _ = save_app_image(&app_image.to_string_lossy(), &dir);
    }
}

/// The path, then the engine on the next line, so the launcher only runs an AppImage that has
/// the commands it's given.
fn save_app_image(app_image: &str, dir: &str) -> std::io::Result<()> {
    let file = format!("{dir}/markydowny-path");
    let line = format!("{app_image}\n{ENGINE_MARKER}\n");
    if fs::read_to_string(&file).is_ok_and(|saved| saved == line) {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    fs::write(&file, line)
}

fn run(args: &[String]) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("");
    if command == "--version" {
        // Prints the marker, which also keeps it in the binary for the launcher to find.
        println!("{ENGINE_MARKER}");
        return Ok(());
    }
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    let event: Value = serde_json::from_str(&input).map_err(|e| format!("JSONDecodeError({e})"))?;
    let event = event
        .as_object()
        .ok_or("AttributeError: the event isn't an object")?;
    let session_id = session_id(event.get("session_id"));
    if session_id.is_empty() {
        return Ok(());
    }
    let board_path = setting("FILE", "~/markychecky.md");
    let waiting = on("WAITING");
    let raw_hours = setting("IDLE_HOURS", "24");
    let idle_hours = match parse_float(&raw_hours) {
        Some(hours) => hours,
        None => {
            log(
                args,
                &format!("idle_hours is not a number of hours: '{raw_hours}'; using 24"),
            );
            24.0
        }
    };
    let data = data_dir()?;
    let state_path = format!("{data}/sessions/{session_id}.json");
    // Whether this session has a notification item on the board, and what answers it. `respond`
    // runs after every batch of tools, so it checks this before it takes the lock, and does
    // nothing the rest of the time.
    let flag_path = format!("{data}/sessions/{session_id}.notify");
    // The subagent the event comes from, or "" for the session's main agent.
    let agent = self::session_id(event.get("agent_id"));

    if command == "respond" {
        let started = now_micros();
        if answered(event, read_flag(&flag_path).as_ref(), started).is_empty() {
            return Ok(());
        }
        write_board(
            &board_path,
            |board| {
                // Again under the lock: a notification may have come in since, which this
                // doesn't answer.
                let mut flag = read_flag(&flag_path).unwrap_or_default();
                let done = answered(event, Some(&flag), started);
                if done.is_empty() {
                    return Ok(board.to_string());
                }
                flag.retain(|agent, _| !done.contains(agent));
                save_flag(&flag_path, &flag)?;
                Ok(without_notify(board, &session_id, Some(&done)))
            },
            Some(&data),
        )?;
        return Ok(());
    }

    if command == "notify" {
        let Some((text, waits)) = notification_text(event)? else {
            return Ok(());
        };
        if !waiting {
            return Ok(());
        }
        let cwd = event_cwd(event.get("cwd"))?;
        let now = now_micros();
        let at = iso_utc(now);
        let agent_attr = if agent.is_empty() {
            String::new()
        } else {
            format!(" agent={agent}")
        };
        let place = place(&cwd);
        let marker = format!("{NOTIFY}{session_id}{agent_attr} at={at} -->");
        let transcript = transcript_of(event);
        let mut opening = false;
        let created = write_board(
            &board_path,
            |board| {
                // The main agent and each subagent have an item of their own: their dialogs can
                // be open at once, and each is answered on its own.
                let mut flag = read_flag(&flag_path).unwrap_or_default();
                let mut item = Map::new();
                item.insert("waits".into(), Value::String(waits.into()));
                item.insert("at".into(), Value::String(at.clone()));
                flag.insert(agent.clone(), Value::Object(item));
                save_flag(&flag_path, &flag)?;
                let mut state = load_state(&state_path);
                if first_open(&mut state) {
                    opening = true;
                }
                read_name(&mut state, &transcript);
                save_state(&state_path, &state)?;
                let line = format!(
                    "- {}: {text} {marker}",
                    label(&place, &session_name(&state))
                );
                let board = without_notify(board, &session_id, Some(&[agent.clone()]));
                let board = edit_waiting(&board, |mut lines| {
                    lines.push(line);
                    lines
                });
                sweep(&board, idle_hours, &session_id, now)
            },
            Some(&data),
        )?;
        if created || opening {
            open_in_markydowny(&board_path, None);
        }
        return Ok(());
    }

    if command != "task" && command != "end" {
        return Ok(());
    }
    // git runs before the lock is taken, so sessions don't queue behind each other's git.
    let place_and_repo = if command == "task" {
        let cwd = event_cwd(event.get("cwd"))?;
        Some((place(&cwd), github_repo(&cwd)))
    } else {
        None
    };
    let transcript = transcript_of(event);
    let mut first = false;
    write_board(
        &board_path,
        |board| {
            // Under the board's lock: hooks for one session run at once when several task tools
            // fire in a turn, and each must fold its event into the state the last one saved.
            let mut state = load_state(&state_path);
            let now = now_micros();
            let mut board = board.to_string();
            let ended = if let Some((place, repo)) = &place_and_repo {
                if !apply_event(&mut state, event)? {
                    return Ok(board);
                }
                state.insert("place".into(), Value::String(place.clone()));
                state.insert("repo".into(), Value::String(repo.clone()));
                read_name(&mut state, &transcript);
                state.remove("ended");
                None
            } else {
                let _ = fs::remove_file(&flag_path);
                board = without_notify(&board, &session_id, None);
                if !truthy(state.get("wrote")) {
                    return Ok(board); // never wrote a section
                }
                state.insert("ended".into(), Value::String(iso_utc(now)));
                Some(now)
            };
            if first_open(&mut state) {
                first = true;
            }
            state.insert("wrote".into(), Value::Bool(true));
            save_state(&state_path, &state)?;
            let section = render_section(&session_id, &state, ended, local_hh_mm)?;
            let mut board = replace_section(&board, &session_id, &section);
            if waiting {
                board = ensure_waiting(&board);
            }
            sweep(&board, idle_hours, &session_id, now)
        },
        Some(&data),
    )?;
    if first {
        open_in_markydowny(&board_path, None);
    }
    Ok(())
}

/// Whether this is the session's first write to the board, when the board opens in Markydowny.
/// Marks it, so the caller saves the state.
fn first_open(state: &mut Map<String, Value>) -> bool {
    if truthy(state.get("opened")) || truthy(state.get("wrote")) {
        return false;
    }
    state.insert("opened".into(), Value::Bool(true));
    true
}

// ----------------------------------------------------------------------------------------------
// Settings and files
// ----------------------------------------------------------------------------------------------

fn setting(name: &str, default: &str) -> String {
    for key in [
        format!("MARKYCHECKY_{name}"),
        format!("CLAUDE_PLUGIN_OPTION_{name}"),
    ] {
        if let Some(value) = std::env::var_os(&key) {
            if !value.is_empty() {
                return value.to_string_lossy().into_owned();
            }
        }
    }
    default.to_string()
}

fn on(name: &str) -> bool {
    ["1", "true", "yes"].contains(&setting(name, "true").to_lowercase().as_str())
}

/// The plugin's data folder, with its `sessions` folder made.
fn data_dir() -> Result<String> {
    let base = match std::env::var("CLAUDE_PLUGIN_DATA") {
        Ok(dir) if !dir.is_empty() => dir,
        _ => format!("{}/.cache/markychecky", expand_user("~")),
    };
    fs::create_dir_all(format!("{base}/sessions")).map_err(|e| e.to_string())?;
    Ok(base)
}

fn log(args: &[String], message: &str) {
    let Ok(dir) = data_dir() else { return };
    let argv = args
        .iter()
        .map(|a| format!("'{a}'"))
        .collect::<Vec<_>>()
        .join(", ");
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(format!("{dir}/markychecky.log"))
    {
        let _ = writeln!(file, "{} [{argv}] {message}", iso_utc(now_micros()));
    }
}

/// `re.sub(r"[^\w.-]", "", str(session_id or ""))[:64]`
fn session_id(value: Option<&Value>) -> String {
    let raw = if truthy(value) {
        py_str(value.unwrap())
    } else {
        String::new()
    };
    raw.chars()
        .filter(|&c| is_word(c) || c == '.' || c == '-')
        .take(64)
        .collect()
}

/// The event's `cwd`, or the hook's own working directory without one.
fn event_cwd(value: Option<&Value>) -> Result<String> {
    match value {
        Some(Value::String(cwd)) if !cwd.is_empty() => Ok(cwd.clone()),
        v if !truthy(v) => current_dir(),
        _ => Err("TypeError: cwd isn't a string".into()),
    }
}

fn current_dir() -> Result<String> {
    std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

fn load_state(path: &str) -> Map<String, Value> {
    let fallback = || {
        let mut state = Map::new();
        state.insert("tasks".into(), Value::Object(Map::new()));
        state
    };
    match fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(Value::Object(state)) => state,
        _ => fallback(),
    }
}

fn save_state(path: &str, state: &Map<String, Value>) -> Result<()> {
    let tmp = format!("{path}.tmp-{}", std::process::id());
    let text = serde_json::to_string(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ----------------------------------------------------------------------------------------------
// A session's task list, rebuilt from hook events
// ----------------------------------------------------------------------------------------------

/// Python's truthiness, for JSON values.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// Python's `a or b`.
fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) {
        a
    } else {
        b
    }
}

/// Python's `str()` of a JSON value.
fn py_str(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) if n.is_f64() => {
            // Python's repr: `1.0`, `1e+16`, `1e-05`.
            let text = format!("{:?}", n.as_f64().unwrap_or_default());
            match text.split_once('e') {
                Some((mantissa, exp)) => {
                    let (sign, digits) = exp.strip_prefix('-').map_or(("+", exp), |d| ("-", d));
                    format!("{mantissa}e{sign}{digits:0>2}")
                }
                None => text,
            }
        }
        other => other.to_string(),
    }
}

/// `value or {}`, which then has to be a dict for `.get` to work.
fn dict_or_empty(value: Option<&Value>) -> Result<Map<String, Value>> {
    match value {
        v if !truthy(v) => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        _ => Err("AttributeError: expected an object".into()),
    }
}

fn status_of(value: Option<&Value>) -> Option<&'static str> {
    let status = value?.as_str()?;
    STATUSES.into_iter().find(|s| *s == status)
}

fn new_task(subject: Value, active: Value, status: &str) -> Value {
    let mut task = Map::new();
    task.insert("subject".into(), subject);
    task.insert("active".into(), active);
    task.insert("status".into(), Value::String(status.into()));
    Value::Object(task)
}

/// Folds one PostToolUse event into the session's task list. Returns whether it changed.
fn apply_event(state: &mut Map<String, Value>, event: &Map<String, Value>) -> Result<bool> {
    let tool = event.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let given = dict_or_empty(event.get("tool_input"))?;
    let result = event.get("tool_response").filter(|v| truthy(Some(v)));
    let empty = Value::String(String::new());
    match tool {
        "TaskCreate" => {
            let task = match result {
                Some(Value::Object(result)) => dict_or_empty(result.get("task"))?,
                _ => Map::new(),
            };
            let tasks = tasks_mut(state)?;
            let count = Value::from(tasks.len() + 1);
            let id = py_str(or(task.get("id"), Some(&count)).unwrap());
            let subject = or(or(given.get("subject"), task.get("subject")), Some(&empty)).unwrap();
            let active = or(given.get("activeForm"), Some(&empty)).unwrap();
            tasks.insert(id, new_task(subject.clone(), active.clone(), "pending"));
            Ok(true)
        }
        "TaskUpdate" => {
            let id = match given.get("taskId") {
                id if truthy(id) => py_str(id.unwrap()),
                _ => py_str(or(dict_or_empty(result)?.get("taskId"), Some(&empty)).unwrap()),
            };
            if id.is_empty() {
                return Ok(false);
            }
            let tasks = tasks_mut(state)?;
            if given.get("status").and_then(Value::as_str) == Some("deleted") {
                return Ok(tasks.remove(&id).is_some());
            }
            let task = tasks
                .entry(id)
                .or_insert_with(|| new_task(empty.clone(), empty.clone(), "pending"))
                .as_object_mut()
                .ok_or("TypeError: a task isn't an object")?;
            if truthy(given.get("subject")) {
                task.insert("subject".into(), given["subject"].clone());
            }
            if truthy(given.get("activeForm")) {
                task.insert("active".into(), given["activeForm"].clone());
            }
            if let Some(status) = status_of(given.get("status")) {
                task.insert("status".into(), Value::String(status.into()));
            }
            Ok(true)
        }
        "TodoWrite" => {
            let todos = match given.get("todos") {
                v if !truthy(v) => Vec::new(),
                Some(Value::Array(todos)) => todos.clone(),
                _ => return Err("TypeError: todos isn't a list".into()),
            };
            let mut tasks = Map::new();
            for (i, todo) in todos.iter().enumerate() {
                let todo = todo
                    .as_object()
                    .ok_or("AttributeError: a todo isn't an object")?;
                let status = status_of(todo.get("status")).unwrap_or("pending");
                let subject = or(todo.get("content"), Some(&empty)).unwrap().clone();
                let active = or(todo.get("activeForm"), Some(&empty)).unwrap().clone();
                tasks.insert((i + 1).to_string(), new_task(subject, active, status));
            }
            state.insert("tasks".into(), Value::Object(tasks));
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn tasks_mut(state: &mut Map<String, Value>) -> Result<&mut Map<String, Value>> {
    state
        .entry("tasks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "TypeError: tasks isn't an object".into())
}

// ----------------------------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------------------------

/// Python's `str.isspace`: Rust's whitespace, plus the separators U+001C to U+001F.
fn is_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// `\w` in a Python `str` pattern.
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The first digit of each run of ten Unicode decimal digits (category Nd), as Python's
/// `unicodedata` 15.1 has them.
const DECIMAL_ZEROS: [u32; 68] = [
    0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66,
    0xDE6, 0xE50, 0xED0, 0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90,
    0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10,
    0x104A0, 0x10D30, 0x11066, 0x110F0, 0x11136, 0x111D0, 0x112F0, 0x11450, 0x114D0, 0x11650,
    0x116C0, 0x11730, 0x118E0, 0x11950, 0x11C50, 0x11D50, 0x11DA0, 0x11F50, 0x16A60, 0x16AC0,
    0x16B50, 0x1D7CE, 0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6, 0x1E140, 0x1E2F0, 0x1E4F0, 0x1E950,
    0x1FBF0,
];

/// The value of a Unicode decimal digit: a match for `\d` in a Python `str` pattern, and what
/// `int()` reads it as.
fn decimal(c: char) -> Option<u32> {
    let c = c as u32;
    let at = DECIMAL_ZEROS
        .partition_point(|&zero| zero <= c)
        .checked_sub(1)?;
    let value = c - DECIMAL_ZEROS[at];
    (value < 10).then_some(value)
}

/// Text on one line, with `<!--` shown as typed rather than opening a comment, so text can't
/// hide itself or end a section early with a copy of its marker.
fn one_line(text: &str) -> String {
    text.split(is_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .replace("<!--", "&lt;!--")
}

/// `git -C cwd args…`'s output, trimmed, or "" if it fails or takes over 3 seconds.
fn git(cwd: &str, args: &[&str]) -> String {
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return String::new();
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if !status.success()
                    || child
                        .stdout
                        .take()
                        .map(|mut o| o.read_to_string(&mut out))
                        .is_none()
                {
                    return String::new();
                }
                return out.trim_matches(is_space).to_string();
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return String::new();
            }
        }
    }
}

/// `owner/repo` of the session's GitHub `origin` remote, or "" when there isn't one. Follows
/// `github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`.
fn github_repo(cwd: &str) -> String {
    parse_github_url(&git(cwd, &["remote", "get-url", "origin"]))
}

fn parse_github_url(url: &str) -> String {
    let name_char = |c: char| is_word(c) || c == '.' || c == '-';
    for (at, _) in url.match_indices("github.com") {
        let rest = &url[at + "github.com".len()..];
        let Some(rest) = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/')) else {
            continue;
        };
        let Some((owner, name)) = rest.split_once('/') else {
            continue;
        };
        let name = name.strip_suffix('/').unwrap_or(name);
        if owner.is_empty()
            || !owner.chars().all(name_char)
            || name.is_empty()
            || !name.chars().all(name_char)
        {
            continue;
        }
        let name = match name.strip_suffix(".git") {
            Some(short) if !short.is_empty() => short,
            _ => name,
        };
        return format!("{owner}/{name}");
    }
    String::new()
}

/// `repo · branch` for a session's working directory, or the folder's name outside git.
fn place(cwd: &str) -> String {
    let top = git(cwd, &["rev-parse", "--show-toplevel"]);
    if top.is_empty() {
        let normal = normpath(cwd);
        let name = basename(&normal);
        return if name.is_empty() {
            cwd.to_string()
        } else {
            name.to_string()
        };
    }
    let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    // In a linked worktree, the top level is the worktree's own folder; name the repository
    // after the main checkout, which holds the shared .git directory.
    let common = git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    let name = if !common.is_empty() && basename(&normpath(&common)) == ".git" {
        basename(dirname(&normpath(&common))).to_string()
    } else {
        basename(&top).to_string()
    };
    if !branch.is_empty() && branch != "HEAD" {
        format!("{name} · {branch}")
    } else {
        name
    }
}

/// The transcript_path a hook event gives, or "" without one.
fn transcript_of(event: &Map<String, Value>) -> String {
    match event.get("transcript_path") {
        Some(Value::String(path)) => path.clone(),
        _ => String::new(),
    }
}

/// The session's transcript, for a command that has only its id: Claude Code keeps it as
/// <session>.jsonl in a folder per project, under ~/.claude/projects (or CLAUDE_CONFIG_DIR).
/// The first in order, as `sorted(glob.glob(…))` finds it.
fn find_transcript(session_id: &str) -> String {
    let config = match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => dir,
        _ => format!("{}/.claude", expand_user("~")),
    };
    let projects = format!("{}/projects", config.trim_end_matches('/'));
    let Ok(entries) = fs::read_dir(&projects) else {
        return String::new();
    };
    let mut found: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .map(|name| format!("{projects}/{name}/{session_id}.jsonl"))
        .filter(|path| fs::symlink_metadata(path).is_ok())
        .collect();
    found.sort();
    found.into_iter().next().unwrap_or_default()
}

/// Reads the session's name from its transcript into state["name"], from where the last read
/// stopped, so a long session's transcript isn't read again on every update.
fn read_name(state: &mut Map<String, Value>, transcript: &str) {
    let mut seen = match state.get("name") {
        Some(Value::Object(seen)) => seen.clone(),
        _ => Map::new(),
    };
    let fresh = |path: &str| {
        let mut seen = Map::new();
        seen.insert("path".into(), Value::String(path.into()));
        seen
    };
    if !transcript.is_empty() && seen.get("path").and_then(Value::as_str) != Some(transcript) {
        seen = fresh(transcript);
    }
    let path = match seen.get("path") {
        Some(Value::String(path)) if !path.is_empty() => path.clone(),
        _ => return,
    };
    let mut offset = seen.get("offset").and_then(Value::as_u64).unwrap_or(0);
    let chunk = (|| -> io::Result<Vec<u8>> {
        use std::io::{Seek, SeekFrom};
        let mut file = fs::File::open(&path)?;
        if offset > file.metadata()?.len() {
            // A new file in its place: start again.
            seen = fresh(&path);
            offset = 0;
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut chunk = Vec::new();
        file.read_to_end(&mut chunk)?;
        Ok(chunk)
    })();
    let Ok(chunk) = chunk else {
        return;
    };
    // Whole lines only: the last may still be being written.
    let done = chunk.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let has = |line: &[u8], needle: &[u8]| line.windows(needle.len()).any(|w| w == needle);
    for line in chunk[..done].split(|&b| b == b'\n') {
        if !has(line, b"\"custom-title\"") && !has(line, b"\"ai-title\"") {
            continue;
        }
        let Ok(Value::Object(entry)) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        for (kind, field) in TITLES {
            if entry.get("type").and_then(Value::as_str) == Some(kind) {
                if let Some(Value::String(name)) = entry.get(field) {
                    seen.insert(kind.into(), Value::String(name.clone()));
                }
            }
        }
    }
    seen.insert("offset".into(), Value::from(offset + done as u64));
    state.insert("name".into(), Value::Object(seen));
}

/// The name read_name found, on one line, or "" for none.
fn session_name(state: &Map<String, Value>) -> String {
    let Some(Value::Object(seen)) = state.get("name") else {
        return String::new();
    };
    TITLES
        .iter()
        .filter_map(|(kind, _)| seen.get(*kind).and_then(Value::as_str))
        .map(one_line)
        .find(|name| !name.is_empty())
        .unwrap_or_default()
}

/// How the board names a session: `repo · branch (name)`, or without the name for none.
fn label(place: &str, name: &str) -> String {
    let place = one_line(place);
    if name.is_empty() {
        place
    } else {
        format!("{place} ({name})")
    }
}

/// The start of a code span at `i`: `(?P<ticks>`+).*?(?<!`)(?P=ticks)(?!`)`, with the regex's
/// backtracking (fewer ticks are tried when the run can't be closed). Returns its end.
fn code_span_at(c: &[char], i: usize) -> Option<usize> {
    let run = c[i..].iter().take_while(|&&ch| ch == '`').count();
    for k in (1..=run).rev() {
        let mut e = i + k;
        loop {
            let closes = c[e - 1] != '`'
                && e + k <= c.len()
                && c[e..e + k].iter().all(|&ch| ch == '`')
                && c.get(e + k) != Some(&'`');
            if closes {
                return Some(e + k);
            }
            if e == c.len() || c[e] == '\n' {
                break;
            }
            e += 1;
        }
    }
    None
}

/// The end of a group opened at `p` by `open`: any text without `open` or `close`, or nested
/// groups one level deep, then `close`. (`(?:[^()]|\([^()]*\))*\)` and its `[`/`]` twin.)
fn group_end(c: &[char], mut p: usize, open: char, close: char) -> Option<usize> {
    loop {
        match *c.get(p)? {
            ch if ch == close => return Some(p + 1),
            ch if ch == open => {
                let q = p
                    + 1
                    + c[p + 1..]
                        .iter()
                        .position(|&ch| ch == open || ch == close)?;
                if c[q] != close {
                    return None;
                }
                p = q + 1;
            }
            _ => p += 1,
        }
    }
}

/// An existing link at `i`: `!?\[(?:[^\[\]]|\[[^\[\]]*\])*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])`.
fn link_at(c: &[char], i: usize) -> Option<usize> {
    let p = if c[i] == '!' { i + 1 } else { i };
    if c.get(p) != Some(&'[') {
        return None;
    }
    let p = group_end(c, p + 1, '[', ']')?;
    match c.get(p) {
        Some('(') => group_end(c, p + 1, '(', ')'),
        Some('[') => Some(p + 1 + c[p + 1..].iter().position(|&ch| ch == ']')? + 1),
        _ => None,
    }
}

struct Ref {
    end: usize,
    owner: Option<String>,
    repo: Option<String>,
    num: String,
}

/// A reference at `i`: `(?<![\w/\[#-])(?<!\]\()(?:(?P<owner>[\w.-]+)/)?(?P<repo>[\w.-]+)?#(?P<num>\d+)\b(?![\]\w])`.
fn ref_at(c: &[char], i: usize) -> Option<Ref> {
    if i > 0 && (is_word(c[i - 1]) || "/[#-".contains(c[i - 1])) {
        return None;
    }
    if i > 1 && c[i - 2] == ']' && c[i - 1] == '(' {
        return None;
    }
    let name_char = |ch: char| is_word(ch) || ch == '.' || ch == '-';
    let run_end = |from: usize| from + c[from..].iter().take_while(|&&ch| name_char(ch)).count();
    let text = |from: usize, to: usize| c[from..to].iter().collect::<String>();
    // The repo (optional), `#` and the number, from `p`.
    let rest = |p: usize| -> Option<(Option<String>, String, usize)> {
        let repo_end = run_end(p);
        if c.get(repo_end) != Some(&'#') {
            return None;
        }
        let digits = repo_end + 1;
        let end = digits
            + c[digits..]
                .iter()
                .take_while(|&&ch| decimal(ch).is_some())
                .count();
        if end == digits || c.get(end).is_some_and(|&ch| is_word(ch) || ch == ']') {
            return None;
        }
        let repo = (repo_end > p).then(|| text(p, repo_end));
        Some((repo, text(digits, end), end))
    };
    let owner_end = run_end(i);
    if owner_end > i && c.get(owner_end) == Some(&'/') {
        if let Some((repo, num, end)) = rest(owner_end + 1) {
            return Some(Ref {
                end,
                owner: Some(text(i, owner_end)),
                repo,
                num,
            });
        }
    }
    rest(i).map(|(repo, num, end)| Ref {
        end,
        owner: None,
        repo,
        num,
    })
}

/// Turns issue and pull request references into links, so the board is clickable. GitHub
/// redirects /issues/N to the pull request when N is one.
///
/// `owner/repo#12`, `#12` (the session's repo) or `repo#12` when it names the session's own repo.
/// Anything else, such as another owner's `repo#12`, stays text rather than becoming a wrong link.
/// Not inside an existing link's text (`[#9]`, `[Open Recent (#36)](url)`) or target (`](#12)`),
/// not in a code span, and not part of a word. A plain parenthesis is fine: "Open Recent (#36)" links.
fn link_refs(text: &str, repo: &str) -> String {
    let default_name = repo.split_once('/').map_or("", |(_, name)| name);
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        if let Some(end) = code_span_at(&c, i).or_else(|| link_at(&c, i)) {
            out.extend(&c[i..end]);
            i = end;
            continue;
        }
        let Some(found) = ref_at(&c, i) else {
            out.push(c[i]);
            i += 1;
            continue;
        };
        let matched: String = c[i..found.end].iter().collect();
        let target = match (&found.owner, &found.repo) {
            (Some(owner), Some(name)) => Some(format!("{owner}/{name}")),
            (_, Some(name)) => (!repo.is_empty()
                && name.to_lowercase() == default_name.to_lowercase())
            .then(|| repo.to_string()),
            _ => (!repo.is_empty()).then(|| repo.to_string()),
        };
        match target {
            Some(target) => out.push_str(&format!(
                "[{matched}](https://github.com/{target}/issues/{})",
                found.num
            )),
            None => out.push_str(&matched),
        }
        i = found.end;
    }
    out
}

/// The task ids in order: numbers first, by value, then the rest by text. A number may be in
/// any script's decimal digits (`١` is 1), as Python's `int()` reads it. Python would fail on an
/// id like `²`, which `isdigit()` accepts and `int()` doesn't; here it sorts with the text.
fn task_order(id: &str) -> (u128, &str) {
    let digits: Option<Vec<u32>> = id.chars().map(decimal).collect();
    let number = match digits {
        Some(digits) if !digits.is_empty() => digits
            .iter()
            .try_fold(0u128, |n, &d| n.checked_mul(10)?.checked_add(d.into()))
            .unwrap_or(u128::MAX),
        _ => 1 << 30,
    };
    (number, id)
}

fn render_section(
    session_id: &str,
    state: &Map<String, Value>,
    ended_at: Option<i64>,
    local_time: fn(i64) -> String,
) -> Result<String> {
    let no_tasks = Map::new();
    let tasks = match state.get("tasks") {
        None => &no_tasks,
        Some(Value::Object(tasks)) => tasks,
        Some(_) => return Err("AttributeError: tasks isn't an object".into()),
    };
    let mut ordered = Vec::new();
    for (id, task) in tasks {
        let task = task
            .as_object()
            .ok_or("TypeError: a task isn't an object")?;
        let field = |name: &str| task.get(name).ok_or(format!("KeyError('{name}')"));
        let status = status_of(Some(field("status")?)).ok_or("KeyError: an unknown status")?;
        ordered.push((
            id.as_str(),
            status,
            field("subject")?,
            task.get("active").unwrap_or(&Value::Null),
        ));
    }
    ordered.sort_by(|a, b| task_order(a.0).cmp(&task_order(b.0)));
    let repo = state.get("repo").map(py_str).unwrap_or_default();
    let doing: Vec<_> = ordered.iter().filter(|t| t.1 == "in_progress").collect();
    let now_line = if let Some(ended) = ended_at {
        format!("idle, the session ended at {}", local_time(ended))
    } else if !doing.is_empty() {
        let texts: Vec<String> = doing
            .iter()
            .map(|t| one_line(&py_str(or(Some(t.3), Some(t.2)).unwrap())))
            .collect();
        link_refs(&texts.join("; "), &repo)
    } else if !ordered.is_empty() && ordered.iter().all(|t| t.1 == "completed") {
        "all done".into()
    } else {
        "planning".into()
    };
    let meta = ended_at
        .map(|e| format!("ended={} ", iso_utc(e)))
        .unwrap_or_default();
    let place = match state.get("place") {
        p if truthy(p) => py_str(p.unwrap()),
        _ => "Claude Code".into(),
    };
    let mut lines = vec![
        format!("{START}{session_id} {meta}-->"),
        format!("## {}", label(&place, &session_name(state))),
        String::new(),
        format!("**Now:** {now_line}"),
        String::new(),
    ];
    for (_, status, subject, _) in &ordered {
        let mark = if *status == "completed" { "x" } else { " " };
        let mut text = link_refs(&one_line(&py_str(subject)), &repo);
        if text.is_empty() {
            text = "(untitled)".into();
        }
        if *status == "in_progress" {
            text = format!("**{text}**");
        }
        lines.push(format!("- [{mark}] {text}"));
    }
    if ordered.is_empty() {
        lines.push("_No tasks yet._".into());
    }
    lines.extend([
        String::new(),
        format!("<!-- markychecky:end {session_id} -->"),
        String::new(),
    ]);
    Ok(lines.join("\n"))
}

/// One session's section of the board, as `SECTION_RE` matches it:
/// `<!-- markychecky:start (?P<id>[\w.-]+) (?P<meta>[^>]*?)-->\n.*?<!-- markychecky:end (?P=id) -->\n?`
struct Section<'a> {
    start: usize,
    end: usize,
    id: &'a str,
    meta: &'a str,
}

fn section_at(board: &str, start: usize) -> Option<Section<'_>> {
    let id_start = start + START.len();
    let id_len: usize = board[id_start..]
        .chars()
        .take_while(|&c| is_word(c) || c == '.' || c == '-')
        .map(char::len_utf8)
        .sum();
    let id_end = id_start + id_len;
    if id_len == 0 || !board[id_end..].starts_with(' ') {
        return None;
    }
    let meta_start = id_end + 1;
    let mut p = meta_start;
    while !board[p..].starts_with("-->\n") {
        match board[p..].chars().next() {
            None | Some('>') => return None,
            Some(c) => p += c.len_utf8(),
        }
    }
    let body = p + 4;
    let id = &board[id_start..id_end];
    let end_marker = format!("<!-- markychecky:end {id} -->");
    let mut end = body + board[body..].find(&end_marker)? + end_marker.len();
    if board[end..].starts_with('\n') {
        end += 1;
    }
    Some(Section {
        start,
        end,
        id,
        meta: &board[meta_start..p],
    })
}

/// Every section of the board, in order, as `SECTION_RE.finditer` finds them.
fn sections(board: &str) -> Vec<Section<'_>> {
    let mut found = Vec::new();
    let mut pos = 0;
    while let Some(offset) = board[pos..].find(START) {
        let start = pos + offset;
        match section_at(board, start) {
            Some(section) => {
                pos = section.end;
                found.push(section);
            }
            None => pos = start + 1,
        }
    }
    found
}

/// `re.search(r"ended=(\S+)", meta)`
fn ended_value(meta: &str) -> Option<&str> {
    meta.match_indices("ended=").find_map(|(at, key)| {
        let rest = &meta[at + key.len()..];
        let len: usize = rest
            .chars()
            .take_while(|&c| !is_space(c))
            .map(char::len_utf8)
            .sum();
        (len > 0).then(|| &rest[..len])
    })
}

/// Removes sections whose session ended more than idle_hours ago.
fn sweep(board: &str, idle_hours: f64, keep: &str, now: i64) -> Result<String> {
    // timedelta(hours=…) and the subtraction both fail on what a datetime can't hold.
    let span = (idle_hours * 3_600_000_000.0).round_ties_even();
    let cutoff = now as f64 - span;
    if !idle_hours.is_finite() || !(MIN_MICROS as f64..MAX_MICROS as f64).contains(&cutoff) {
        return Err(format!(
            "OverflowError: idle_hours {idle_hours} is out of range"
        ));
    }
    let cutoff = cutoff as i64;
    let mut out = String::with_capacity(board.len());
    let mut pos = 0;
    for section in sections(board) {
        out.push_str(&board[pos..section.start]);
        pos = section.end;
        let expired = section.id != keep
            && ended_value(section.meta)
                .and_then(parse_iso)
                .is_some_and(|ended| ended < cutoff);
        if !expired {
            out.push_str(&board[section.start..section.end]);
        }
    }
    out.push_str(&board[pos..]);
    // A notification item whose session never ended (it crashed, say) goes after idle_hours
    // too. Items from `waiting add` have no time on them, and stay until they're removed.
    Ok(keep_lines(&out, |line| {
        let Some(&(start, _, _, at)) = notify_markers(line).first() else {
            return true;
        };
        // "waiting for your input" lines from before 0.5, which no longer makes them, go now.
        if line[..start].ends_with(": waiting for your input ") {
            return false;
        }
        !parse_iso(at).is_some_and(|at| at < cutoff)
    }))
}

/// The board with this session's section replaced, or added at the end.
fn replace_section(board: &str, session_id: &str, section: &str) -> String {
    let board = if board.trim_matches(is_space).is_empty() {
        TITLE
    } else {
        board
    };
    if let Some(found) = sections(board).into_iter().find(|s| s.id == session_id) {
        return format!("{}{section}{}", &board[..found.start], &board[found.end..]);
    }
    format!("{}\n\n{section}", board.trim_end_matches('\n'))
}

// ----------------------------------------------------------------------------------------------
// Waiting on you
// ----------------------------------------------------------------------------------------------

/// A "Waiting on you" heading on the line at `p`, as `WAITING_RE` matches it:
/// `^(?P<level>#{1,6})[ \t]+waiting on you[ \t]*#*[ \t]*$`, case-insensitively (where Python's
/// `re.I` also takes `İ` and `ı` for `i`). Returns the end of the line and the heading's level.
fn waiting_heading_at(board: &str, p: usize) -> Option<(usize, usize)> {
    let line_end = board[p..].find('\n').map_or(board.len(), |at| p + at);
    let line = &board[p..line_end];
    let level = line.bytes().take_while(|&b| b == b'#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = line[level..].trim_start_matches([' ', '\t']);
    if rest.len() == line.len() - level {
        return None;
    }
    let mut chars = rest.chars();
    for want in "waiting on you".chars() {
        let c = chars.next()?;
        let same = match want {
            'i' => matches!(c, 'i' | 'I' | '\u{130}' | '\u{131}'),
            ' ' => c == ' ',
            _ => c.to_ascii_lowercase() == want,
        };
        if !same {
            return None;
        }
    }
    let tail = chars
        .as_str()
        .trim_start_matches([' ', '\t'])
        .trim_start_matches('#')
        .trim_start_matches([' ', '\t']);
    tail.is_empty().then_some((line_end, level))
}

/// The start of each line of the board, from `from` on, as `^` finds them with `re.M`.
fn line_starts(board: &str, from: usize) -> impl Iterator<Item = usize> + '_ {
    let first = (from == 0 || board[..from].ends_with('\n')).then_some(from);
    first.into_iter().chain(
        board[from..]
            .match_indices('\n')
            .map(move |(at, _)| from + at + 1),
    )
}

/// (start of the body, end of the body) of the "Waiting on you" section outside any session's
/// section, or None. The body runs to the next heading of the same level or higher, or the next
/// session's section: `^(?:#{1,level}[ \t]|<!-- markychecky:start )`.
fn find_waiting(board: &str) -> Option<(usize, usize)> {
    let spans: Vec<(usize, usize)> = sections(board).iter().map(|s| (s.start, s.end)).collect();
    for p in line_starts(board, 0) {
        let Some((line_end, level)) = waiting_heading_at(board, p) else {
            continue;
        };
        if spans.iter().any(|&(a, b)| a <= p && p < b) {
            continue;
        }
        let body = (line_end + 1).min(board.len());
        let boundary = |q: usize| {
            let line = &board[q..];
            let hashes = line.bytes().take_while(|&b| b == b'#').count();
            line.starts_with(START)
                || ((1..=level).contains(&hashes)
                    && matches!(line.as_bytes().get(hashes), Some(b' ' | b'\t')))
        };
        let end = line_starts(board, body)
            .find(|&q| boundary(q))
            .unwrap_or(board.len());
        return Some((body, end));
    }
    None
}

/// The board with a "Waiting on you" section: a new one goes above the sessions' sections.
fn ensure_waiting(board: &str) -> String {
    let board = if board.trim_matches(is_space).is_empty() {
        TITLE
    } else {
        board
    };
    if find_waiting(board).is_some() {
        return board.to_string();
    }
    if let Some(first) = sections(board).first() {
        return format!(
            "{}{WAITING_HEADING}\n\n{}",
            &board[..first.start],
            &board[first.start..]
        );
    }
    format!("{}\n\n{WAITING_HEADING}\n", board.trim_end_matches('\n'))
}

/// The lines of the section's body, or none when it's blank.
fn body_lines(body: &str) -> Vec<String> {
    if body.trim_matches(is_space).is_empty() {
        return Vec::new();
    }
    body.trim_matches('\n')
        .split('\n')
        .map(String::from)
        .collect()
}

/// The board with the lines of "Waiting on you" replaced by edit(lines). Blank lines around
/// them are tidied; the lines themselves are kept exactly as edit returns them.
fn edit_waiting(board: &str, edit: impl FnOnce(Vec<String>) -> Vec<String>) -> String {
    let board = ensure_waiting(board);
    let Some((start, end)) = find_waiting(&board) else {
        return board;
    };
    let mut body: String = edit(body_lines(&board[start..end]))
        .iter()
        .map(|line| format!("{line}\n"))
        .collect();
    if !body.is_empty() && end < board.len() {
        body.push('\n'); // a blank line before what follows
    }
    if !body.is_empty() || end < board.len() {
        body.insert(0, '\n'); // and one after the heading
    }
    if !board[..start].ends_with('\n') {
        body.insert(0, '\n'); // the heading was the file's last line, with no newline
    }
    format!("{}{body}{}", &board[..start], &board[end..])
}

/// The lines of the section that aren't blank.
fn waiting_lines(board: &str) -> Vec<String> {
    let Some((start, end)) = find_waiting(board) else {
        return Vec::new();
    };
    body_lines(&board[start..end])
        .into_iter()
        .filter(|line| !line.trim_matches(is_space).is_empty())
        .collect()
}

/// A marker `<prefix><id> <rest>-->` at `at`, where `<id>` is a run of `id_char`s and `<rest>`
/// is what `rest` reads from the text after the id and its space, returning its end there.
/// Returns (the id, where the rest starts, the marker's end).
fn marker_at<'a>(
    line: &'a str,
    at: usize,
    prefix: &str,
    id_char: impl Fn(char) -> bool,
) -> Option<(&'a str, usize)> {
    let from = at + prefix.len();
    let rest = line
        .get(from..)
        .filter(|_| line[at..].starts_with(prefix))?;
    let len: usize = rest
        .chars()
        .take_while(|&c| id_char(c))
        .map(char::len_utf8)
        .sum();
    (len > 0).then(|| (&rest[..len], from + len))
}

/// The run of non-whitespace at `from` (`\S+`), if " -->" follows it, and the marker's end.
fn value_then_close(line: &str, from: usize) -> Option<(&str, usize)> {
    let rest = &line[from..];
    let len: usize = rest
        .chars()
        .take_while(|&c| !is_space(c))
        .map(char::len_utf8)
        .sum();
    (len > 0 && rest[len..].starts_with(" -->")).then(|| (&rest[..len], from + len + 4))
}

/// Each notification marker in a line, in order, as `NOTIFY_RE` finds them:
/// `<!-- markychecky:notify (?P<session>[\w.-]+)(?: agent=(?P<agent>[\w.-]+))? at=(?P<at>\S+) -->`.
/// Gives (start, session, agent, at), with "" for no agent.
fn notify_markers(line: &str) -> Vec<(usize, &str, &str, &str)> {
    let id_char = |c: char| is_word(c) || c == '.' || c == '-';
    // ` at=(?P<at>\S+) -->` at `from`.
    let time_at = |from: usize| {
        line[from..]
            .strip_prefix(" at=")
            .and_then(|_| value_then_close(line, from + 4))
            .map(|(time, _)| time)
    };
    let mut found = Vec::new();
    for (at, _) in line.match_indices(NOTIFY) {
        let Some((session, after)) = marker_at(line, at, NOTIFY, id_char) else {
            continue;
        };
        // The optional group first, as the regex tries it, then without it.
        let with_agent = marker_at(line, after, " agent=", id_char)
            .and_then(|(agent, end)| Some((agent, time_at(end)?)));
        if let Some((agent, time)) = with_agent {
            found.push((at, session, agent, time));
        } else if let Some(time) = time_at(after) {
            found.push((at, session, "", time));
        }
    }
    found
}

/// The first item marker in a line, with the whitespace before it, as
/// `\s*<!-- markychecky:item (\S+) -->` searches for it. Gives (start, end, id).
fn item_marker(line: &str) -> Option<(usize, usize, &str)> {
    line.match_indices(ITEM).find_map(|(at, _)| {
        let (id, end) = value_then_close(line, at + ITEM.len())?;
        let space: usize = line[..at]
            .chars()
            .rev()
            .take_while(|&c| is_space(c))
            .map(char::len_utf8)
            .sum();
        Some((at - space, end, id))
    })
}

/// The board with only the lines `keep` keeps, each with its newline.
fn keep_lines(board: &str, mut keep: impl FnMut(&str) -> bool) -> String {
    board
        .split_inclusive('\n')
        .filter(|piece| keep(piece.strip_suffix('\n').unwrap_or(piece)))
        .collect()
}

/// The board without this session's notification items, or only those of the given agents
/// ("" for the session's main agent).
fn without_notify(board: &str, session_id: &str, agents: Option<&[String]>) -> String {
    keep_lines(board, |line| {
        // As `re.sub` does, only the line's first marker decides.
        !notify_markers(line)
            .first()
            .is_some_and(|&(_, session, agent, _)| {
                session == session_id
                    && agents.is_none_or(|agents| agents.iter().any(|a| a == agent))
            })
    })
}

/// (what a Notification event is waiting on, what answers it), or None for one that isn't
/// waiting on the user.
fn notification_text(event: &Map<String, Value>) -> Result<Option<(String, &'static str)>> {
    let message = match event.get("message") {
        m if truthy(m) => one_line(&py_str(m.unwrap())),
        _ => String::new(),
    };
    // `permission to use ([\w-]+)`
    let tool = message
        .match_indices("permission to use ")
        .find_map(|(at, phrase)| {
            let rest = &message[at + phrase.len()..];
            let len: usize = rest
                .chars()
                .take_while(|&c| is_word(c) || c == '-')
                .map(char::len_utf8)
                .sum();
            (len > 0).then(|| rest[..len].to_string())
        });
    let kind = match event.get("notification_type") {
        // From a Claude Code without notification types, which sent only these two.
        k if !truthy(k) && tool.is_some() => "permission_prompt",
        k if !truthy(k) => "idle_prompt",
        Some(Value::String(kind)) => kind.as_str(),
        Some(Value::Array(_) | Value::Object(_)) => {
            return Err("TypeError: unhashable notification_type".into())
        }
        _ => return Ok(None),
    };
    let Some(&(_, waits)) = WAITS.iter().find(|(name, _)| *name == kind) else {
        return Ok(None);
    };
    let text = if kind.ends_with("permission_prompt") {
        match tool {
            Some(tool) => format!("needs permission to use {tool}"),
            None => "needs your permission".into(),
        }
    } else {
        "has a question for you".into()
    };
    Ok(Some((text, waits)))
}

/// The session's notification items, as notify saved them: what each agent's waits on and when
/// it was raised. None without any.
fn read_flag(path: &str) -> Option<Map<String, Value>> {
    let bytes = fs::read(path).ok()?;
    let text = String::from_utf8(bytes).unwrap_or_default();
    let text = if text.is_empty() { "{}" } else { &text };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(mut flag)) => {
            flag.retain(|_, item| item.is_object());
            Some(flag)
        }
        _ => Some(Map::new()),
    }
}

fn save_flag(path: &str, flag: &Map<String, Value>) -> Result<()> {
    if flag.is_empty() {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    fs::write(path, Value::Object(flag.clone()).to_string()).map_err(|e| e.to_string())
}

/// Whether this respond event, which started at `started`, answers the agent's notification.
fn answers(event: &Map<String, Value>, agent: &str, item: &Value, started: i64) -> bool {
    let at = item.get("at").and_then(Value::as_str).and_then(parse_iso);
    if at.is_some_and(|at| at > started) {
        return false; // raised after the user answered, so it's a new one
    }
    let name = event.get("hook_event_name");
    if !truthy(name) {
        return true;
    }
    let waits = item.get("waits").and_then(Value::as_str);
    let own = agent == session_id(event.get("agent_id"));
    match name.and_then(Value::as_str) {
        // A prompt answers whatever waits on one, and anything the agent it comes from waits on.
        Some("UserPromptSubmit") => waits == Some("prompt") || own,
        // A permission dialog holds up its batch, so the batch resolving means it was answered.
        // A subagent's batch answers only its own dialog: subagents share the session's id.
        Some("PostToolBatch") => waits != Some("prompt") && own,
        _ => false,
    }
}

fn answered(
    event: &Map<String, Value>,
    flag: Option<&Map<String, Value>>,
    started: i64,
) -> Vec<String> {
    flag.into_iter()
        .flatten()
        .filter(|(agent, item)| answers(event, agent, item, started))
        .map(|(agent, _)| agent.clone())
        .collect()
}

// ----------------------------------------------------------------------------------------------
// The `waiting` commands, which a session runs itself
// ----------------------------------------------------------------------------------------------

const WAITING_USAGE: &str = "usage: markychecky waiting {add,remove,list} [--board BOARD] [--session SESSION] [--key KEY] [text ...]";

const WAITING_HELP: &str = "Edit the board's \"Waiting on you\" section.

  waiting add --key KEY TEXT...   add or update this session's item
  waiting remove --key KEY        remove an item: this session's KEY, or SESSION/KEY
  waiting list                    print the section

options:
  --board BOARD      the board (default: the plugin's file setting, or ~/markychecky.md)
  --session SESSION  the session the item belongs to
  --key KEY          a short id for the item, such as release-v1";

/// A mistake in how a command was called: the usage, then the error, and exit status 2, as
/// Python's argparse does it.
fn usage_error(action: &str, message: &str) -> i32 {
    let prog = if action.is_empty() {
        "markychecky waiting".to_string()
    } else {
        format!("markychecky waiting {action}")
    };
    eprintln!("{WAITING_USAGE}\n{prog}: error: {message}");
    2
}

/// `waiting add|remove|list`. Unlike the hooks, these say what they did, and a mistake in how
/// they're called fails the command.
fn run_waiting(args: &[String]) -> Result<i32> {
    if args.is_empty() {
        return Ok(usage_error(
            "",
            "the following arguments are required: action",
        ));
    }
    if matches!(args[0].as_str(), "-h" | "--help") {
        println!("{WAITING_USAGE}\n\n{WAITING_HELP}");
        return Ok(0);
    }
    let action = args[0].as_str();
    if !matches!(action, "add" | "remove" | "list") {
        return Ok(usage_error(
            "",
            &format!("argument action: invalid choice: '{action}' (choose from add, remove, list)"),
        ));
    }
    let names: &[&str] = if action == "list" {
        &["board", "session"]
    } else {
        &["board", "session", "key"]
    };
    let mut board = setting("FILE", "~/markychecky.md");
    let mut session = match std::env::var("CLAUDE_SESSION_ID") {
        Ok(id) if !id.is_empty() => id,
        _ => "cli".into(),
    };
    let mut key: Option<String> = None;
    let mut text: Vec<String> = Vec::new();
    let mut rest = args[1..].iter();
    let mut options_done = false;
    while let Some(arg) = rest.next() {
        if options_done || !arg.starts_with('-') || arg == "-" {
            if action != "add" {
                return Ok(usage_error("", &format!("unrecognized arguments: {arg}")));
            }
            text.push(arg.clone());
            continue;
        }
        if arg == "--" {
            options_done = true;
            continue;
        }
        if matches!(arg.as_str(), "-h" | "--help") {
            println!("{WAITING_USAGE}\n\n{WAITING_HELP}");
            return Ok(0);
        }
        let (given, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (arg.as_str(), None),
        };
        // An option's name, or any prefix of one that names only it.
        let matching: Vec<&str> = given
            .strip_prefix("--")
            .filter(|name| !name.is_empty())
            .map(|name| {
                names
                    .iter()
                    .copied()
                    .filter(|n| n.starts_with(name))
                    .collect()
            })
            .unwrap_or_default();
        let [name] = matching[..] else {
            return Ok(usage_error("", &format!("unrecognized arguments: {arg}")));
        };
        let value = match inline {
            Some(value) => value,
            None => match rest.next() {
                Some(value) if !value.starts_with('-') || value == "-" => value.clone(),
                _ => {
                    return Ok(usage_error(
                        action,
                        &format!("argument --{name}: expected one argument"),
                    ))
                }
            },
        };
        match name {
            "board" => board = value,
            "session" => session = value,
            _ => key = Some(value),
        }
    }
    let session: String = session
        .chars()
        .filter(|&c| is_word(c) || c == '.' || c == '-')
        .take(64)
        .collect();
    let session = if session.is_empty() {
        "cli".to_string()
    } else {
        session
    };

    if action == "list" {
        let text = match fs::read(expand_user(&board)) {
            Ok(bytes) => String::from_utf8(bytes)
                .map_err(|e| format!("UnicodeDecodeError({e})"))?
                .replace("\r\n", "\n")
                .replace('\r', "\n"),
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        };
        let lines = waiting_lines(&text);
        for line in &lines {
            if let Some((start, end, id)) = item_marker(line) {
                println!("{}{}  (key: {id})", &line[..start], &line[end..]);
            } else if let Some(&(start, _, _, _)) = notify_markers(line).first() {
                println!(
                    "{}  (a notification; it clears itself)",
                    line[..start].trim_end_matches(is_space)
                );
            } else {
                println!("{line}  (written by hand; the commands leave it alone)");
            }
        }
        if lines.is_empty() {
            println!("Nothing is waiting on you.");
        }
        return Ok(0);
    }

    let required: Vec<&str> = [
        key.is_none().then_some("--key"),
        (action == "add" && text.is_empty()).then_some("text"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !required.is_empty() {
        return Ok(usage_error(
            action,
            &format!(
                "the following arguments are required: {}",
                required.join(", ")
            ),
        ));
    }
    let given_key = key.unwrap_or_default();
    let (owner, item_key) = given_key.rsplit_once('/').unwrap_or(("", &given_key));
    let owner = if owner.is_empty() { &session } else { owner };
    let valid = |id: &str| {
        (1..=64).contains(&id.chars().count())
            && id.chars().all(|c| is_word(c) || c == '.' || c == '-')
    };
    if !valid(item_key) || !valid(owner) {
        return Ok(usage_error(
            action,
            &format!(
                "--key '{given_key}': use letters, digits, '.', '-' and '_', such as release-v1"
            ),
        ));
    }
    let item_id = format!("{owner}/{item_key}");
    let marker = format!("{ITEM}{item_id} -->");
    let settings = board_settings(&board)?;
    if !settings.waiting {
        eprintln!(
            "markychecky: \"Waiting on you\" is turned off in the plugin's settings; nothing changed."
        );
        return Ok(0);
    }

    if action == "add" {
        let cwd = current_dir()?;
        let text = link_refs(&one_line(&text.join(" ")), &github_repo(&cwd));
        let place = place(&cwd);
        // The session's state, to open the board on its first write as the hooks do, is in the
        // plugin's data folder, which this command only knows from what SessionStart saved.
        let state_path = settings
            .data
            .as_ref()
            .map(|data| format!("{data}/sessions/{session}.json"));
        let mut opening = false;
        let mut shown = String::new();
        let created = write_board(
            &board,
            |old| {
                // The line names the session it's from, which is in its transcript.
                let known = state_path
                    .as_ref()
                    .filter(|path| std::path::Path::new(dirname(path)).is_dir());
                let mut state = known.map(|path| load_state(path)).unwrap_or_default();
                let cached = state
                    .get("name")
                    .and_then(|seen| seen.get("path"))
                    .is_some_and(|path| truthy(Some(path)));
                let transcript = if cached {
                    String::new()
                } else {
                    find_transcript(&session)
                };
                read_name(&mut state, &transcript);
                if let Some(state_path) = known {
                    if first_open(&mut state) {
                        opening = true;
                    }
                    save_state(state_path, &state)?;
                }
                let line = format!(
                    "- {}: {text} {marker}",
                    label(&place, &session_name(&state))
                );
                shown = line[2..line.len() - marker.len() - 1].to_string();
                Ok(edit_waiting(old, |lines| {
                    if lines.iter().any(|old| old.contains(&marker)) {
                        lines
                            .into_iter()
                            .map(|old| {
                                if old.contains(&marker) {
                                    line.clone()
                                } else {
                                    old
                                }
                            })
                            .collect()
                    } else {
                        let mut lines = lines;
                        lines.push(line.clone());
                        lines
                    }
                }))
            },
            settings.data.as_deref(),
        )?;
        if created || opening {
            open_in_markydowny(&board, Some(settings.open));
        }
        println!("Added {item_id}: {shown}");
        return Ok(0);
    }

    let mut found = false;
    write_board(
        &board,
        |old| {
            if find_waiting(old).is_none()
                || !waiting_lines(old).iter().any(|line| line.contains(&marker))
            {
                return Ok(old.to_string());
            }
            found = true;
            Ok(edit_waiting(old, |lines| {
                lines
                    .into_iter()
                    .filter(|line| !line.contains(&marker))
                    .collect()
            }))
        },
        settings.data.as_deref(),
    )?;
    if !found {
        eprintln!("No item {item_id} on the board; nothing changed.");
        return Ok(1);
    }
    println!("Removed {item_id}");
    Ok(0)
}

struct BoardSettings {
    waiting: bool,
    open: bool,
    data: Option<String>,
}

/// The options as the `waiting` commands see them: from the environment when it has them, as
/// the hooks do, or else from what SessionStart last saved beside the board.
fn board_settings(board: &str) -> Result<BoardSettings> {
    let path = beside(&abspath(&expand_user(board))?, ".settings.json");
    let saved = match fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(Value::Object(saved)) => saved,
        _ => Map::new(),
    };
    let option = |name: &str| {
        if !setting(name, "").is_empty() {
            on(name)
        } else {
            saved.get(&name.to_lowercase()) != Some(&Value::Bool(false))
        }
    };
    Ok(BoardSettings {
        waiting: option("WAITING"),
        open: option("OPEN"),
        data: saved.get("data").and_then(Value::as_str).map(String::from),
    })
}

// ----------------------------------------------------------------------------------------------
// Writing the board
// ----------------------------------------------------------------------------------------------

/// Applies update(board_text) -> new text under a lock, and swaps the file in atomically.
/// Returns whether the board was created by this call. With the plugin's data folder, it takes
/// the lock 0.3 took there as well.
fn write_board(
    path: &str,
    update: impl FnOnce(&str) -> Result<String>,
    data: Option<&str>,
) -> Result<bool> {
    let path = abspath(&expand_user(path))?;
    let dir = dirname(&path).to_string();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // The same lock file as the Python script's, so the two can't write at once. It sits next to
    // the board, not in the plugin's data folder, so the `waiting` commands a session runs
    // itself, which don't get the plugin's environment, take the same one.
    let lock_path = beside(&path, ".lock");
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    take_lock(&lock)?;
    // Sessions started before 0.4 lock a file in the plugin's data folder instead, so this takes
    // that one too, after its own. Drop it once no 0.3 session can still be running.
    let _old_lock = match data.filter(|data| fs::metadata(data).is_ok_and(|m| m.is_dir())) {
        Some(data) => {
            let old = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(format!(
                    "{data}/board-{}.lock",
                    &sha1_hex(path.as_bytes())[..16]
                ))
                .map_err(|e| e.to_string())?;
            take_lock(&old)?;
            Some(old)
        }
        None => None,
    };
    let (before, created) = match fs::read(&path) {
        Ok(bytes) => {
            let text = String::from_utf8(bytes).map_err(|e| format!("UnicodeDecodeError({e})"))?;
            // Python reads text with universal newlines.
            (text.replace("\r\n", "\n").replace('\r', "\n"), false)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => (String::new(), true),
        Err(e) => return Err(e.to_string()),
    };
    let after = update(&before)?;
    if after == before {
        return Ok(false);
    }
    let (tmp, mut file) = temp_file(&dir, &format!(".{}.", basename(&path)))?;
    let written = (|| -> io::Result<()> {
        file.write_all(after.as_bytes())?;
        drop(file);
        let mode = if created {
            0o644
        } else {
            fs::metadata(&path)?.permissions().mode() & 0o7777
        };
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        fs::rename(&tmp, &path)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(created)
}

fn take_lock(lock: &fs::File) -> Result<()> {
    loop {
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error.to_string());
        }
    }
}

/// `tempfile.mkstemp(prefix=…, dir=…)`: a new file only this process can read, named like
/// Python's.
fn temp_file(dir: &str, prefix: &str) -> Result<(String, fs::File)> {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789_";
    let seed = RandomState::new();
    for attempt in 0..100u32 {
        let mut hasher = seed.build_hasher();
        hasher.write_u32(attempt);
        let mut bits = hasher.finish();
        let name: String = (0..8)
            .map(|_| {
                let c = CHARS[(bits % CHARS.len() as u64) as usize] as char;
                bits /= CHARS.len() as u64;
                c
            })
            .collect();
        let path = format!("{dir}/{prefix}{name}");
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("FileExistsError: no usable temporary file name".into())
}

/// The hidden file beside the board with this suffix: `.<board><suffix>`, as Python's
/// `os.path.join(dirname, …)` names it.
fn beside(board: &str, suffix: &str) -> String {
    let dir = dirname(board);
    let name = basename(board);
    if dir.is_empty() || dir.ends_with('/') {
        format!("{dir}.{name}{suffix}")
    } else {
        format!("{dir}/.{name}{suffix}")
    }
}

/// Opens the board in Markydowny, in the background, on a session's first write: this app when
/// it's a Mac app bundle, or else an installed Markydowny. macOS only, as in the Python script.
/// `enabled` is the `open` option when the caller has it, or else it's read from the environment.
fn open_in_markydowny(path: &str, enabled: Option<bool>) {
    if !cfg!(target_os = "macos") || !enabled.unwrap_or_else(|| on("OPEN")) {
        return;
    }
    let quiet = |args: &[&str]| {
        Command::new("open")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    let app = std::env::current_exe().ok().and_then(|exe| {
        let bundle = exe.parent()?.parent()?.parent()?;
        bundle
            .extension()
            .is_some_and(|e| e == "app")
            .then(|| bundle.to_string_lossy().into_owned())
    });
    let app = match app {
        Some(app) => app,
        None if quiet(&["-Ra", "Markydowny"]) => "Markydowny".into(),
        None => return, // not installed
    };
    // -g leaves the terminal in front; Markydowny doesn't take focus for a file it already shows.
    quiet(&["-g", "-a", &app, &expand_user(path)]);
}

// ----------------------------------------------------------------------------------------------
// Paths, as Python's os.path does them on POSIX
// ----------------------------------------------------------------------------------------------

fn basename(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => {
            let head = &path[..at + 1];
            let trimmed = head.trim_end_matches('/');
            if trimmed.is_empty() {
                head
            } else {
                trimmed
            }
        }
        None => "",
    }
}

/// `os.path.normpath`
fn normpath(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let slashes = path.len() - path.trim_start_matches('/').len();
    let root = match slashes {
        0 => "",
        2 => "//",
        _ => "/",
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            ".." if !root.is_empty() => {}
            _ => parts.push(part),
        }
    }
    let joined = format!("{root}{}", parts.join("/"));
    if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}

/// `os.path.abspath`
fn abspath(path: &str) -> Result<String> {
    if path.starts_with('/') {
        return Ok(normpath(path));
    }
    Ok(normpath(&format!("{}/{path}", current_dir()?)))
}

/// `os.path.expanduser`
fn expand_user(path: &str) -> String {
    if !path.starts_with('~') {
        return path.to_string();
    }
    let split = path[1..].find('/').map_or(path.len(), |at| at + 1);
    let home = if split == 1 {
        match std::env::var("HOME") {
            Ok(home) => Some(home),
            Err(_) => home_of(unsafe { libc::getpwuid(libc::getuid()) }),
        }
    } else {
        CString::new(&path[1..split])
            .ok()
            .and_then(|name| home_of(unsafe { libc::getpwnam(name.as_ptr()) }))
    };
    let Some(home) = home else {
        return path.to_string();
    };
    let joined = format!("{}{}", home.trim_end_matches('/'), &path[split..]);
    if joined.is_empty() {
        "/".into()
    } else {
        joined
    }
}

fn home_of(entry: *mut libc::passwd) -> Option<String> {
    if entry.is_null() {
        return None;
    }
    let dir = unsafe { CStr::from_ptr((*entry).pw_dir) };
    Some(
        std::ffi::OsStr::from_bytes(dir.to_bytes())
            .to_string_lossy()
            .into_owned(),
    )
}

// ----------------------------------------------------------------------------------------------
// Times: microseconds since the Unix epoch, written and read as Python's datetime does
// ----------------------------------------------------------------------------------------------

/// 0001-01-01 and 10000-01-01, the range of a Python datetime.
const MIN_MICROS: i64 = -62_135_596_800_000_000;
const MAX_MICROS: i64 = 253_402_300_800_000_000;

fn now_micros() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as i64)
}

/// Days since 1970-01-01 to (year, month, day), and back (Howard Hinnant's algorithms).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `datetime.isoformat()` of a UTC time: `2026-11-18T16:45:32.123456+00:00`, without the
/// fraction when it's zero.
fn iso_utc(micros: i64) -> String {
    let secs = micros.div_euclid(1_000_000);
    let fraction = micros.rem_euclid(1_000_000);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    let fraction = if fraction == 0 {
        String::new()
    } else {
        format!(".{fraction:06}")
    };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}{fraction}+00:00",
        t / 3600,
        t / 60 % 60,
        t % 60
    )
}

/// `datetime.fromisoformat()` of a time with a UTC offset, in microseconds. None for one it
/// can't read or without an offset, which Python can't compare with an aware time; either way
/// the section is kept.
fn parse_iso(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let digits = b.get(from..from + len)?;
        digits
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| std::str::from_utf8(digits).ok()?.parse().ok())?
    };
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || year < 1 || !(1..=12).contains(&month)
    {
        return None;
    }
    let month_days = [
        31,
        if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
            29
        } else {
            28
        },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day < 1 || day > month_days[month as usize - 1] {
        return None;
    }
    // Any one character separates the date from the time.
    let time = text
        .get(10..)?
        .chars()
        .next()
        .map(|sep| &text[10 + sep.len_utf8()..])?;
    let offset_at = time.find(['+', '-', 'Z'])?;
    let (clock, zone) = time.split_at(offset_at);
    let clock_micros = parse_clock(clock)?;
    let offset = match zone {
        "Z" => 0,
        _ => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            sign * parse_clock(&zone[1..])?
        }
    };
    let micros =
        days_from_civil(year, month as u32, day as u32) * 86_400_000_000 + clock_micros - offset;
    Some(micros)
}

/// A time of day or a UTC offset in microseconds, as `fromisoformat` reads both: `HH[:MM[:SS]]`
/// or `HH[MM[SS]]`, then optionally `.` or `,` and a fraction.
fn parse_clock(text: &str) -> Option<i64> {
    let (whole, fraction) = match text.find(['.', ',']) {
        Some(at) => (&text[..at], Some(&text[at + 1..])),
        None => (text, None),
    };
    let parts: Vec<&str> = if whole.contains(':') {
        whole.split(':').collect()
    } else if whole.is_ascii() && whole.len() % 2 == 0 {
        (0..whole.len())
            .step_by(2)
            .map(|i| &whole[i..i + 2])
            .collect()
    } else {
        return None;
    };
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut values = [0i64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.len() != 2 || !part.bytes().all(|d| d.is_ascii_digit()) {
            return None;
        }
        values[i] = part.parse().ok()?;
    }
    let [h, m, s] = values;
    if h > 23 || m > 59 || s > 59 {
        return None;
    }
    let micros = match fraction {
        None => 0,
        Some(f) if !f.is_empty() && f.bytes().all(|d| d.is_ascii_digit()) => {
            format!("{:0<6}", &f[..f.len().min(6)]).parse().ok()?
        }
        Some(_) => return None,
    };
    Some(((h * 60 + m) * 60 + s) * 1_000_000 + micros)
}

/// `HH:MM` of a time in the local time zone, as `astimezone().strftime('%H:%M')`.
fn local_hh_mm(micros: i64) -> String {
    extern "C" {
        fn tzset();
    }
    let secs = micros.div_euclid(1_000_000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        tzset();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            let t = micros.div_euclid(1_000_000).rem_euclid(86_400);
            return format!("{:02}:{:02}", t / 3600, t / 60 % 60);
        }
    }
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}

/// Python's `float()` of a setting: surrounding whitespace, `inf`, `nan` and underscores
/// between digits are all allowed.
fn parse_float(text: &str) -> Option<f64> {
    let text = text.trim_matches(is_space);
    let b = text.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    if (0..b.len()).any(|i| b[i] == b'_' && !(i > 0 && digit(i - 1) && digit(i + 1))) {
        return None;
    }
    text.replace('_', "").parse().ok()
}

// ----------------------------------------------------------------------------------------------
// SHA-1, for the name of the lock 0.3 took
// ----------------------------------------------------------------------------------------------

fn sha1_hex(data: &[u8]) -> String {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, &word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn create(id: &str, subject: &str, active: &str) -> Map<String, Value> {
        obj(json!({
            "tool_name": "TaskCreate",
            "tool_input": {"subject": subject, "description": "details", "activeForm": active},
            "tool_response": {"task": {"id": id, "subject": subject}},
        }))
    }

    fn update(id: &str, input: Value) -> Map<String, Value> {
        let mut given = obj(input);
        given.insert("taskId".into(), json!(id));
        obj(
            json!({"tool_name": "TaskUpdate", "tool_input": given, "tool_response": {"success": true, "taskId": id}}),
        )
    }

    fn state_after(events: &[Map<String, Value>]) -> Map<String, Value> {
        let mut state = obj(json!({"tasks": {}}));
        for event in events {
            apply_event(&mut state, event).unwrap();
        }
        state
    }

    fn render(state: &Map<String, Value>) -> String {
        render_section("s1", state, None, |_| "12:34".into()).unwrap()
    }

    // Task events

    #[test]
    fn task_create_update_and_delete_build_the_list() {
        let state = state_after(&[
            create("1", "Keep", "Keeping"),
            create("2", "Drop", ""),
            update("2", json!({"status": "deleted"})),
            update(
                "1",
                json!({"subject": "Keep, renamed", "status": "in_progress"}),
            ),
        ]);
        assert_eq!(
            state["tasks"],
            json!({"1": {"subject": "Keep, renamed", "active": "Keeping", "status": "in_progress"}})
        );
    }

    #[test]
    fn task_create_without_an_id_numbers_it_and_unknown_tools_change_nothing() {
        let mut state = obj(json!({"tasks": {}}));
        let event = obj(json!({"tool_name": "TaskCreate", "tool_input": {"subject": "A"}}));
        assert!(apply_event(&mut state, &event).unwrap());
        assert!(apply_event(&mut state, &event).unwrap());
        assert_eq!(
            state["tasks"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["1", "2"]
        );
        assert!(!apply_event(&mut state, &obj(json!({"tool_name": "Bash"}))).unwrap());
        assert!(!apply_event(
            &mut state,
            &obj(json!({"tool_name": "TaskUpdate", "tool_input": {}}))
        )
        .unwrap());
        // Deleting a task that isn't there is no change.
        assert!(!apply_event(&mut state, &update("9", json!({"status": "deleted"}))).unwrap());
    }

    #[test]
    fn task_update_ignores_unknown_statuses_and_reads_numeric_ids() {
        let state = state_after(&[
            obj(
                json!({"tool_name": "TaskCreate", "tool_input": {"subject": "N"}, "tool_response": {"task": {"id": 3}}}),
            ),
            obj(
                json!({"tool_name": "TaskUpdate", "tool_input": {"taskId": 3, "status": "blocked"}}),
            ),
        ]);
        assert_eq!(state["tasks"]["3"]["status"], "pending");
    }

    #[test]
    fn todo_write_replaces_the_whole_list() {
        let state = state_after(&[
            create("1", "Old", ""),
            obj(json!({"tool_name": "TodoWrite", "tool_input": {"todos": [
                {"content": "One", "status": "completed", "activeForm": "Doing one"},
                {"content": "Two", "status": "weird"},
            ]}})),
        ]);
        assert_eq!(
            state["tasks"],
            json!({
                "1": {"subject": "One", "active": "Doing one", "status": "completed"},
                "2": {"subject": "Two", "active": "", "status": "pending"},
            })
        );
    }

    // Rendering

    #[test]
    fn a_section_has_now_then_the_checklist_in_task_order() {
        let mut state = state_after(&[
            create("10", "Ten", ""),
            create("2", "Two", "Doing two"),
            create("x", "", ""),
            update("2", json!({"status": "in_progress"})),
        ]);
        state.insert("place".into(), json!("widgets · main"));
        assert_eq!(
            render(&state),
            "<!-- markychecky:start s1 -->\n## widgets · main\n\n**Now:** Doing two\n\n\
             - [ ] **Two**\n- [ ] Ten\n- [ ] (untitled)\n\n<!-- markychecky:end s1 -->\n"
        );
    }

    #[test]
    fn now_says_planning_all_done_or_idle() {
        let empty = obj(json!({"tasks": {}}));
        assert!(render(&empty).contains("## Claude Code\n\n**Now:** planning\n\n_No tasks yet._\n"));
        let done = state_after(&[
            create("1", "A", ""),
            update("1", json!({"status": "completed"})),
        ]);
        assert!(render(&done).contains("**Now:** all done\n\n- [x] A\n"));
        let ended = render_section("s1", &done, Some(0), |_| "01:00".into()).unwrap();
        assert!(
            ended.starts_with("<!-- markychecky:start s1 ended=1970-01-01T00:00:00+00:00 -->\n")
        );
        assert!(ended.contains("**Now:** idle, the session ended at 01:00\n"));
    }

    #[test]
    fn text_stays_on_one_line_and_cant_open_a_comment() {
        assert_eq!(
            one_line(" Fix  the\nnewline\u{1f}— é 🎉\t"),
            "Fix the newline — é 🎉"
        );
        assert_eq!(
            one_line("a <!-- markychecky:end s1 --> b"),
            "a &lt;!-- markychecky:end s1 --> b"
        );
    }

    // References

    fn link(text: &str) -> String {
        link_refs(text, "acme/widgets")
    }

    #[test]
    fn references_link_into_the_sessions_repository() {
        assert_eq!(
            link("Merge #18, then widgets#19 and other-org/tools#5"),
            "Merge [#18](https://github.com/acme/widgets/issues/18), then \
             [widgets#19](https://github.com/acme/widgets/issues/19) and \
             [other-org/tools#5](https://github.com/other-org/tools/issues/5)"
        );
        assert_eq!(
            link("Open Recent (#36)"),
            "Open Recent ([#36](https://github.com/acme/widgets/issues/36))"
        );
        assert_eq!(
            link("Widgets#2"),
            "[Widgets#2](https://github.com/acme/widgets/issues/2)"
        );
    }

    #[test]
    fn references_take_any_scripts_decimal_digits_as_python_does() {
        assert_eq!(
            link("(#١) widgets#1١ #１"),
            "([#١](https://github.com/acme/widgets/issues/١)) \
             [widgets#1١](https://github.com/acme/widgets/issues/1١) \
             [#１](https://github.com/acme/widgets/issues/１)"
        );
        // A superscript is a digit to `isdigit()`, not to `\d`.
        assert_eq!(link("#²"), "#²");
        let ids = ["10", "x", "2", "١", "²"];
        let mut sorted = ids;
        sorted.sort_by(|a, b| task_order(a).cmp(&task_order(b)));
        assert_eq!(sorted, ["١", "2", "10", "x", "²"]);
    }

    #[test]
    fn links_code_spans_and_words_are_left_alone() {
        for text in [
            "see [#9](https://x) and [top](#12)",
            "[Open Recent (#36)](https://github.com/acme/widgets/pull/36)",
            "[fix (widgets#19)](https://example.com) and `fixes (#40)`",
            "issue#3, C#, x-#4, /#5, [#6, #7x, #8] and ![a](b(#9)c)",
            "``a` #1 `b``",
            "[x][#6]",
        ] {
            assert_eq!(link(text), text);
        }
        // Another owner's bare repo, or no GitHub remote at all: plain text.
        assert_eq!(link("somerepo#8"), "somerepo#8");
        assert_eq!(
            link_refs("See #7 and o/r#8", ""),
            "See #7 and [o/r#8](https://github.com/o/r/issues/8)"
        );
    }

    #[test]
    fn code_spans_backtrack_like_the_regex() {
        // ``` ``a` ```: two ticks can't close, so one does, and the span runs to the last tick.
        assert_eq!(
            code_span_at(&"``a` #1".chars().collect::<Vec<_>>(), 0),
            Some(4)
        );
        assert_eq!(code_span_at(&"`a".chars().collect::<Vec<_>>(), 0), None);
    }

    #[test]
    fn github_remotes_are_read_like_the_regex() {
        assert_eq!(
            parse_github_url("git@github.com:acme/widgets.git"),
            "acme/widgets"
        );
        assert_eq!(
            parse_github_url("https://github.com/acme/widgets"),
            "acme/widgets"
        );
        assert_eq!(
            parse_github_url("https://github.com/acme/widgets.git/"),
            "acme/widgets"
        );
        assert_eq!(
            parse_github_url("https://github.com/acme/.git"),
            "acme/.git"
        );
        assert_eq!(parse_github_url("https://github.com/a/b/c"), "");
        assert_eq!(parse_github_url("https://gitlab.com/acme/widgets"), "");
    }

    // The board

    #[test]
    fn sections_are_replaced_in_place_or_added_at_the_end() {
        let board = replace_section(
            "",
            "a",
            "<!-- markychecky:start a -->\nA\n<!-- markychecky:end a -->\n",
        );
        assert!(board.starts_with(TITLE));
        let board = format!("{board}\nA note.\n");
        let board = replace_section(
            &board,
            "b",
            "<!-- markychecky:start b -->\nB\n<!-- markychecky:end b -->\n",
        );
        let board = replace_section(
            &board,
            "a",
            "<!-- markychecky:start a -->\nA2\n<!-- markychecky:end a -->\n",
        );
        assert_eq!(
            board,
            format!(
                "{TITLE}\n<!-- markychecky:start a -->\nA2\n<!-- markychecky:end a -->\n\nA note.\n\n\
                 <!-- markychecky:start b -->\nB\n<!-- markychecky:end b -->\n"
            )
        );
        let ids: Vec<_> = sections(&board).iter().map(|s| s.id).collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn a_section_needs_its_own_end_marker() {
        let board = "<!-- markychecky:start a -->\nA\n<!-- markychecky:end b -->\n";
        assert!(sections(board).is_empty());
        assert!(
            sections("<!-- markychecky:start a x>y -->\n<!-- markychecky:end a -->").is_empty()
        );
    }

    #[test]
    fn ended_sections_are_swept_after_idle_hours() {
        let now = parse_iso("2026-01-02T00:00:00+00:00").unwrap();
        let section = |id: &str, meta: &str| {
            format!("<!-- markychecky:start {id} {meta}-->\n{id}\n<!-- markychecky:end {id} -->\n")
        };
        let board = [
            section("old", "ended=2025-12-31T23:59:59+00:00 "),
            section("edge", "ended=2026-01-01T00:00:00+00:00 "),
            section("recent", "ended=2026-01-01T12:00:00Z "),
            section("naive", "ended=2000-01-01T00:00:00 "),
            section("bad", "ended=yesterday "),
            section("live", ""),
            section("me", "ended=2000-01-01T00:00:00+00:00 "),
        ]
        .concat();
        let swept = sweep(&board, 24.0, "me", now).unwrap();
        let ids: Vec<_> = sections(&swept).iter().map(|s| s.id.to_string()).collect();
        assert_eq!(
            ids,
            ["edge", "recent", "naive", "bad", "live", "me"],
            "a day ago exactly stays"
        );
        assert!(sweep(&board, f64::INFINITY, "me", now).is_err());
        assert!(sweep(&board, f64::NAN, "me", now).is_err());
    }

    #[test]
    fn times_are_written_and_read_as_python_does() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00+00:00");
        assert_eq!(
            iso_utc(1_795_020_331_729_001),
            "2026-11-18T16:45:31.729001+00:00"
        );
        for micros in [0, 1_795_020_331_729_001, -1, 951_782_400_000_000] {
            assert_eq!(parse_iso(&iso_utc(micros)), Some(micros));
        }
        assert_eq!(
            parse_iso("2000-01-01T01:00:00.5+01:00"),
            Some(946_684_800_500_000)
        );
        assert_eq!(
            parse_iso("2000-01-01 00:00-0130"),
            Some(946_684_800_000_000 + 5_400_000_000)
        );
        // Every form of an offset or a time `fromisoformat` reads, and not a mix of them.
        for text in [
            "2000-01-01T00:00:00+00",
            "2000-01-01T00:00:00+000000",
            "2000-01-01T00:00:00+00:00:00",
            "2000-01-01T0000+00:00",
            "2000-01-01T00,0+00:00",
            "2000-01-01T00+00",
        ] {
            assert_eq!(parse_iso(text), Some(946_684_800_000_000), "{text}");
        }
        assert_eq!(
            parse_iso("2000-01-01T00:00:00-05"),
            Some(946_684_800_000_000 + 18_000_000_000)
        );
        for text in [
            "2000-01-01T00:00:00+0",
            "2000-01-01T00:00:00+005",
            "2000-01-01T00:00:00+24",
            "2000-01-01T00:0000+00:00",
        ] {
            assert_eq!(parse_iso(text), None, "{text}");
        }
        assert_eq!(parse_iso("2000-02-30T00:00:00+00:00"), None);
        assert_eq!(parse_iso("2000-01-01T00:00:00"), None);
        assert_eq!(parse_iso("2000-01-01"), None);
    }

    #[test]
    fn settings_read_floats_as_python_does() {
        assert_eq!(parse_float(" 24 "), Some(24.0));
        assert_eq!(parse_float("1_000"), Some(1000.0));
        assert_eq!(parse_float("1e3"), Some(1000.0));
        assert_eq!(parse_float("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(parse_float("1 day"), None);
        assert_eq!(parse_float("_1"), None);
        assert_eq!(parse_float(""), None);
    }

    #[test]
    fn values_print_as_python_str_does() {
        assert_eq!(py_str(&json!(3)), "3");
        assert_eq!(py_str(&json!(1.0)), "1.0");
        assert_eq!(py_str(&json!(1e16)), "1e+16");
        assert_eq!(py_str(&json!(true)), "True");
        assert_eq!(session_id(Some(&json!("ab/c d.é-_!"))), "abcd.é-_");
        assert_eq!(session_id(Some(&json!(0))), "");
        assert_eq!(session_id(Some(&json!("x".repeat(80)))).len(), 64);
    }

    #[test]
    fn paths_are_handled_as_os_path_does() {
        assert_eq!(normpath("/a//b/./c/../d/"), "/a/b/d");
        assert_eq!(normpath("//a"), "//a");
        assert_eq!(normpath("///a/.."), "/");
        assert_eq!(normpath("../x/../.."), "../..");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), "");
        assert_eq!(basename("/a/b.git"), "b.git");
        assert!(abspath("x/../y").unwrap().ends_with("/y"));
    }

    #[test]
    fn the_lock_and_settings_sit_beside_the_board_as_the_python_scripts_do() {
        assert_eq!(
            beside("/tmp/mcq/board.md", ".lock"),
            "/tmp/mcq/.board.md.lock"
        );
        assert_eq!(
            beside("/home/me/markychecky.md", ".settings.json"),
            "/home/me/.markychecky.md.settings.json"
        );
        assert_eq!(beside("/board.md", ".lock"), "/.board.md.lock");
    }

    // Writing

    #[test]
    fn an_app_image_saves_its_path_for_the_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join(".cache/markychecky");
        let cache_s = cache.to_str().unwrap();
        save_app_image("/opt/Mark ydowny.AppImage", cache_s).unwrap();
        let saved = cache.join("markydowny-path");
        assert_eq!(
            fs::read_to_string(&saved).unwrap(),
            format!("/opt/Mark ydowny.AppImage\n{ENGINE_MARKER}\n")
        );
        save_app_image("/home/me/Markydowny.AppImage", cache_s).unwrap();
        assert_eq!(
            fs::read_to_string(&saved).unwrap(),
            format!("/home/me/Markydowny.AppImage\n{ENGINE_MARKER}\n")
        );
    }

    #[test]
    fn writes_are_atomic_keep_the_mode_and_leave_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("board.md");
        let board_s = board.to_str().unwrap();

        assert!(write_board(board_s, |b| Ok(format!("{b}new\n")), None).unwrap());
        assert_eq!(
            fs::metadata(&board).unwrap().permissions().mode() & 0o777,
            0o644
        );

        fs::write(&board, "one\r\ntwo\r").unwrap();
        fs::set_permissions(&board, fs::Permissions::from_mode(0o600)).unwrap();
        let mut seen = String::new();
        assert!(!write_board(
            board_s,
            |b| {
                seen = b.to_string();
                Ok(format!("{b}three\n"))
            },
            None
        )
        .unwrap());
        assert_eq!(seen, "one\ntwo\n", "read with universal newlines");
        assert_eq!(fs::read_to_string(&board).unwrap(), "one\ntwo\nthree\n");
        assert_eq!(
            fs::metadata(&board).unwrap().permissions().mode() & 0o777,
            0o600
        );

        // No change, no write; a failed update leaves the board alone.
        write_board(board_s, |b| Ok(b.to_string()), None).unwrap();
        assert!(write_board(board_s, |_| Err("no".into()), None).is_err());
        assert_eq!(fs::read_to_string(&board).unwrap(), "one\ntwo\nthree\n");
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "the board and its lock: {names:?}");
    }

    #[test]
    fn writers_at_once_queue_on_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("board.md").to_str().unwrap().to_string();
        let writers: Vec<_> = (0..16)
            .map(|i| {
                let board = board.clone();
                std::thread::spawn(move || {
                    write_board(
                        &board,
                        |b| {
                            std::thread::sleep(Duration::from_millis(2));
                            Ok(format!("{b}{i}\n"))
                        },
                        None,
                    )
                    .unwrap();
                })
            })
            .collect();
        writers.into_iter().for_each(|w| w.join().unwrap());
        assert_eq!(fs::read_to_string(&board).unwrap().lines().count(), 16);
    }

    #[test]
    fn a_worktree_is_named_after_its_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("widgets");
        let tree = dir.path().join("wt-fix-login");
        let git_ok = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .output()
                .is_ok_and(|o| o.status.success())
        };
        let r = repo.to_str().unwrap();
        assert!(git_ok(&["init", "-q", "-b", "main", r]));
        assert!(git_ok(&[
            "-C",
            r,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init"
        ]));
        assert!(git_ok(&[
            "-C",
            r,
            "worktree",
            "add",
            "-q",
            "-b",
            "fix/login",
            tree.to_str().unwrap()
        ]));
        assert!(git_ok(&[
            "-C",
            r,
            "remote",
            "add",
            "origin",
            "git@github.com:acme/widgets.git"
        ]));
        assert_eq!(place(tree.to_str().unwrap()), "widgets · fix/login");
        assert_eq!(place(r), "widgets · main");
        assert_eq!(github_repo(r), "acme/widgets");
        let plain = dir.path().join("notes");
        fs::create_dir(&plain).unwrap();
        assert_eq!(place(&format!("{}/", plain.to_str().unwrap())), "notes");
        assert_eq!(place("/"), "/");
    }

    #[test]
    fn home_is_expanded_as_expanduser_does() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            expand_user("~/x.md"),
            format!("{}/x.md", home.trim_end_matches('/'))
        );
        assert_eq!(expand_user("/a/~"), "/a/~");
        assert_eq!(expand_user("~no-such-user-here/x"), "~no-such-user-here/x");
    }

    // Waiting on you

    #[test]
    fn the_waiting_heading_is_matched_as_the_regex_does() {
        for heading in [
            "## Waiting on you",
            "### WAITING ON YOU ##",
            "#\twaiting on you \t",
            "## WAİTİNG on you",
            "## waıting on you",
        ] {
            assert!(waiting_heading_at(heading, 0).is_some(), "{heading:?}");
        }
        for heading in [
            "####### Waiting on you",
            "##Waiting on you",
            "## Waiting  on you",
            "## Waiting on you!",
            "## Waiting on youK",
            " ## Waiting on you",
        ] {
            assert!(waiting_heading_at(heading, 0).is_none(), "{heading:?}");
        }
    }

    #[test]
    fn the_section_runs_to_a_heading_as_high_or_the_next_session() {
        let board = "# T\n\n## Waiting on you\n\n- a\n### deeper\n- b\n## Next\n";
        let (start, end) = find_waiting(board).unwrap();
        assert_eq!(&board[start..end], "\n- a\n### deeper\n- b\n");
        // A heading inside a session's section isn't the section.
        let board =
            "<!-- markychecky:start s1 -->\n## Waiting on you\n<!-- markychecky:end s1 -->\n";
        assert_eq!(find_waiting(board), None);
        assert_eq!(
            ensure_waiting(board),
            format!("## Waiting on you\n\n{board}")
        );
        assert_eq!(
            ensure_waiting(""),
            format!("{}\n\n## Waiting on you\n", TITLE.trim_end())
        );
    }

    #[test]
    fn editing_the_section_tidies_blank_lines_and_keeps_other_lines() {
        let add = |line: &str| {
            let line = line.to_string();
            move |mut lines: Vec<String>| {
                lines.push(line);
                lines
            }
        };
        assert_eq!(
            edit_waiting("# T\n\n## Waiting on you", add("- x")),
            "# T\n\n## Waiting on you\n\n- x\n"
        );
        let board = "## Waiting on you\n- by hand  \n\n\n<!-- markychecky:start s1 -->\n<!-- markychecky:end s1 -->\n";
        assert_eq!(
            edit_waiting(board, add("- y")),
            "## Waiting on you\n\n- by hand  \n- y\n\n<!-- markychecky:start s1 -->\n<!-- markychecky:end s1 -->\n"
        );
        assert_eq!(
            edit_waiting("## Waiting on you\n\n- x\n## Next\n", |_| Vec::new()),
            "## Waiting on you\n\n## Next\n"
        );
    }

    #[test]
    fn markers_are_read_as_the_regexes_do() {
        let line = "- a <!-- markychecky:notify bad --> <!-- markychecky:notify s1 at=2000-01-01T00:00:00+00:00 --> x";
        let found = notify_markers(line);
        assert_eq!(found.len(), 1);
        assert_eq!(
            (found[0].1, found[0].2, found[0].3),
            ("s1", "", "2000-01-01T00:00:00+00:00")
        );
        assert!(notify_markers("<!-- markychecky:notify s1 at= -->").is_empty());
        let found = notify_markers("<!-- markychecky:notify s1 agent=sub-1 at=t -->");
        assert_eq!((found[0].1, found[0].2, found[0].3), ("s1", "sub-1", "t"));
        // An `agent=` that isn't followed by ` at=` is read as no marker, as the regex reads it.
        assert!(notify_markers("<!-- markychecky:notify s1 agent= at=t -->").is_empty());
        let board = "a\nx <!-- markychecky:notify s1 at=t --> y\n\
            b <!-- markychecky:notify s10 at=t -->\n\
            c <!-- markychecky:notify s1 agent=sub at=t -->\n";
        assert_eq!(
            without_notify(board, "s1", None),
            "a\nb <!-- markychecky:notify s10 at=t -->\n"
        );
        assert_eq!(
            without_notify(board, "s1", Some(&["sub".into()])),
            "a\nx <!-- markychecky:notify s1 at=t --> y\nb <!-- markychecky:notify s10 at=t -->\n"
        );
        assert_eq!(
            without_notify(board, "s1", Some(&["".into()])),
            "a\nb <!-- markychecky:notify s10 at=t -->\nc <!-- markychecky:notify s1 agent=sub at=t -->\n"
        );
        let line = "- q \t<!-- markychecky:item s1/k --> tail";
        assert_eq!(item_marker(line), Some((3, 35, "s1/k")));
        assert_eq!(item_marker("- q <!-- markychecky:item s1/k-->"), None);
    }

    #[test]
    fn a_name_is_read_from_the_transcript_where_the_last_read_stopped() {
        let dir = std::env::temp_dir().join(format!("markychecky-name-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s1.jsonl");
        let path_text = path.to_string_lossy().into_owned();
        fs::write(&path, "{\"type\":\"user\",\"x\":\"\\\"ai-title\\\"\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"Fir").unwrap();
        let mut state = Map::new();
        read_name(&mut state, &path_text);
        assert_eq!(session_name(&state), "");
        let first = state["name"]["offset"].as_u64().unwrap();
        // The half-written line is read once it's whole.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"st  one\"}\n").unwrap();
        read_name(&mut state, "");
        assert_eq!(session_name(&state), "First one");
        assert!(state["name"]["offset"].as_u64().unwrap() > first);
        // /rename's name wins over a later made-up one.
        file.write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Mine\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"Later\"}\n").unwrap();
        read_name(&mut state, &path_text);
        assert_eq!(session_name(&state), "Mine");
        // A shorter file in its place is read from the start.
        fs::write(&path, "{\"type\":\"ai-title\",\"aiTitle\":\"New\"}\n").unwrap();
        read_name(&mut state, &path_text);
        assert_eq!(session_name(&state), "New");
        // A transcript that's gone leaves the name as it was.
        fs::remove_dir_all(&dir).unwrap();
        read_name(&mut state, &path_text);
        assert_eq!(session_name(&state), "New");
        assert_eq!(label("widgets · main", "New"), "widgets · main (New)");
        assert_eq!(label("widgets\n· main", ""), "widgets · main");
    }

    #[test]
    fn only_notifications_that_wait_on_you_make_a_line() {
        let text = |event: Value| notification_text(&obj(event)).unwrap();
        assert_eq!(
            text(
                json!({"notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash."})
            ),
            Some(("needs permission to use Bash".into(), "tool"))
        );
        assert_eq!(
            text(json!({"notification_type": "worker_permission_prompt"})),
            Some(("needs your permission".into(), "tool"))
        );
        assert_eq!(
            text(json!({"notification_type": "elicitation_url_dialog", "message": "Sign in"})),
            Some(("has a question for you".into(), "tool"))
        );
        assert_eq!(
            text(json!({"notification_type": "elicitation_dialog"})),
            Some(("has a question for you".into(), "tool"))
        );
        // A session that's only idle, waiting for its next prompt, isn't something to do.
        for kind in [
            "idle_prompt",
            "agent_needs_input",
            "quota_auto_resume_stale",
            "agent_completed",
            "auth_success",
            "some_new_type",
        ] {
            assert_eq!(
                text(json!({"notification_type": kind, "message": "permission to use Bash"})),
                None
            );
        }
        // Without a type, from the message.
        assert_eq!(
            text(json!({"message": "Claude needs your permission to use Edit"})),
            Some(("needs permission to use Edit".into(), "tool"))
        );
        assert_eq!(
            text(json!({"message": "Claude is waiting for your input"})),
            None
        );
    }

    #[test]
    fn a_line_is_answered_by_a_prompt_or_its_own_agents_batch() {
        let item = |waits: &str| json!({"waits": waits, "at": "2000-01-01T00:00:00+00:00"});
        let event = |name: &str, agent: Option<&str>| {
            let mut event = obj(json!({"hook_event_name": name}));
            if let Some(agent) = agent {
                event.insert("agent_id".into(), json!(agent));
            }
            event
        };
        let later = parse_iso("2001-01-01T00:00:00+00:00").unwrap();
        let answers = |event: &Map<String, Value>, agent: &str, item: &Value| {
            answers(event, agent, item, later)
        };
        assert!(answers(&event("UserPromptSubmit", None), "", &item("tool")));
        assert!(answers(
            &event("UserPromptSubmit", None),
            "sub",
            &item("prompt")
        ));
        assert!(!answers(
            &event("UserPromptSubmit", None),
            "sub",
            &item("tool")
        ));
        assert!(answers(&event("PostToolBatch", None), "", &item("tool")));
        assert!(!answers(
            &event("PostToolBatch", Some("sub")),
            "",
            &item("tool")
        ));
        assert!(answers(
            &event("PostToolBatch", Some("sub")),
            "sub",
            &item("tool")
        ));
        assert!(!answers(&event("PostToolBatch", None), "", &item("prompt")));
        assert!(!answers(&event("PostToolUse", None), "", &item("tool")));
        assert!(answers(&obj(json!({})), "", &json!({})));
        // A notification raised after the respond event started is a new one.
        let early = parse_iso("1999-01-01T00:00:00+00:00").unwrap();
        assert!(!super::answers(
            &event("UserPromptSubmit", None),
            "",
            &item("prompt"),
            early
        ));
        // Each agent's item is answered on its own.
        let flag = obj(json!({"": item("tool"), "sub": item("tool"), "idle": item("prompt")}));
        assert_eq!(
            answered(&event("PostToolBatch", Some("sub")), Some(&flag), later),
            vec!["sub".to_string()]
        );
        assert_eq!(
            answered(&event("UserPromptSubmit", None), Some(&flag), later),
            vec!["".to_string(), "idle".to_string()]
        );
    }

    #[test]
    fn the_lock_0_3_took_is_named_as_it_named_it() {
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(&sha1_hex(b"/tmp/mcq/board.md")[..16], "db16c49a5ed44a30");
    }
}
