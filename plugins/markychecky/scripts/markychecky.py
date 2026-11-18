#!/usr/bin/env python3
"""markychecky: keeps one markdown board of what every Claude Code session is doing.

Claude Code runs this from hooks (see ../hooks/hooks.json) with the hook's JSON on stdin:

  markychecky.py task   PostToolUse for TaskCreate, TaskUpdate and TodoWrite: update this
                        session's task list and rewrite its section of the board
  markychecky.py end    SessionEnd: mark this session's section idle

Each session owns one section, between `<!-- markychecky:start <id> -->` and
`<!-- markychecky:end <id> -->`. A write takes a lock, re-reads the board, replaces only its own
section and swaps the file in atomically, so sessions writing at once don't lose each other's
updates, and anything a person writes outside the sections is kept as it is.

Settings come from the plugin's options (CLAUDE_PLUGIN_OPTION_*), or MARKYCHECKY_* for testing:
  FILE        the board's path (default ~/markychecky.md)
  OPEN        "true" to open the board in Markydowny, in the background, when a session first
              writes to it (macOS, when Markydowny is installed; default true)
  IDLE_HOURS  how long an ended session's section stays on the board (default 24)

It never fails the session: errors go to markychecky.log in the plugin's data folder, and the
hook exits 0.
"""

import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

TITLE = "# Markychecky\n\nWhat each Claude Code session is working on. Sessions update their own sections.\n"
START = "<!-- markychecky:start {id} {meta}-->"
END = "<!-- markychecky:end {id} -->"
SECTION_RE = re.compile(
    r"<!-- markychecky:start (?P<id>[\w.-]+) (?P<meta>[^>]*?)-->\n.*?<!-- markychecky:end (?P=id) -->\n?",
    re.S,
)
STATUS_BOX = {"completed": "x", "in_progress": " ", "pending": " "}


def setting(name, default):
    for key in (f"MARKYCHECKY_{name}", f"CLAUDE_PLUGIN_OPTION_{name}"):
        value = os.environ.get(key)
        if value not in (None, ""):
            return value
    return default


def data_dir():
    base = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
        os.path.expanduser("~"), ".cache", "markychecky"
    )
    os.makedirs(os.path.join(base, "sessions"), exist_ok=True)
    return base


def now():
    return dt.datetime.now(dt.timezone.utc)


# ----------------------------------------------------------------------------------------------
# A session's task list, rebuilt from hook events
# ----------------------------------------------------------------------------------------------


def load_state(path) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {"tasks": {}}
    except (OSError, ValueError):
        return {"tasks": {}}


def save_state(path, state):
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def apply_event(state, event):
    """Folds one PostToolUse event into the session's task list. Returns whether it changed."""
    tool = event.get("tool_name")
    given = event.get("tool_input") or {}
    result = event.get("tool_response") or {}
    tasks = state.setdefault("tasks", {})
    if tool == "TaskCreate":
        task = result.get("task") if isinstance(result, dict) else None
        task_id = str((task or {}).get("id") or len(tasks) + 1)
        tasks[task_id] = {
            "subject": given.get("subject") or (task or {}).get("subject") or "",
            "active": given.get("activeForm") or "",
            "status": "pending",
        }
        return True
    if tool == "TaskUpdate":
        task_id = str(given.get("taskId") or (result or {}).get("taskId") or "")
        if not task_id:
            return False
        if given.get("status") == "deleted":
            return tasks.pop(task_id, None) is not None
        task = tasks.setdefault(task_id, {"subject": "", "active": "", "status": "pending"})
        if given.get("subject"):
            task["subject"] = given["subject"]
        if given.get("activeForm"):
            task["active"] = given["activeForm"]
        if given.get("status") in STATUS_BOX:
            task["status"] = given["status"]
        return True
    if tool == "TodoWrite":
        todos = given.get("todos") or []
        state["tasks"] = {
            str(i + 1): {
                "subject": t.get("content") or "",
                "active": t.get("activeForm") or "",
                "status": t.get("status") if t.get("status") in STATUS_BOX else "pending",
            }
            for i, t in enumerate(todos)
        }
        return True
    return False


# ----------------------------------------------------------------------------------------------
# Rendering
# ----------------------------------------------------------------------------------------------


