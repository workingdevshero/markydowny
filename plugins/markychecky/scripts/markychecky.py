#!/usr/bin/env python3
"""markychecky: keeps one markdown board of what every Claude Code session is doing.

Claude Code runs this from hooks (see ../hooks/hooks.json), through the launcher markychecky.sh,
when the Markydowny app can't run them itself. Each gets the hook's JSON on stdin:

  markychecky.py task     PostToolUse for TaskCreate, TaskUpdate and TodoWrite: update this
                          session's task list and rewrite its section of the board
  markychecky.py end      SessionEnd: mark this session's section idle, and clear its
                          notification item
  markychecky.py notify   Notification: add or refresh this session's "waiting for your input"
                          or "needs permission" item in "Waiting on you"
  markychecky.py respond  UserPromptSubmit and PostToolBatch: clear that item, once the user
                          has answered it

Sessions run these themselves, through markychecky.sh, from the context session-start.sh gives
them:

  markychecky.py waiting add --key <key> "<text>"   add or update this session's item
  markychecky.py waiting remove --key <key>         remove it (or --key <session>/<key>)
  markychecky.py waiting list                       print the section

Each session owns one section, between `<!-- markychecky:start <id> -->` and
`<!-- markychecky:end <id> -->`. A write takes a lock, re-reads the board, replaces only its own
section and swaps the file in atomically, so sessions writing at once don't lose each other's
updates, and anything a person writes outside the sections is kept as it is.

"Waiting on you" is the board's one shared section, a heading at the top. markychecky adds the
heading when the board has none, and only ever edits lines that end in its own hidden marker:
`<!-- markychecky:item <session>/<key> -->` from `waiting add`, which stays until it's removed,
and `<!-- markychecky:notify <session> at=<time> -->` from a notification (with `agent=<id>`
before `at=` for a subagent's), which goes when the session responds or ends. Lines a person writes there are never changed.

Settings come from the plugin's options (CLAUDE_PLUGIN_OPTION_*), or MARKYCHECKY_* for testing:
  FILE        the board's path (default ~/markychecky.md)
  OPEN        "true" to open the board in Markydowny, in the background, when a session first
              writes to it (macOS, when Markydowny is installed; default true)
  IDLE_HOURS  how long an ended session's section stays on the board (default 24)
  WAITING     "false" to leave out "Waiting on you": no section, no context, no items

The `waiting` commands run in the session's shell, which doesn't get the plugin's options, so
session-start.sh writes the ones they need to a file beside the board, `.<board>.settings.json`.

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

WAITING_HEADING = "## Waiting on you"
# The heading may be any level, and has no other text.
WAITING_RE = re.compile(r"^(?P<level>#{1,6})[ \t]+waiting on you[ \t]*#*[ \t]*$", re.I | re.M)
ITEM = "<!-- markychecky:item {id} -->"
NOTIFY = "<!-- markychecky:notify {session}{agent} at={at} -->"
NOTIFY_RE = re.compile(
    r"<!-- markychecky:notify (?P<session>[\w.-]+)(?: agent=(?P<agent>[\w.-]+))? at=(?P<at>\S+) -->"
)
KEY_RE = re.compile(r"[\w.-]{1,64}")


def setting(name, default):
    for key in (f"MARKYCHECKY_{name}", f"CLAUDE_PLUGIN_OPTION_{name}"):
        value = os.environ.get(key)
        if value not in (None, ""):
            return value
    return default


def on(name, default="true"):
    return setting(name, default).lower() in ("1", "true", "yes")


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

    def stale(match):
        # A notification item whose session never ended (it crashed, say) goes after idle_hours
        # too. Items from `waiting add` have no time on them, and stay until they're removed.
        try:
            if dt.datetime.fromisoformat(NOTIFY_RE.search(match.group(0)).group("at")) < cutoff:
                return ""
        except (ValueError, TypeError):
            pass
        return match.group(0)

    board = SECTION_RE.sub(drop, board)
    return re.sub(r"^.*" + NOTIFY_RE.pattern + r".*\n?", stale, board, flags=re.M)


def replace_section(board, session_id, section):
    """The board with this session's section replaced, or added at the end."""
    if not board.strip():
        board = TITLE
    for match in SECTION_RE.finditer(board):
        if match.group("id") == session_id:
            return board[: match.start()] + section + board[match.end():]
    return board.rstrip("\n") + "\n\n" + section


