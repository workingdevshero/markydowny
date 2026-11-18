#!/usr/bin/env bash
# Sets up markychecky, the Claude Code plugin that keeps a live board of every session:
#
#   curl -fsSL https://markydowny.com/markychecky.sh | bash
#
# It checks for claude and python3, installs the plugin (or updates it, when it's already there),
# turns on the task list it reads in ~/.claude/settings.json, and on a Mac offers to download
# Markydowny to watch the board in. Running it again changes nothing that's already set up.
# Nothing outside ~/.claude/settings.json and the plugin install is changed, except the Markydowny
# download to ~/Downloads when you say yes to it.
#
# Options (after `bash -s --` when piping it):
#   --no-app   don't offer to download Markydowny
#
# What each step does, by hand: https://markydowny.com/docs/markychecky/#or-step-by-step
#
# Everything runs inside main, so bash reads the whole script before running any of it: with
# `curl | bash`, the script is bash's stdin, and anything that read stdin would eat the rest.

MARKETPLACE="workingdevshero/markydowny"
PLUGIN="markychecky@markydowny"
# The first Claude Code that installs from a marketplace in one command (--marketplace).
ONE_COMMAND_VERSION="2.1.292"
DMG_URL="https://github.com/workingdevshero/markydowny/releases/latest/download/Markydowny-mac.dmg"

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

# Whether version $1 is at least $2, both major.minor.patch.
version_at_least() {
    local IFS=.
    local -a have want
    have=($1)
    want=($2)
    local i
    for i in 0 1 2; do
        local h=${have[$i]:-0} w=${want[$i]:-0}
        if [ "$h" -gt "$w" ]; then return 0; fi
        if [ "$h" -lt "$w" ]; then return 1; fi
    done
    return 0
}

# Whether python3 is there and runs. On a Mac, /usr/bin/python3 is there even without the Xcode
# Command Line Tools, as a stub that asks macOS to install them when it runs, so for that one ask
# xcode-select whether they're installed instead of running it.
python_works() {
    local python
    python=$(command -v python3 2>/dev/null) || return 1
    if [ "$(uname -s)" = "Darwin" ] && [ "$python" = "/usr/bin/python3" ]; then
        xcode-select -p >/dev/null 2>&1
    else
        "$python" -c 'import sys' >/dev/null 2>&1
    fi
}

check_requirements() {
    local missing=0
    if ! command -v claude >/dev/null 2>&1; then
        say "markychecky needs Claude Code (the claude command). Install it: https://docs.claude.com/en/docs/claude-code/setup"
        missing=1
    fi
    if ! python_works; then
        if [ "$(uname -s)" = "Darwin" ]; then
            say "markychecky needs python3, which comes with the Xcode Command Line Tools. Install them with: xcode-select --install"
        else
            say "markychecky needs python3. Install it with your package manager, such as: sudo apt install python3"
        fi
        missing=1
    fi
    if [ "$missing" = 1 ]; then
        fail "Then run this again."
    fi
}

