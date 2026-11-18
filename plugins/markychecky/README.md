# markychecky

A live board of what every Claude Code session is doing. Each session gets its own section of one markdown file: what it's doing now, and its checklist, ticked off as it works. Open the board in [Markydowny](https://markydowny.com) and it updates in front of you, highlighting each change.

```markdown
## markydowny · feat/release-mac

**Now:** Signing the app

- [x] Build a universal release
- [ ] **Sign the app and its helpers**
- [ ] Package and notarize the .dmg
```

## Install

```
/plugin install markychecky --marketplace workingdevshero/markydowny
```

Or in two steps: `/plugin marketplace add workingdevshero/markydowny`, then `/plugin install markychecky@markydowny`.

It needs `python3`, which comes with the Xcode Command Line Tools on a Mac and with most Linux systems. Without it, the plugin does nothing.

## How it works

Claude Code sessions keep a task list as they work (`TaskCreate` and `TaskUpdate`, or `TodoWrite` in older versions). After each change, a hook rewrites that session's section from its list:

- **The heading** is the repository and branch, or the folder outside git.
- **Now** is what's in progress.
- **The checklist** follows, in the order the tasks were made. The task in progress is bold.

The script does the writing, not the model, so sessions never have to remember to update the board.

**Many sessions at once are safe.** Each write takes a lock, re-reads the board, replaces only its own section and swaps the file in atomically. Sections are found by hidden markers (`<!-- markychecky:start … -->`), so you can rename a heading or write notes between sections, and they're kept.

**Ended sessions** are marked idle, and removed after a day.

**The first time a session writes**, the board opens in Markydowny in the background if it's installed. It doesn't take focus from your terminal.

## Settings

Set these with `/plugin` (or `claude plugin configure markychecky`):

| Option | Default | What it does |
|---|---|---|
| `file` | `~/markychecky.md` | The board every session writes to |
| `open` | `true` | Open the board in Markydowny on a session's first write (macOS) |
| `idle_hours` | `24` | How long an ended session's section stays |

Problems are logged to `markychecky.log` in the plugin's data folder. A hook never fails your session.

## Notes

- Headless runs (`claude -p`) only have the task tools with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` set. Interactive sessions have them already.
- The board is plain markdown, so any viewer works. Markydowny is the one that reloads it live.