# ----------------------------------------------------------------------------------------------
# Waiting on you
# ----------------------------------------------------------------------------------------------


def find_waiting(board):
    """(start of the body, end of the body) of the "Waiting on you" section outside any session's
    section, or None. The body runs to the next heading of the same level or higher, or the next
    session's section."""
    sessions = [m.span() for m in SECTION_RE.finditer(board)]
    for match in WAITING_RE.finditer(board):
        if any(a <= match.start() < b for a, b in sessions):
            continue
        body = board.find("\n", match.end())
        body = len(board) if body < 0 else body + 1
        level = len(match.group("level"))
        boundary = re.compile(r"^(?:#{1,%d}[ \t]|<!-- markychecky:start )" % level, re.M)
        end = boundary.search(board, body)
        return body, end.start() if end else len(board)
    return None


def ensure_waiting(board):
    """The board with a "Waiting on you" section: a new one goes above the sessions' sections."""
    if not board.strip():
        board = TITLE
    if find_waiting(board):
        return board
    first = SECTION_RE.search(board)
    if first:
        return board[: first.start()] + WAITING_HEADING + "\n\n" + board[first.start():]
    return board.rstrip("\n") + "\n\n" + WAITING_HEADING + "\n"


def edit_waiting(board, edit):
    """The board with the lines of "Waiting on you" replaced by edit(lines). Blank lines around
    them are tidied; the lines themselves are kept exactly as edit returns them."""
    board = ensure_waiting(board)
    start, end = find_waiting(board)
    lines = edit(board[start:end].strip("\n").split("\n") if board[start:end].strip() else [])
    body = "".join(line + "\n" for line in lines)
    if body and end < len(board):
        body += "\n"  # a blank line before what follows
    if body or end < len(board):
        body = "\n" + body  # and one after the heading
    if not board[:start].endswith("\n"):
        body = "\n" + body  # the heading was the file's last line, with no newline
    return board[:start] + body + board[end:]


def without_notify(board, session_id, agents=None):
    """The board without this session's notification items, or only those of the given agents
    ("" for the session's main agent)."""

    def drop(match):
        marker = NOTIFY_RE.search(match.group(0))
        if marker.group("session") != session_id:
            return match.group(0)
        if agents is not None and (marker.group("agent") or "") not in agents:
            return match.group(0)
        return ""

    return re.sub(r"^.*" + NOTIFY_RE.pattern + r".*\n?", drop, board, flags=re.M)


def waiting_lines(board):
    found = find_waiting(board)
    if not found or not board[found[0]:found[1]].strip():
        return []
    return [line for line in board[found[0]:found[1]].strip("\n").split("\n") if line.strip()]


# ----------------------------------------------------------------------------------------------
# Writing the board
# ----------------------------------------------------------------------------------------------


def write_board(path, update, data=None):
    """Applies update(board_text) -> new text under a lock, and swaps the file in atomically.
    Returns whether the board was created by this call. With the plugin's data folder, it takes
    the lock 0.3 took there as well."""
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # The lock sits next to the board, not in the plugin's data folder, so the `waiting`
    # commands a session runs itself, which don't get the plugin's environment, take the same one.
    lock_path = os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.lock")
    # Sessions started before 0.4 lock a file in the plugin's data folder instead, so this takes
    # that one too, after its own. Drop it once no 0.3 session can still be running.
    legacy = os.path.join(data, f"board-{hashlib.sha1(path.encode()).hexdigest()[:16]}.lock") if data and os.path.isdir(data) else None
    with open(lock_path, "w") as lock, open(legacy or os.devnull, "w") as old_lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if legacy:
            fcntl.flock(old_lock, fcntl.LOCK_EX)
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


