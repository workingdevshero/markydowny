#!/bin/sh
# markychecky's SessionStart hook. It never changes a setting of yours and never fails the session.
#
# - When a session can't write to the board, it tells you why and how to fix it, once, as the
#   session starts (a systemMessage, shown to you). It's sh rather than Python so it can say that
#   python3 is missing.
# - With "Waiting on you" on, it tells the session (additionalContext, which the model reads)
#   about the board's "Waiting on you" section and the commands that edit it, run through
#   markychecky.sh. Those commands run in the session's shell, which doesn't get the plugin's
#   options, so it also saves the ones they need beside the board, in `.<board>.settings.json`.
#
# The task tools markychecky reads are on when CLAUDE_CODE_ENABLE_TODO_TOOLS is set, in the
# shell or in the env block of ~/.claude/settings.json, which Claude Code passes to its hooks.

event=$(cat 2>/dev/null)
case $0 in
    */*) here=$(cd "${0%/*}" 2>/dev/null && pwd) ;;
    *) here=$PWD ;;
esac

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

# An option is on when it's 1, true or yes, as the engines read it.
on() {
    case $1 in
        1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss]) return 0 ;;
        *) return 1 ;;
    esac
}

# Text as the inside of a JSON string: backslashes and quotes escaped, lines joined with \n.
json() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }'
}

# A word for sh, in single quotes.
quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

FIX="Run: curl -fsSL https://markydowny.com/markychecky.sh | bash"
message=

if ! python_works; then
    problem="markychecky can't update the board: it needs python3, which isn't installed."
    if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
        FIX="Install it with: xcode-select --install"
    else
        FIX="Install it with your package manager."
    fi
    message="$problem $FIX. Then restart the session (claude --resume)."
else
    case "$CLAUDE_CODE_ENABLE_TODO_TOOLS" in
        "" | 0 | false | no)
            problem="markychecky can't update the board: this session may have no task list (CLAUDE_CODE_ENABLE_TODO_TOOLS isn't set)."
            FIX="$FIX, or add \"CLAUDE_CODE_ENABLE_TODO_TOOLS\": \"1\" to the env block of ~/.claude/settings.json"
            message="$problem $FIX. Then restart the session (claude --resume)."
            ;;
    esac
fi

# The settings, as the engines read them: MARKYCHECKY_* (for testing), then the plugin's options.
board=${MARKYCHECKY_FILE:-$CLAUDE_PLUGIN_OPTION_FILE}
waiting=${MARKYCHECKY_WAITING:-${CLAUDE_PLUGIN_OPTION_WAITING:-true}}
open=${MARKYCHECKY_OPEN:-${CLAUDE_PLUGIN_OPTION_OPEN:-true}}
data=${CLAUDE_PLUGIN_DATA:-$HOME/.cache/markychecky}
[ -n "$board" ] || board="~/markychecky.md"
case $board in
    "~") board=$HOME ;;
    "~/"*) board=$HOME/${board#"~/"} ;;
esac
case $board in
    /*) ;;
    *) board=$PWD/$board ;;
esac

on "$waiting" && waiting=true || waiting=false
on "$open" && open=true || open=false
settings="${board%/*}/.${board##*/}.settings.json"
saved=$(printf '{"waiting": %s, "open": %s, "data": "%s"}' "$waiting" "$open" "$(json "$data")")
if [ "$(cat "$settings" 2>/dev/null)" != "$saved" ] && mkdir -p "${board%/*}" 2>/dev/null \
    && printf '%s' "$saved" > "$settings.tmp-$$" 2>/dev/null; then
    mv -f "$settings.tmp-$$" "$settings" 2>/dev/null || rm -f "$settings.tmp-$$"
fi

# The session's id, which its items are filed under. Claude Code's are UUIDs.
session=$(printf '%s' "$event" | tr -d '\n' \
    | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | LC_ALL=C tr -cd 'A-Za-z0-9._-' | cut -c 1-64)

context=
if [ "$waiting" = true ] && [ -n "$session" ]; then
    # It says the same as the line the docs used to have people put in ~/.claude/CLAUDE.md, so
    # a session told both does one thing: the commands are the safe way to make those edits.
    run="sh $(quote "$here/markychecky.sh") waiting"
    where="--board $(quote "$board") --session $session"
    context="markychecky keeps a \"Waiting on you\" section at the top of $board, the board the user watches. When something needs the user (a question, a decision, work you've parked, or something waiting on someone else), add one line there for it, and remove it once it's resolved. Use these commands rather than editing the file: they take the board's lock, so no edit is lost, and they never touch lines you didn't add.

- Add, or update the line with the same key: $run add $where --key <key> \"<text>\"
- Remove it: $run remove $where --key <key>
- See what's there: $run list $where

<key> is a short id you pick, such as release-v1 or ok-to-merge-24. The line starts with the repository, the branch and this session's name by itself, and #123-style references become links. Lines you add stay after this session ends, until they're removed; to remove another session's line, pass the <session>/<key> that list shows. If ~/.claude/CLAUDE.md also asks you to keep this section, these commands are how to do it."
fi

# systemMessage is shown to you; additionalContext goes to the session's model.
if [ -n "$message" ] && [ -n "$context" ]; then
    printf '{"systemMessage": "%s", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s"}}\n' \
        "$(json "$message")" "$(json "$context")"
elif [ -n "$message" ]; then
    printf '{"systemMessage": "%s"}\n' "$(json "$message")"
elif [ -n "$context" ]; then
    printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s"}}\n' "$(json "$context")"
fi
exit 0
