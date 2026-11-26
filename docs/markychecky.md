---
title: markychecky
nav: markychecky
order: 3.5
description: markychecky is a free Claude Code plugin that keeps one live markdown board of what every Claude Code session is doing. Install it with one command, in the terminal or the Claude desktop app.
---

# markychecky

> **Setting this up with your AI agent?** Give it this page, [markydowny.com/docs/markychecky](https://markydowny.com/docs/markychecky/), and ask it to set markychecky up for you. Everything it needs is in **Set it up** below, and each step says how to check it worked. The page's source is plain markdown too, [here](https://raw.githubusercontent.com/workingdevshero/markydowny/main/docs/markychecky.md).

**One live board of what every Claude Code session is doing.**

Running three Claude Code sessions in three repos, you lose track: which one is waiting on you, which one finished, which one is about to start the same work as another. markychecky keeps one markdown file, `~/markychecky.md`, with a section for each session: what it's working on now and its checklist, ticked off as it goes. Open the file in Markydowny and it updates in front of you, highlighting each change.

<video class="docs-video" src="/docs/media/markychecky-board.mp4" poster="/docs/media/markychecky-board-poster.jpg" autoplay muted loop playsinline aria-label="A markychecky board in Markydowny: three agent sessions and a person tick off tasks, change what they're working on, and add a question to Waiting on you, each change highlighted as it lands.">
  <a href="/docs/media/markychecky-board.mp4">Watch a markychecky board update live (21 seconds)</a>
</video>

- **Nothing to remember.** Claude Code already keeps a task list as it works. A hook copies it to the board after every change, so sessions never have to remember to update it.
- **Each session owns its section.** Sessions only ever rewrite their own section, and many sessions writing at once is safe. Anything you write between sections stays.
- **Clickable.** Issue and pull request numbers like `#18` become links to the session's GitHub repository.
- **Agents can read it too.** A session can read the board to see what the others are doing before it starts something.
- **Local and free.** It's a hook that runs on Markydowny (or Python) and a markdown file on your machine. Nothing is sent anywhere.

## Set it up

markychecky works in Claude Code in the terminal, in the **Code** tab of the Claude desktop app, and in the VS Code extension, on macOS and Linux. They all read the same settings on one computer, so setting it up once covers all of them.

In a terminal:

```bash
curl -fsSL https://markydowny.com/markychecky.sh | bash
```

That checks for `claude` and `python3`, installs the plugin (or updates it), turns on the task list in `~/.claude/settings.json` and, on a Mac, offers to download Markydowny. It changes nothing else without asking, and running it again changes nothing that's already set up. To skip the Markydowny offer, end the command with `bash -s -- --no-app` instead of `bash`. Then restart any Claude Code session that was already open (`claude --resume`). The [script](https://markydowny.com/markychecky.sh) is short and readable, if you'd like to see it first.

If something's still missing, a new session says what, when it starts.

### Or step by step

These are the steps the command takes, for anyone who wants to see what changes.

#### 1. Check what you need

You need Claude Code, and Markydowny (or Python 3) for the plugin's hook to run on:

```bash
claude --version   # Claude Code
ls /Applications/Markydowny.app || command -v markydowny  # Markydowny, on a Mac or on Linux
python3 --version  # or Python 3
```

The hook runs on Markydowny when it's installed ([install it](https://markydowny.com/docs/install/)), and falls back to `python3` when it isn't. On a Mac, `python3` comes with the Xcode Command Line Tools (`xcode-select --install`); most Linux systems have it already. With neither, the board doesn't update, and each new session says so as it starts.

#### 2. Install the plugin

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

#### 3. Turn on the task list

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

#### 4. Start your sessions

Sessions you start from now on write to the board. A session that's already running picks it up when you restart it: quit, then `claude --resume` to carry on where you were.

**Check:** run one short session that makes a task list:

```bash
claude -p "Make a task list with one task, 'Say hello to markychecky', mark it in progress, then mark it done."
grep -A6 'markychecky:start' ~/markychecky.md
```

The board has a section for that session, with the task ticked. A session marked idle like this one is removed after a day. One that stops without ending (you close its terminal, say) is marked idle once nothing has been heard from it for a day, and removed a day after that.

#### 5. Watch the board

Open `~/markychecky.md` in Markydowny and leave it open:

- **Mac app:** [download Markydowny for Mac](https://github.com/workingdevshero/markydowny/releases/latest/download/Markydowny-mac.dmg) (signed and notarized; the [Download](install.md) page has Linux too). Once it's installed, markychecky opens the board in it by itself the first time a session writes to it, in the background, without taking focus from your terminal.
- **On the web:** open [markydowny.com](https://markydowny.com) in Chrome, Edge or another Chromium browser, click **Choose File** and pick `markychecky.md` in your home folder. Leave the tab open and it live-reloads.

Any markdown viewer can show the board; Markydowny is the one that updates it live and highlights what changed.

## Questions for you, and parked work

A session's task list holds the steps of what it's doing now. Questions for you, work that's parked and things waiting on someone else don't fit there, and they matter more than any one session's checklist. So the board has one section for them at the top, and it's automatic:

```markdown
# Markychecky

## Waiting on you

- markydowny · main (Disk cleanup): OK to delete the 33 GB `mog-desktop-base` VM?
- web · pricing (Pricing page): the pricing copy needs your sign-off ([#51](https://github.com/workingdevshero/web/pull/51))
- api · fix/login (Login bug): needs permission to use Bash
```

- **It comes with the board.** markychecky puts `## Waiting on you` at the top of a new board, and adds it to a board that doesn't have one.
- **Sessions know to use it.** As each session starts, markychecky tells it where the board is and how to add a line when something needs you, and remove it once it's resolved. Sessions do that with markychecky's own commands, which take the same lock as everything else that writes to the board, so no line is lost.
- **A session stopped on a question shows up by itself.** When a session stops for a permission prompt, a line like `api · fix/login (Login bug): needs permission to use Bash` appears, and goes as soon as you answer. A session that has only finished its turn doesn't get one.
- **Each line says which session it's from.** It starts with the session's repository, branch and name, the same as the heading of the session's section. The name is the one you gave the session with `/rename`, or else the one Claude Code made up for it.

A line a session adds stays when the session ends, until it's resolved and removed. Lines you write there yourself are never changed.

You don't need to add anything to `~/.claude/CLAUDE.md`. If you added a "Waiting on you" line there for an earlier version, it can stay: markychecky tells sessions the same thing.

## Settings

Change these with `claude plugin configure markychecky`, or in `/plugin` > **Installed** > markychecky > **Configure options**:

| Option | Default | What it does |
|---|---|---|
| `file` | `~/markychecky.md` | The board every session writes to |
| `open` | `true` | Open the board in Markydowny on a session's first write (macOS) |
| `idle_hours` | `24` | How long an ended session's section stays on the board, and how long a session that stopped without ending goes unheard before it's marked idle |
| `waiting` | `true` | Keep the "Waiting on you" section at the top of the board, and tell sessions about it |

## Keep it up to date

Plugins from the markydowny marketplace don't update automatically unless you turn that on. Update by hand with:

```bash
claude plugin update markychecky@markydowny
```

Or turn on auto-update: `/plugin` > **Marketplaces** > markydowny > **Enable auto-update**.

A session that's already running keeps the version it started with. It picks up an update when you restart it: quit, then `claude --resume` to carry on where you were.

## If a session doesn't show up

- **No task list.** The session doesn't have `TaskCreate` and `TaskUpdate`. Check step 3, then restart the session.
- **Started before the install.** Restart it with `claude --resume`.
- **Old behaviour after an update.** A session that was running when you updated still runs the old version. Restart it with `claude --resume`.
- **Neither Markydowny nor Python.** The plugin says so once, the first time a session updates its tasks. Install Markydowny, or Python 3 (step 1). An older Markydowny without the hook built in is skipped.
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