def open_in_markydowny(path, enabled=None):
    if sys.platform != "darwin" or not (on("OPEN") if enabled is None else enabled):
        return
    if subprocess.run(["open", "-Ra", "Markydowny"], capture_output=True).returncode != 0:
        return  # not installed
    # -g leaves the terminal in front; Markydowny doesn't take focus for a file it already shows.
    subprocess.run(["open", "-g", "-a", "Markydowny", os.path.expanduser(path)], capture_output=True)


def settings_path(board_path):
    """The file beside the board where SessionStart leaves the options the `waiting` commands
    need. It sits there, like the lock, because those commands don't get the plugin's environment
    and so can't find its data folder."""
    path = os.path.abspath(os.path.expanduser(board_path))
    return os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.settings.json")


def board_settings(board_path):
    """The options as the `waiting` commands see them: from the environment when it has them,
    as the hooks do, or else from what SessionStart last saved beside the board."""
    try:
        with open(settings_path(board_path), encoding="utf-8") as f:
            saved = json.load(f)
        saved = saved if isinstance(saved, dict) else {}
    except (OSError, ValueError):
        saved = {}

    def option(name):
        if setting(name, "") != "":
            return on(name)
        return saved.get(name.lower()) is not False

    return {"waiting": option("WAITING"), "open": option("OPEN"),
            "data": saved.get("data") if isinstance(saved.get("data"), str) else None}


def first_open(state):
    """Whether this is the session's first write to the board, when the board opens in
    Markydowny. Marks it, so the caller saves the state."""
    if state.get("opened") or state.get("wrote"):
        return False
    state["opened"] = True
    return True


def idle_hours_setting():
    try:
        return float(setting("IDLE_HOURS", "24"))
    except ValueError:
        log(f"idle_hours is not a number of hours: {setting('IDLE_HOURS', '')!r}; using 24")
        return 24.0


# The notifications that mean a session is stopped until the user answers, and what clears
# each: "tool" ones are a dialog in the middle of a tool call, answered when the call's batch
# resolves, whether the user approved or denied it; "prompt" ones are answered by a prompt.
# Every other type (a background agent finishing, a sign-in, a quota resume) isn't waiting on you.
WAITS = {
    "permission_prompt": "tool",
    "worker_permission_prompt": "tool",
    "elicitation_dialog": "tool",
    "elicitation_url_dialog": "tool",
    "idle_prompt": "prompt",
    "agent_needs_input": "prompt",
    "quota_auto_resume_stale": "prompt",
}
PERMISSION_RE = re.compile(r"permission to use ([\w-]+)")


def notification_text(event):
    """(what a Notification event is waiting on, what answers it), or ("", "") for one that
    isn't waiting on the user."""
    kind = event.get("notification_type") or ""
    message = one_line(event.get("message") or "")
    tool = PERMISSION_RE.search(message)
    if not kind:  # from a Claude Code without notification types, which sent only these two
        kind = "permission_prompt" if tool else "idle_prompt"
    if kind not in WAITS:
        return "", ""
    if kind in ("permission_prompt", "worker_permission_prompt"):
        text = f"needs permission to use {tool.group(1)}" if tool else "needs your permission"
    elif kind.startswith("elicitation_"):
        text = "has a question for you"
    else:
        text = "waiting for your input"
    return text, WAITS[kind]


def agent_of(event):
    """The subagent an event comes from, or "" for the session's main agent."""
    return re.sub(r"[^\w.-]", "", str(event.get("agent_id") or ""))[:64]


def read_flag(flag_path):
    """The session's notification items, as notify saved them: what each agent's waits on and
    when it was raised. None without any."""
    try:
        with open(flag_path, encoding="utf-8") as f:
            flag = json.loads(f.read() or "{}")
    except ValueError:
        return {}
    except OSError:
        return None
    if not isinstance(flag, dict):
        return {}
    return {agent: item for agent, item in flag.items() if isinstance(item, dict)}


