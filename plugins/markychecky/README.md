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

The hook does the writing, not the model, so sessions never have to remember to update the board. It runs on the Markydowny app (`markydowny markychecky task`), or on `scripts/markychecky.py` without it; `scripts/markychecky.sh` picks one, and both write the same board.

**Many sessions at once are safe.** Each write takes a lock, re-reads the board, replaces only its own section and swaps the file in atomically. Sections are found by hidden markers (`<!-- markychecky:start … -->`), so notes you write between sections are kept. Everything inside a section is the session's: a heading you rename still belongs to that session, but it's rewritten from the repository and branch on the next update.

**Ended sessions** are marked idle, and removed after a day.

**The first time a session writes**, the board opens in Markydowny in the background if it's installed. It doesn't take focus from your terminal.

## Questions for you, and parked work

A session's task list holds the steps of what it's doing now. Questions for you, parked work and things waiting on someone else don't fit there. Keep them in a section of your own at the top of the board, such as `## Waiting on you`. markychecky only rewrites the sections it made, so anything else in the file is left alone. Its own updates take a lock that a session's edits don't, though, so an edit made in the same instant as an update can be lost; the line below has sessions check theirs landed.

To have your sessions use it, add a line like this to `~/.claude/CLAUDE.md`:

```
Put questions for me, and work that's parked or waiting on someone else, in the "Waiting on you" section at the top of ~/markychecky.md: one line each, starting with the repository, with links. Edit only that section, read the file again just before each edit, check your line is there afterwards, and remove your lines once they're resolved.
```

## Settings

Set these with `/plugin` (or `claude plugin configure markychecky`):

| Option | Default | What it does |
|---|---|---|
| `file` | `~/markychecky.md` | The board every session writes to |
| `open` | `true` | Open the board in Markydowny on a session's first write (macOS) |
| `idle_hours` | `24` | How long an ended session's section stays |

Problems are logged to `markychecky.log` in the plugin's data folder. A hook never fails your session.

## Notes

- No section for a session? It probably has no task tools: see step 2 of [Or step by step](#or-step-by-step). Headless runs (`claude -p`) need the same setting.
- The board is plain markdown, so any viewer works. Markydowny is the one that reloads it live.
