---
title: Watching Claude Code
nav: Watching Claude Code
order: 3
description: Watch Claude Code or any other AI agent edit your markdown in Markydowny, follow a whole folder, open every file it edits automatically with a PostToolUse hook, and keep a live board of every session with markychecky.
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

## Watch every session: markychecky

When you have several Claude Code sessions going at once, [markychecky](https://github.com/workingdevshero/markydowny/tree/main/plugins/markychecky) keeps one board of what each of them is doing. The board is a markdown file, `~/markychecky.md`. Each session gets its own section: what it's working on now, then its checklist, ticked off as it goes. Issue and pull request numbers become links. The board opens in Markydowny, so you watch it update.

```markdown
## markydowny · main

**Now:** Signing the app

- [x] Build a universal release
- [ ] **Sign the app and its helpers**
- [ ] Package and notarize the .dmg
```

### Set it up

1. **Install the plugin.** In a terminal:

   ```
   claude plugin install markychecky --marketplace workingdevshero/markydowny
   ```

   Or inside Claude Code: `/plugin marketplace add workingdevshero/markydowny`, then `/plugin install markychecky@markydowny`.

2. **Turn on the task list.** markychecky copies each session's task list (Claude Code's `TaskCreate` and `TaskUpdate` tools) to the board, and some setups don't have those tools on. Add this to `~/.claude/settings.json` so every session has them:

   ```json
   {
     "env": {
       "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"
     }
   }
   ```

   If the file already has settings, add the `env` block alongside them.

3. **Start your sessions.** Sessions you start from now on write to the board. A session that's already running picks it up when you restart it with `claude --resume`.

It needs `python3`, which comes with the Xcode Command Line Tools. Without it, the plugin does nothing.

### Questions for you, and parked work

A session's task list holds the steps of what it's doing now. Questions for you, work that's parked, and things waiting on someone else don't fit there, and they matter more than any one session's checklist. Keep them in one section of your own at the top of the board:

```markdown
# Markychecky

## Waiting on you

- markydowny: OK to delete the 33 GB `mog-desktop-base` VM?
- Parked: the notarized release ([#26](https://github.com/workingdevshero/markydowny/issues/26)), needs a Developer ID certificate
```

markychecky only rewrites the sections it made, which are marked with hidden comments, so anything else in the file stays as you left it. To have your sessions use the section, add a line like this to `~/.claude/CLAUDE.md`:

```
Put questions for me, and work that's parked or waiting on someone else, in the "Waiting on you" section at the top of ~/markychecky.md: one line each, starting with the repository, with links. Edit only that section, and remove your lines once they're resolved.
```

The plugin's [README](https://github.com/workingdevshero/markydowny/tree/main/plugins/markychecky) has its settings: which file to use, whether to open it in Markydowny, and how long ended sessions stay on the board.

## On the web

Without the Mac app, open the file on [markydowny.com](https://markydowny.com) in Chrome, Edge or another Chromium browser with **Choose File**, or by dropping it on the page, and leave the tab open. Live reload and Follow work the same way; the folder watch and the hook need the app. See [Browser support](live-reload.md#browser-support).