def save_flag(flag_path, flag):
    if flag:
        with open(flag_path, "w", encoding="utf-8") as f:
            json.dump(flag, f)
    elif os.path.exists(flag_path):
        os.unlink(flag_path)


def answers(event, agent, item, started):
    """Whether this respond event, which started at `started`, answers the agent's notification."""
    try:
        if dt.datetime.fromisoformat(item.get("at")) > started:
            return False  # raised after the user answered, so it's a new one
    except (ValueError, TypeError):
        pass
    name = event.get("hook_event_name") or ""
    if not name:
        return True
    # A prompt answers whatever waits on one, and anything the agent it comes from waits on.
    if name == "UserPromptSubmit":
        return item.get("waits") == "prompt" or agent == agent_of(event)
    # A permission dialog holds up its batch, so the batch resolving means it was answered. A
    # subagent's batch answers only its own dialog: subagents share the session's id.
    return name == "PostToolBatch" and item.get("waits") != "prompt" and agent == agent_of(event)


def answered(event, flag, started):
    return [agent for agent, item in (flag or {}).items() if answers(event, agent, item, started)]


def run_hook(command, event):
    session_id = re.sub(r"[^\w.-]", "", str(event.get("session_id") or ""))[:64]
    if not session_id:
        return
    board_path = setting("FILE", "~/markychecky.md")
    waiting = on("WAITING")
    idle_hours = idle_hours_setting()
    state_path = os.path.join(data_dir(), "sessions", f"{session_id}.json")
    # Whether this session has a notification item on the board, and what answers it. `respond`
    # runs after every batch of tools, so it checks this before it takes the lock, and does
    # nothing the rest of the time.
    flag_path = os.path.join(data_dir(), "sessions", f"{session_id}.notify")
    agent = agent_of(event)

    if command == "respond":
        started = now()
        if not answered(event, read_flag(flag_path), started):
            return

        def update(board):
            # Again under the lock: a notification may have come in since, which this doesn't answer.
            flag = read_flag(flag_path) or {}
            done = answered(event, flag, started)
            if not done:
                return board
            save_flag(flag_path, {a: item for a, item in flag.items() if a not in done})
            return without_notify(board, session_id, done)

        write_board(board_path, update, data_dir())
        return

    if command == "notify":
        text, waits = notification_text(event)
        if not waiting or not text:
            return
        at = now().isoformat()
        line = f"- {one_line(place(event.get('cwd')))}: {text} " + NOTIFY.format(
            session=session_id, agent=f" agent={agent}" if agent else "", at=at
        )
        opening = []

        def update(board):
            # The main agent and each subagent have an item of their own: their dialogs can be
            # open at once, and each is answered on its own.
            flag = read_flag(flag_path) or {}
            flag[agent] = {"waits": waits, "at": at}
            save_flag(flag_path, flag)
            state = load_state(state_path)
            if first_open(state):
                save_state(state_path, state)
                opening.append(True)
            board = without_notify(board, session_id, [agent])
            board = edit_waiting(board, lambda lines: lines + [line])
            return sweep(board, idle_hours, session_id)

        if write_board(board_path, update, data_dir()) or opening:
            open_in_markydowny(board_path)
        return

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
            if os.path.exists(flag_path):
                os.unlink(flag_path)
            board = without_notify(board, session_id)
            if not state.get("wrote"):
                return board  # never wrote a section
            ended = now()
            state["ended"] = ended.isoformat()
        if first_open(state):
            first.append(True)
        state["wrote"] = True
        save_state(state_path, state)
        section = render_section(session_id, state, ended_at=ended)
        board = replace_section(board, session_id, section)
        if waiting:
            board = ensure_waiting(board)
        return sweep(board, idle_hours, session_id)

    write_board(board_path, update, data_dir())
    if first:
        open_in_markydowny(board_path)


