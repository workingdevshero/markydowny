#!/bin/sh
# markychecky's hook launcher. hooks.json runs it with `task` or `end` and the hook's JSON on
# stdin, and it hands both to the first of these it finds:
#
#   1. Markydowny itself, as `markydowny markychecky task|end`: the app in /Applications or
#      ~/Applications, `markydowny` on PATH (the Linux .deb's /usr/bin/markydowny), or the
#      AppImage whose path is saved in the plugin's data folder, in `markydowny-path`. An app
#      binary has to have the mode (it carries the marker below): an older Markydowny would
#      open its window instead.
#   2. python3 markychecky.py. On a Mac without the Command Line Tools, /usr/bin/python3 is a
#      stub that asks to install them, so it's used only when `xcode-select -p` succeeds.
#   3. Neither: a hint, shown to the user once, on how to get one.
#
# Both engines write the same board and share the same state, so a session can switch between
# them. It never fails the session: it always exits 0.

command=$1
here=${0%/*}
data=${CLAUDE_PLUGIN_DATA:-$HOME/.cache/markychecky}

has_mode() {
    [ -f "$1" ] && [ -x "$1" ] && grep -q -F markychecky-hook-engine-1 "$1" 2>/dev/null
}

for app in /Applications/Markydowny.app/Contents/MacOS/markydowny \
    "$HOME/Applications/Markydowny.app/Contents/MacOS/markydowny" \
    "$(command -v markydowny 2>/dev/null)"; do
    if [ -n "$app" ] && has_mode "$app"; then
        exec "$app" markychecky "$command"
    fi
done
# An AppImage is compressed, so there's no marker to find; the installer only saves a new one.
if [ -f "$data/markydowny-path" ] && IFS= read -r app < "$data/markydowny-path" && [ -n "$app" ] && [ -x "$app" ]; then
    exec "$app" markychecky "$command"
fi

python=$(command -v python3 2>/dev/null)
if [ -n "$python" ] && [ "$(uname -s)" = Darwin ] && [ "$python" = "${MARKYCHECKY_PYTHON_STUB:-/usr/bin/python3}" ] \
    && ! xcode-select -p >/dev/null 2>&1; then
    python=
fi
if [ -n "$python" ]; then
    exec "$python" "$here/markychecky.py" "$command"
fi

if [ ! -e "$data/hint-shown" ] && mkdir -p "$data" 2>/dev/null && : > "$data/hint-shown"; then
    printf '%s\n' "{\"systemMessage\": \"markychecky can't write its board: it needs an up-to-date Markydowny, or Python 3. Install Markydowny from https://markydowny.com/docs/install/ and your sessions' next task updates will write it.\"}"
fi
exit 0