def one_line(text):
    """Text on one line, with `<!--` shown as typed rather than opening a comment, so text can't
    hide itself or end a section early with a copy of its marker."""
    return " ".join(str(text).split()).replace("<!--", "&lt;!--")


def git(cwd, *args):
    try:
        out = subprocess.run(
            ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=3
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def github_repo(cwd):
    """`owner/repo` of the session's GitHub `origin` remote, or "" when there isn't one."""
    url = git(cwd or os.getcwd(), "remote", "get-url", "origin")
    match = re.search(r"github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", url)
    return f"{match.group(1)}/{match.group(2)}" if match else ""


# `owner/repo#12`, `#12` (the session's repo) or `repo#12` when it names the session's own repo.
# Anything else, such as another owner's `repo#12`, stays text rather than becoming a wrong link.
# Not inside an existing link's text (`[#9]`, `[Open Recent (#36)](url)`) or target (`](#12)`),
# not in a code span, and not part of a word. A plain parenthesis is fine: "Open Recent (#36)" links.
REF_RE = re.compile(
    r"(?P<skip>(?P<ticks>`+).*?(?<!`)(?P=ticks)(?!`)"
    r"|!?\[(?:[^\[\]]|\[[^\[\]]*\])*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\]))"
    r"|(?<![\w/\[#-])(?<!\]\()(?:(?P<owner>[\w.-]+)/)?(?P<repo>[\w.-]+)?#(?P<num>\d+)\b(?![\]\w])"
)


def link_refs(text, repo):
    """Turns issue and pull request references into links, so the board is clickable. GitHub
    redirects /issues/N to the pull request when N is one."""
    default_owner, _, default_name = repo.partition("/")

    def link(match):
        if match.group("skip"):
            return match.group(0)
        owner, name, num = match.group("owner"), match.group("repo"), match.group("num")
        if owner and name:
            target = f"{owner}/{name}"
        elif name:
            if not repo or name.lower() != default_name.lower():
                return match.group(0)
            target = repo
        elif repo:
            target = repo
        else:
            return match.group(0)
        return f"[{match.group(0)}](https://github.com/{target}/issues/{num})"

    return REF_RE.sub(link, text)


def place(cwd):
    """`repo · branch` for a session's working directory, or the folder's name outside git."""
    cwd = cwd or os.getcwd()
    top = git(cwd, "rev-parse", "--show-toplevel")
    if not top:
        return os.path.basename(os.path.normpath(cwd)) or cwd
    branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    # In a linked worktree, the top level is the worktree's own folder; name the repository
    # after the main checkout, which holds the shared .git directory.
    common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common and os.path.basename(os.path.normpath(common)) == ".git":
        name = os.path.basename(os.path.dirname(os.path.normpath(common)))
    else:
        name = os.path.basename(top)
    return f"{name} · {branch}" if branch and branch != "HEAD" else name


def render_section(session_id, state, ended_at=None):
    tasks = state.get("tasks", {})
    ordered = sorted(tasks.items(), key=lambda kv: (int(kv[0]) if kv[0].isdigit() else 1 << 30, kv[0]))
    doing = [t for _, t in ordered if t["status"] == "in_progress"]
    if ended_at:
        now_line = f"idle, the session ended at {ended_at.astimezone().strftime('%H:%M')}"
    elif doing:
        now_line = "; ".join(one_line(t["active"] or t["subject"]) for t in doing)
        now_line = link_refs(now_line, state.get("repo", ""))
    elif ordered and all(t["status"] == "completed" for _, t in ordered):
        now_line = "all done"
    else:
        now_line = "planning"
    meta = f"ended={ended_at.isoformat()} " if ended_at else ""
    lines = [
        START.format(id=session_id, meta=meta),
        f"## {one_line(state.get('place') or 'Claude Code')}",
        "",
        f"**Now:** {now_line}",
        "",
    ]
    for _, t in ordered:
        mark = STATUS_BOX[t["status"]]
        text = link_refs(one_line(t["subject"]), state.get("repo", "")) or "(untitled)"
        if t["status"] == "in_progress":
            text = f"**{text}**"
        lines.append(f"- [{mark}] {text}")
    if not ordered:
        lines.append("_No tasks yet._")
    lines += ["", END.format(id=session_id), ""]
    return "\n".join(lines)


def sweep(board, idle_hours, keep):
    """Removes sections whose session ended more than idle_hours ago."""
    cutoff = now() - dt.timedelta(hours=idle_hours)

    def drop(match):
        if match.group("id") == keep:
            return match.group(0)
        ended = re.search(r"ended=(\S+)", match.group("meta"))
        if ended:
            try:
                if dt.datetime.fromisoformat(ended.group(1)) < cutoff:
                    return ""
            except (ValueError, TypeError):  # unreadable, or no UTC offset: leave it
                pass
        return match.group(0)

    return SECTION_RE.sub(drop, board)


def replace_section(board, session_id, section):
    """The board with this session's section replaced, or added at the end."""
    if not board.strip():
        board = TITLE
    for match in SECTION_RE.finditer(board):
        if match.group("id") == session_id:
            return board[: match.start()] + section + board[match.end():]
    return board.rstrip("\n") + "\n\n" + section


# ----------------------------------------------------------------------------------------------
# Writing the board
# ----------------------------------------------------------------------------------------------


def write_board(path, update):
    """Applies update(board_text) -> new text under a lock, and swaps the file in atomically.
    Returns whether the board was created by this call."""
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lock_path = os.path.join(
        data_dir(), f"board-{hashlib.sha1(path.encode()).hexdigest()[:16]}.lock"
    )
    with open(lock_path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(path, encoding="utf-8") as f:
                before = f.read()
            created = False
        except FileNotFoundError:
            before, created = "", True
        after = update(before)
        if after == before:
            return False
        fd, tmp = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=os.path.dirname(path))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(after)
            if not created:
                shutil.copymode(path, tmp)
            else:
                os.chmod(tmp, 0o644)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        return created


def log(message):
    try:
        with open(os.path.join(data_dir(), "markychecky.log"), "a", encoding="utf-8") as f:
            f.write(f"{now().isoformat()} {sys.argv[1:]} {message}\n")
    except OSError:
        pass


def open_in_markydowny(path):
    if sys.platform != "darwin" or setting("OPEN", "true").lower() not in ("1", "true", "yes"):
        return
    if subprocess.run(["open", "-Ra", "Markydowny"], capture_output=True).returncode != 0:
        return  # not installed
    # -g leaves the terminal in front; Markydowny doesn't take focus for a file it already shows.
    subprocess.run(["open", "-g", "-a", "Markydowny", os.path.expanduser(path)], capture_output=True)


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    event = json.load(sys.stdin)
    session_id = re.sub(r"[^\w.-]", "", str(event.get("session_id") or ""))[:64]
    if not session_id:
        return
    board_path = setting("FILE", "~/markychecky.md")
    try:
        idle_hours = float(setting("IDLE_HOURS", "24"))
    except ValueError:
        log(f"idle_hours is not a number of hours: {setting('IDLE_HOURS', '')!r}; using 24")
        idle_hours = 24.0
    state_path = os.path.join(data_dir(), "sessions", f"{session_id}.json")
    if command not in ("task", "end"):
        return
    # git runs before the lock is taken, so sessions don't queue behind each other's git.
    where = (place(event.get("cwd")), github_repo(event.get("cwd"))) if command == "task" else None
    first = []

    def update(board):
        # Under the board's lock: hooks for one session run at once when several task tools fire
        # in a turn, and each must fold its event into the state the last one saved.
        state = load_state(state_path)
        if command == "task":
            if not apply_event(state, event):
                return board
            state["place"], state["repo"] = where
            state.pop("ended", None)
            ended = None
        else:
            if not state.get("wrote"):
                return board  # never wrote a section
            ended = now()
            state["ended"] = ended.isoformat()
        if not state.get("wrote"):
            state["wrote"] = True
            first.append(True)
        save_state(state_path, state)
        section = render_section(session_id, state, ended_at=ended)
        return sweep(replace_section(board, session_id, section), idle_hours, session_id)

    write_board(board_path, update)
    if first:
        open_in_markydowny(board_path)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as error:  # never fail the session over the board
        log(repr(error))
    sys.exit(0)
