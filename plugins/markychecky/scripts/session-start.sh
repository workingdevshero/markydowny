#!/bin/sh
# markychecky's SessionStart hook: when a session can't write to the board, it tells you why
# and how to fix it, once, as the session starts. It's sh rather than Python so it can say that
# python3 is missing. It never changes a setting and never fails the session.
#
# The task tools markychecky reads are on when CLAUDE_CODE_ENABLE_TODO_TOOLS is set, in the
# shell or in the env block of ~/.claude/settings.json, which Claude Code passes to its hooks.

cat >/dev/null 2>&1 # the hook's JSON, unused

# Whether python3 is there and runs. On a Mac, /usr/bin/python3 is there even without the Xcode
# Command Line Tools, as a stub that asks macOS to install them when it runs, so for that one ask
# xcode-select whether they're installed instead of running it.
python_works() {
    python=$(command -v python3 2>/dev/null) || return 1
    if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && [ "$python" = "/usr/bin/python3" ]; then
        xcode-select -p >/dev/null 2>&1
    else
        "$python" -c 'import sys' >/dev/null 2>&1
    fi
}

FIX="Run: curl -fsSL https://markydowny.com/markychecky.sh | bash"

if ! python_works; then
    problem="markychecky can't update the board: it needs python3, which isn't installed."
    if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
        FIX="Install it with: xcode-select --install"
    else
        FIX="Install it with your package manager."
    fi
else
    case "$CLAUDE_CODE_ENABLE_TODO_TOOLS" in
        "" | 0 | false | no) ;;
        *) exit 0 ;;
    esac
    problem="markychecky can't update the board: this session may have no task list (CLAUDE_CODE_ENABLE_TODO_TOOLS isn't set)."
    FIX="$FIX, or add \\\"CLAUDE_CODE_ENABLE_TODO_TOOLS\\\": \\\"1\\\" to the env block of ~/.claude/settings.json"
fi

# systemMessage is shown to you, not the model. The text holds no characters JSON would need
# escaped beyond the quotes above.
printf '{"systemMessage": "%s %s. Then restart the session (claude --resume)."}\n' "$problem" "$FIX"
exit 0
