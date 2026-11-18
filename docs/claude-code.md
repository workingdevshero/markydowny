---
title: Watching Claude Code
nav: Watching Claude Code
order: 3
description: Watch Claude Code or any other AI agent edit your markdown in Markydowny, follow a whole folder, and open every file it edits automatically with a PostToolUse hook.
---

# Watching Claude Code

Markydowny is a good place to watch an AI agent like [Claude Code](https://claude.com/claude-code) write documentation, plans and notes: it re-renders each edit as it lands, highlights it, and keeps it in view. Everything here works with any tool that writes files; Claude Code just has a hook that makes it automatic.

## Leave the document open

The simple route needs no setup:

1. Open the file in Markydowny: the Mac app, or [markydowny.com](https://markydowny.com) in a Chromium browser.
2. Ask the agent to edit it.

Each edit re-renders within a second, the changed blocks light up, and with [Follow](live-reload.md#follow-and-resume) on (the default) the page scrolls to the latest change. Scroll away to read something and Follow pauses; click **Resume** to catch up.

## Watch this folder

*Mac app.* When the agent works across many files, follow the folder instead of one file:

1. Drop the project folder on a Markydowny window, or run `open -a Markydowny path/to/repo`.
2. Choose **Watch this folder** in the list of markdown files.

The window shows the most recently changed markdown file and switches to whichever one changes next, so you always see what the agent is writing. Hidden folders, `node_modules` and `target` are ignored.

To stay on one file, pick it from the list; **Watch this folder** turns following back on.

## Open every file the agent edits

To have each markdown file Claude Code edits open in Markydowny by itself, add a `PostToolUse` hook. Put it in `.claude/settings.json` in your project, or in `~/.claude/settings.json` for every project:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "f=$(jq -r '.tool_input.file_path // empty'); case \"$(printf '%s' \"$f\" | tr '[:upper:]' '[:lower:]')\" in *.md|*.markdown|*.mdown|*.mkd|*.mkdn) open -g -a Markydowny \"$f\" ;; esac; true"
          }
        ]
      }
    ]
  }
}
```

After every `Edit`, `Write` or `MultiEdit`, Claude Code runs the command with the tool call as JSON on its standard input. The command:

1. reads the edited file's path, `tool_input.file_path`, with [`jq`](https://jqlang.org),
2. keeps markdown files only (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, in any case), and
3. opens them with `open -g -a Markydowny`.

The trailing `true` means the hook never reports a failure back to Claude, even for files it skips.

It needs `jq`. macOS 15 Sequoia and later include it; on macOS 12 to 14, install it first with `brew install jq`. Without `jq` the hook still reports success, so nothing opens and nothing says why.

### Why `open -g`

`-g` asks macOS not to bring Markydowny to the front, so your terminal stays in front while Claude keeps editing.

- The first edit to a file opens it, in a new tab if Markydowny already has a window open. Opening a new file still brings Markydowny forward, `-g` or not.
- Later edits to the same file re-open a file that's already showing. Markydowny keeps its one tab, live-reloads it, and with `-g` doesn't take focus.

Without `-g`, every later edit would bring Markydowny to the front too.

## On the web

Without the Mac app, open the file on [markydowny.com](https://markydowny.com) in Chrome, Edge or another Chromium browser with **Choose File**, or by dropping it on the page, and leave the tab open. Live reload and Follow work the same way; the folder watch and the hook need the app. See [Browser support](live-reload.md#browser-support).
