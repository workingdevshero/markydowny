#!/bin/sh
# markychecky's launcher. hooks.json runs it with `task`, `end`, `notify` or `respond` and the
# hook's JSON on stdin; sessions run it with `waiting add|remove|list …`, from the context
# session-start.sh gives them. It hands its arguments, and stdin, to the first of these it finds:
#
#   1. Markydowny itself, as `markydowny markychecky <arguments>`: the app in /Applications or
#      ~/Applications, `markydowny` on PATH (the Linux .deb's /usr/bin/markydowny), or the
#      AppImage whose path is saved in `markydowny-path`, in the plugin's data folder (by an
#      installer) or in ~/.cache/markychecky (by the AppImage itself, each time it starts). An app
#      binary has to have engine 4, the one that does what this version of the plugin does (it
#      carries the marker below): an older Markydowny would open its window, not know `notify`,
#      `respond` or `waiting` (engine 1), leave out session names and put "waiting for your
#      input" lines on the board (engine 2), or not note when it last heard from a session, so
#      never sweep one that went without SessionEnd (engine 3). An AppImage saves the marker on
#      the line after its path.
#   2. python3 markychecky.py. On a Mac without the Command Line Tools, /usr/bin/python3 is a
#      stub that asks to install them, so it's used only when `xcode-select -p` succeeds.
#   3. Neither: a hint, shown to the user once, on how to get one.
#
# Both engines write the same board and share the same state, so a session can switch between
# them. A hook never fails the session: for those it always exits 0. A `waiting` command says
# what it did, and fails when it can't run.

command=$1
here=${0%/*}
data=${CLAUDE_PLUGIN_DATA:-$HOME/.cache/markychecky}
ENGINE=markychecky-hook-engine-4

has_engine() {
    [ -f "$1" ] && [ -x "$1" ] && grep -q -F "$ENGINE" "$1" 2>/dev/null
}

for app in /Applications/Markydowny.app/Contents/MacOS/markydowny \
    "$HOME/Applications/Markydowny.app/Contents/MacOS/markydowny" \
    "$(command -v markydowny 2>/dev/null)"; do
    if [ -n "$app" ] && has_engine "$app"; then
        exec "$app" markychecky "$@"
    fi
done
# An AppImage is compressed, so there's no marker to find in it: it saves its engine instead.
for saved in "$data/markydowny-path" "$HOME/.cache/markychecky/markydowny-path"; do
    app= engine=
    # read fails on a last line with no newline, but has still read it.
    [ -f "$saved" ] && { IFS= read -r app; IFS= read -r engine; } < "$saved" 2>/dev/null
    if [ -n "$app" ] && [ "$engine" = "$ENGINE" ] && [ -f "$app" ] && [ -x "$app" ]; then
        exec "$app" markychecky "$@"
    fi
done

python=$(command -v python3 2>/dev/null)
if [ -n "$python" ] && [ "$(uname -s)" = Darwin ] && [ "$python" = "${MARKYCHECKY_PYTHON_STUB:-/usr/bin/python3}" ] \
    && ! xcode-select -p >/dev/null 2>&1; then
    python=
fi
if [ -n "$python" ]; then
    exec "$python" "$here/markychecky.py" "$@"
fi

if [ "$command" = waiting ]; then
    echo "markychecky can't edit the board: it needs an up-to-date Markydowny, or Python 3. Install Markydowny from https://markydowny.com/docs/install/" >&2
    exit 1
fi
if [ ! -e "$data/hint-shown" ] && mkdir -p "$data" 2>/dev/null && : > "$data/hint-shown"; then
    printf '%s\n' "{\"systemMessage\": \"markychecky can't write its board: it needs an up-to-date Markydowny, or Python 3. Install Markydowny from https://markydowny.com/docs/install/ and your sessions' next task updates will write it.\"}"
fi
exit 0