install_plugin() {
    if claude plugin list </dev/null 2>/dev/null | grep -q "$PLUGIN"; then
        say "markychecky is already installed. Updating it, if there's a newer version."
        claude plugin update "$PLUGIN" </dev/null || fail "Couldn't update markychecky (claude plugin update $PLUGIN)."
        return
    fi
    local version
    version=$(claude --version </dev/null 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
    say "Installing markychecky."
    if [ -n "$version" ] && version_at_least "$version" "$ONE_COMMAND_VERSION"; then
        claude plugin install markychecky --marketplace "$MARKETPLACE" </dev/null \
            || fail "Couldn't install markychecky (claude plugin install markychecky --marketplace $MARKETPLACE)."
    else
        # Older Claude Code: add the marketplace, then install from it.
        claude plugin marketplace add "$MARKETPLACE" </dev/null \
            || fail "Couldn't add the markydowny marketplace (claude plugin marketplace add $MARKETPLACE)."
        claude plugin install "$PLUGIN" </dev/null \
            || fail "Couldn't install markychecky (claude plugin install $PLUGIN)."
    fi
}

# Adds "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" to the env block of ~/.claude/settings.json, keeping
# every other setting, the way the docs page's snippet does. A file that already has it is left
# untouched. The new file is written beside the old one and moved into place, so it's never left
# half-written, and if something else changed the file meanwhile, it's read again and redone.
turn_on_task_list() {
    python3 - <<'EOF' || fail "Couldn't turn on the task list in ~/.claude/settings.json."
import json, os, shutil, sys, tempfile
path = os.path.expanduser("~/.claude/settings.json")

def read():
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return f.read()

for attempt in range(5):
    text = read()
    try:
        settings = json.loads(text) if text is not None else {}
    except ValueError as error:
        sys.exit(f"~/.claude/settings.json isn't valid JSON ({error}). Fix it, then run this again.")
    if not isinstance(settings, dict) or not isinstance(settings.get("env", {}), dict):
        sys.exit("~/.claude/settings.json doesn't hold the settings object it should. Fix it, then run this again.")
    if settings.get("env", {}).get("CLAUDE_CODE_ENABLE_TODO_TOOLS") == "1":
        print("The task list is already on in ~/.claude/settings.json.")
        sys.exit(0)
    settings.setdefault("env", {})["CLAUDE_CODE_ENABLE_TODO_TOOLS"] = "1"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".settings.json.")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
        if text is not None:
            shutil.copymode(path, temp)
        if read() != text:
            os.unlink(temp)
            continue
        os.replace(temp, path)
    except BaseException:
        if os.path.exists(temp):
            os.unlink(temp)
        raise
    print("Turned on the task list: CLAUDE_CODE_ENABLE_TODO_TOOLS is 1 in ~/.claude/settings.json.")
    sys.exit(0)
sys.exit("~/.claude/settings.json kept changing while this ran. Run this again.")
EOF
}

# On a Mac without Markydowny, offers to download it. Only asks someone at a terminal: with
# `curl | bash` stdin is the script, so the answer is read from /dev/tty, and only when the
# output is a terminal too, so an agent or a CI job running this never waits on a question.
offer_app() {
    [ "$(uname -s)" = "Darwin" ] || return 0
    if [ -d "/Applications/Markydowny.app" ] || [ -d "$HOME/Applications/Markydowny.app" ]; then
        return 0
    fi
    [ -t 1 ] || return 0
    local answer
    if [ -t 0 ]; then
        read -r -p "Download Markydowny to watch the board? [Y/n] " answer || return 0
    elif { : </dev/tty; } 2>/dev/null; then
        read -r -p "Download Markydowny to watch the board? [Y/n] " answer </dev/tty || return 0
    else
        return 0
    fi
    case "$answer" in
        [Nn]*) say "Skipped. Markydowny is at https://markydowny.com/docs/install/ when you want it." ;;
        *)
            local dmg="$HOME/Downloads/Markydowny-mac.dmg"
            local partial="$dmg.download"
            say "Downloading Markydowny to $dmg."
            mkdir -p "$HOME/Downloads"
            if curl -fL --progress-bar -o "$partial" "$DMG_URL" && mv -f "$partial" "$dmg"; then
                # curl doesn't mark what it downloads the way a browser does. Mark it, so Gatekeeper
                # checks the disk image as a download.
                xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");markychecky.sh;" "$dmg" 2>/dev/null || true
                if open "$dmg"; then
                    say "Drag Markydowny to Applications in the window that opened."
                else
                    say "Couldn't open $dmg. Open it from Finder, then drag Markydowny to Applications."
                fi
            else
                rm -f "$partial"
                say "Couldn't download Markydowny. Get it from https://markydowny.com/docs/install/."
            fi
            ;;
    esac
}

main() {
    local app=1
    local arg
    for arg in "$@"; do
        case "$arg" in
            --no-app) app=0 ;;
            *) fail "Unknown option: $arg (the only option is --no-app)" ;;
        esac
    done
    check_requirements
    install_plugin
    turn_on_task_list
    if [ "$app" = 1 ]; then offer_app; fi
    say "Done. Restart any Claude Code session that was already open (claude --resume)."
}

main "$@"
