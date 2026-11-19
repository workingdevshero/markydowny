# markychecky

A live board of what every Claude Code session is doing. Each session gets its own section of one markdown file: what it's doing now, and its checklist, ticked off as it works. Open the board in [Markydowny](https://markydowny.com) and it updates in front of you, highlighting each change.

**Setting it up for someone else?** Send them [markydowny.com/docs/markychecky](https://markydowny.com/docs/markychecky/). It has every step, with a check for each, written so their agent can do the setup.

```markdown
## markydowny · feat/release-mac

**Now:** Signing the app

- [x] Build a universal release
- [ ] **Sign the app and its helpers**
- [ ] Package and notarize the .dmg
```

## Install

In a terminal:

```
curl -fsSL https://markydowny.com/markychecky.sh | bash
```

That checks for `claude` and `python3`, installs the plugin (or updates it), turns on the task list in `~/.claude/settings.json` and, on a Mac, offers to download Markydowny. Running it again changes nothing that's already set up. Then restart any session that was already open (`claude --resume`). The script is [`markychecky.sh`](../../markychecky.sh) in this repository.

If something's still missing, such as the task list or `python3`, a new session says so when it starts. markychecky never changes your settings itself.

### Or step by step

1. **Install the plugin.** In a terminal:

   ```
   claude plugin install markychecky --marketplace workingdevshero/markydowny
   ```

   Or inside Claude Code: `/plugin marketplace add workingdevshero/markydowny`, then `/plugin install markychecky@markydowny`.

2. **Turn on the task list.** markychecky reads each session's task list, and some setups don't have the task tools on, interactive sessions included. Add this to `~/.claude/settings.json` so every session has them:

   ```json
   {
     "env": {
       "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"
     }
   }
   ```

   If the file already has settings, add the `env` block alongside them.

3. **Start your sessions.** New sessions write to the board. A session that's already running picks it up when you restart it with `claude --resume`.

It needs Markydowny (or Python 3). The hook runs on [Markydowny](https://markydowny.com/docs/install/) when it's installed, and falls back to `python3`, which comes with the Xcode Command Line Tools on a Mac and with most Linux systems, when it isn't. With neither, the board doesn't update, and each new session says so as it starts.

## How it works

Claude Code sessions keep a task list as they work (`TaskCreate` and `TaskUpdate`, or `TodoWrite` in older versions). After each change, a hook rewrites that session's section from its list:

- **The heading** is the repository and branch, or the folder outside git.
- **Now** is what's in progress.
- **The checklist** follows, in the order the tasks were made. The task in progress is bold.
- **Issue and pull request numbers become links.** `#18` links into the session's GitHub repository (its `origin` remote), and `owner/repo#18` links to the repository it names. A bare `repo#18` is linked only when it names the session's own repository; anything else stays plain text rather than becoming a wrong link.

The hook does the writing, not the model, so sessions never have to remember to update the board. It runs on the Markydowny app (`markydowny markychecky task`), or on `scripts/markychecky.py` without it; `scripts/markychecky.sh` picks one, and both write the same board. The launcher only uses an app that has every command this version of the plugin runs; with an older Markydowny, it uses Python.

**Many sessions at once are safe.** Each write takes a lock, re-reads the board, replaces only its own section and swaps the file in atomically. Sections are found by hidden markers (`<!-- markychecky:start … -->`), so notes you write between sections are kept. Everything inside a section is the session's: a heading you rename still belongs to that session, but it's rewritten from the repository and branch on the next update.

**Ended sessions** are marked idle, and removed after a day.

**The first time a session writes**, the board opens in Markydowny in the background if it's installed. It doesn't take focus from your terminal.

## Questions for you, and parked work

A session's task list holds the steps of what it's doing now. Questions for you, parked work and things waiting on someone else don't fit there, so the board has a `## Waiting on you` section at the top for them. It's automatic:

- **The section comes with the board.** markychecky puts it at the top of a new board, and adds it to a board that doesn't have one. A heading of any level with that text counts.
- **Sessions know about it.** As each session starts, the plugin tells it where the board is and gives it three commands, run through `scripts/markychecky.sh` like the hooks: `waiting add --key <key> "<text>"` adds a line, or updates the one with that key; `waiting remove --key <key>` removes it; and `waiting list` shows what's there. The commands take the same lock as the hooks, so no edit is lost.
- **A session waiting on you shows up by itself.** When a session stops for a permission prompt, or sits waiting for your input, a line such as `markydowny · main: needs permission to use Bash` appears. It goes as soon as you respond, or when the session ends.

```markdown
## Waiting on you

- markydowny · main: OK to delete the 33 GB `mog-desktop-base` VM?
- web · pricing: the pricing copy needs your sign-off ([#51](https://github.com/workingdevshero/web/pull/51))
- api · fix/login: waiting for your input
```

Each line starts with the session's repository and branch, and `#51`-style references become links as they do in task text. A line a session adds stays after the session ends, until a session or you remove it; ended-session cleanup (`idle_hours`) never touches it. The plugin finds its own lines by a hidden marker at the end of each (`<!-- markychecky:item … -->`). Lines you write in the section have no marker, and the plugin never changes them.

You don't need a line in `~/.claude/CLAUDE.md` for any of this. If you added one for an earlier version, it can stay: the plugin tells sessions the same thing, and that its commands are how to do it.

## Settings

Set these with `/plugin` (or `claude plugin configure markychecky`):

| Option | Default | What it does |
|---|---|---|
| `file` | `~/markychecky.md` | The board every session writes to |
| `open` | `true` | Open the board in Markydowny on a session's first write (macOS) |
| `idle_hours` | `24` | How long an ended session's section stays |
| `waiting` | `true` | Keep the "Waiting on you" section: the section itself, telling sessions about it, its commands' edits and the waiting-for-you lines |

Problems are logged to `markychecky.log` in the plugin's data folder. A hook never fails your session.

## Notes

- No section for a session? It probably has no task tools: see step 2 of [Or step by step](#or-step-by-step). Headless runs (`claude -p`) need the same setting.
- The board's lock is a hidden file next to it, `.markychecky.md.lock`.
- Each session's start also saves the `waiting` and `open` settings next to the board, in `.markychecky.md.settings.json`, for the `waiting` commands, which run without the plugin's settings.
- The board is plain markdown, so any viewer works. Markydowny is the one that reloads it live.
