---
title: markychecky
nav: markychecky
order: 3.5
description: markychecky is a free Claude Code plugin that keeps one live markdown board of what every Claude Code session is doing. Install it with one command, in the terminal or the Claude desktop app.
---

# markychecky

**One live board of what every Claude Code session is doing.**

Running three Claude Code sessions in three repos, you lose track: which one is waiting on you, which one finished, which one is about to start the same work as another. markychecky keeps one markdown file, `~/markychecky.md`, with a section for each session: what it's working on now and its checklist, ticked off as it goes. Open the file in Markydowny and it updates in front of you, highlighting each change.

```markdown
## markydowny · main

**Now:** Signing the app

- [x] Build a universal release
- [ ] **Sign the app and its helpers**
- [ ] Package and notarize the .dmg

## web · feat/pricing

**Now:** Writing the pricing page tests

- [x] Add the pricing page
- [ ] **Write the pricing page tests**
```

- **Nothing to remember.** Claude Code already keeps a task list as it works. A hook copies it to the board after every change, so sessions never have to remember to update it.
- **Each session owns its section.** Sessions only ever rewrite their own section, and many sessions writing at once is safe. Anything you write between sections stays.
- **Clickable.** Issue and pull request numbers like `#18` become links to the session's GitHub repository.
- **Agents can read it too.** A session can read the board to see what the others are doing before it starts something.
- **Local and free.** It's a small Python script and a markdown file on your machine. Nothing is sent anywhere.

## Set it up

> **Setting this up with your AI agent?** Give it this page, [markydowny.com/docs/markychecky](https://markydowny.com/docs/markychecky/), and ask it to set markychecky up for you. Everything it needs is in this section, and each step says how to check it worked. The page's source is plain markdown too, [here](https://raw.githubusercontent.com/workingdevshero/markydowny/main/docs/markychecky.md).

markychecky works in Claude Code in the terminal, in the **Code** tab of the Claude desktop app, and in the VS Code extension, on macOS and Linux. They all read the same settings on one computer, so setting it up once covers all of them.

### 1. Check what you need

```bash
claude --version   # Claude Code
python3 --version  # Python 3, which the plugin's hook runs on
```

On a Mac, `python3` comes with the Xcode Command Line Tools (`xcode-select --install`). Most Linux systems have it already. Without it, the plugin does nothing.

### 2. Install the plugin

In a terminal:

```bash
claude plugin install markychecky --marketplace workingdevshero/markydowny
```

That adds the markydowny plugin marketplace and installs markychecky for your user, in every project. It needs Claude Code 2.1.292 or later; on an older version, run it in two steps:

```bash
claude plugin marketplace add workingdevshero/markydowny
claude plugin install markychecky@markydowny
```

Inside a Claude Code session, the same thing is `/plugin marketplace add workingdevshero/markydowny`, then `/plugin install markychecky@markydowny`. In the desktop app's **Code** tab, after the marketplace is added, it's also in **+** > **Add plugins**.

**Check:** `claude plugin list` shows `markychecky@markydowny`, enabled.

### 3. Turn on the task list

markychecky reads each session's task list (Claude Code's `TaskCreate` and `TaskUpdate` tools), and some setups don't have those tools turned on. Add `CLAUDE_CODE_ENABLE_TODO_TOOLS` to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"
  }
}
```

If the file already has settings, add the `env` block alongside them, or add the one line to an `env` block that's already there. This command does that and keeps everything else in the file:

```bash
python3 - <<'EOF'
import json, os
path = os.path.expanduser("~/.claude/settings.json")
settings = json.load(open(path)) if os.path.exists(path) else {}
settings.setdefault("env", {})["CLAUDE_CODE_ENABLE_TODO_TOOLS"] = "1"
with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
print("CLAUDE_CODE_ENABLE_TODO_TOOLS is on")
EOF
```

**Check:** `python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.claude/settings.json")))["env"])'` prints `{'CLAUDE_CODE_ENABLE_TODO_TOOLS': '1'}` along with any other variables you had.

### 4. Start your sessions

Sessions you start from now on write to the board. A session that's already running picks it up when you restart it: quit, then `claude --resume` to carry on where you were.

**Check:** run one short session that makes a task list:

```bash
claude -p "Make a task list with one task, 'Say hello to markychecky', mark it in progress, then mark it done."
grep -A6 'markychecky:start' ~/markychecky.md
```

The board has a section for that session, with the task ticked. A session marked idle like this one is removed after a day.

### 5. Watch the board

Open `~/markychecky.md` in Markydowny and leave it open:

- **Mac app:** if Markydowny is installed, markychecky opens the board in it by itself the first time a session writes to it, in the background, without taking focus from your terminal. See [Install](install.md) for the app.
- **On the web:** open [markydowny.com](https://markydowny.com) in Chrome, Edge or another Chromium browser, click **Choose File** and pick `markychecky.md` in your home folder. Leave the tab open and it live-reloads.

Any markdown viewer can show the board; Markydowny is the one that updates it live and highlights what changed.

## Questions for you, and parked work

A session's task list holds the steps of what it's doing now. Questions for you, work that's parked and things waiting on someone else don't fit there, and they matter more than any one session's checklist. Keep them in one section of your own at the top of the board:

```markdown
# Markychecky

## Waiting on you

- markydowny: OK to delete the 33 GB `mog-desktop-base` VM?
- web: the pricing copy needs your sign-off ([#51](https://github.com/workingdevshero/web/pull/51))
```

markychecky only rewrites the sections it made, which are marked by hidden comments, so it leaves this one alone. To have your sessions use it, add this line to `~/.claude/CLAUDE.md`:

```
Put questions for me, and work that's parked or waiting on someone else, in the "Waiting on you" section at the top of ~/markychecky.md: one line each, starting with the repository, with links. Edit only that section, and remove your lines once they're resolved.
```

## Settings

Change these with `claude plugin configure markychecky`, or in `/plugin` > **Installed** > markychecky > **Configure options**:

| Option | Default | What it does |
|---|---|---|
| `file` | `~/markychecky.md` | The board every session writes to |
| `open` | `true` | Open the board in Markydowny on a session's first write (macOS) |
| `idle_hours` | `24` | How long an ended session's section stays on the board |

## Keep it up to date

Plugins from the markydowny marketplace don't update automatically unless you turn that on. Update by hand with:

```bash
claude plugin update markychecky@markydowny
```

Or turn on auto-update: `/plugin` > **Marketplaces** > markydowny > **Enable auto-update**.

## If a session doesn't show up

- **No task list.** The session doesn't have `TaskCreate` and `TaskUpdate`. Check step 3, then restart the session.
- **Started before the install.** Restart it with `claude --resume`.
- **No `python3`.** `command -v python3` prints nothing. Install it (step 1).
- **A cloud session.** Sessions in the cloud, including claude.ai/code in the browser, don't load plugins installed on your computer, so they can't write to its board.
- **Not Claude Code.** markychecky is a Claude Code plugin. Claude chat on claude.ai and Cowork have their own, separate plugins.
- **Still nothing?** The plugin logs problems to `~/.claude/plugins/data/markychecky-markydowny/markychecky.log`. A problem never interrupts your session; the board just doesn't update.

## Remove it

```bash
claude plugin uninstall markychecky@markydowny
```

The board stays where it is; delete `~/markychecky.md` if you don't want it.

## Source

markychecky is open source, in the [markydowny repository](https://github.com/workingdevshero/markydowny/tree/main/plugins/markychecky). Its README covers how it works in more detail.