def run_waiting(args):
    """`waiting add|remove|list`, which a session runs itself. Unlike the hooks, these say what
    they did, and a mistake in how they're called fails the command."""
    import argparse

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--board", default=setting("FILE", "~/markychecky.md"),
                        help="the board (default: the plugin's file setting, or ~/markychecky.md)")
    common.add_argument("--session", default=os.environ.get("CLAUDE_SESSION_ID") or "cli",
                        help="the session the item belongs to")
    parser = argparse.ArgumentParser(prog="markychecky.py waiting",
                                     description='Edit the board\'s "Waiting on you" section.')
    commands = parser.add_subparsers(dest="action", required=True)
    add = commands.add_parser("add", parents=[common], help="add or update this session's item")
    add.add_argument("--key", required=True, help="a short id for the item, such as release-v1")
    add.add_argument("text", nargs="+", help="what's waiting on the user, on one line")
    remove = commands.add_parser("remove", parents=[common], help="remove an item")
    remove.add_argument("--key", required=True, help="the item's key, or <session>/<key>")
    commands.add_parser("list", parents=[common], help="print the section")
    opts = parser.parse_args(args)

    session = re.sub(r"[^\w.-]", "", opts.session)[:64] or "cli"
    if opts.action == "list":
        try:
            with open(os.path.expanduser(opts.board), encoding="utf-8") as f:
                lines = waiting_lines(f.read())
        except FileNotFoundError:
            lines = []
        for line in lines:
            item = re.search(r"\s*<!-- markychecky:item (\S+) -->", line)
            notify = NOTIFY_RE.search(line)
            if item:
                print(f"{line[: item.start()]}{line[item.end():]}  (key: {item.group(1)})")
            elif notify:
                print(f"{line[: notify.start()].rstrip()}  (a notification; it clears itself)")
            else:
                print(f"{line}  (written by hand; the commands leave it alone)")
        if not lines:
            print("Nothing is waiting on you.")
        return 0

    owner, _, key = opts.key.rpartition("/")
    owner = owner or session
    if not KEY_RE.fullmatch(key) or not KEY_RE.fullmatch(owner):
        parser.error(f"--key {opts.key!r}: use letters, digits, '.', '-' and '_', such as release-v1")
    item_id = f"{owner}/{key}"
    marker = ITEM.format(id=item_id)
    settings = board_settings(opts.board)
    if not settings["waiting"]:
        print("markychecky: \"Waiting on you\" is turned off in the plugin's settings; nothing changed.",
              file=sys.stderr)
        return 0

    if opts.action == "add":
        cwd = os.getcwd()
        text = link_refs(one_line(" ".join(opts.text)), github_repo(cwd))
        line = f"- {one_line(place(cwd))}: {text} {marker}"

        def edit(lines):
            if any(marker in old for old in lines):
                return [line if marker in old else old for old in lines]
            return lines + [line]

        # The session's state, to open the board on its first write as the hooks do, is in the
        # plugin's data folder, which this command only knows from what SessionStart saved.
        data = settings["data"]
        state_path = os.path.join(data, "sessions", f"{session}.json") if data else None
        opening = []

        def update(board):
            if state_path and os.path.isdir(os.path.dirname(state_path)):
                state = load_state(state_path)
                if first_open(state):
                    save_state(state_path, state)
                    opening.append(True)
            return edit_waiting(board, edit)

        if write_board(opts.board, update, data) or opening:
            open_in_markydowny(opts.board, settings["open"])
        print(f"Added {item_id}: {line[2: -len(marker) - 1]}")
        return 0

    found = []

    def drop(board):
        if not find_waiting(board):
            return board
        lines = waiting_lines(board)
        if not any(marker in line for line in lines):
            return board
        found.append(True)
        return edit_waiting(board, lambda lines: [line for line in lines if marker not in line])

    write_board(opts.board, drop, settings["data"])
    if not found:
        print(f"No item {item_id} on the board; nothing changed.", file=sys.stderr)
        return 1
    print(f"Removed {item_id}")
    return 0


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    run_hook(command, json.load(sys.stdin))


if __name__ == "__main__":
    if sys.argv[1:2] == ["waiting"]:
        sys.exit(run_waiting(sys.argv[2:]))
    try:
        main(sys.argv)
    except Exception as error:  # never fail the session over the board
        log(repr(error))
    sys.exit(0)
