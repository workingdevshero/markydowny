<img src="marky.png" style="width:200px">

# Markydowny

A simple, beautiful markdown viewer — on the web at [markydowny.com](https://markydowny.com), and as a desktop app for macOS, Windows and Linux that opens `.md` files when you double-click them.

📖 **Docs:** [markydowny.com/docs](https://markydowny.com/docs/), one page per feature (sources in [`docs/`](docs/)).

## Features

- 📤 **Drag & Drop**: drop markdown files or folders anywhere on the page, or click **Open a file** in the header
- 📁 **Folder Support**: Drop entire folders containing markdown files
- 📄 **Multiple File Selection**: When multiple markdown files are found, choose which one to view
- 🖱️ **Click to Browse**: Alternative file selection via clicking
- 🎨 **Beautiful Rendering**: Clean, readable markdown output with syntax highlighting
- 🖼️ **Image Support**: Relative image paths in markdown are automatically resolved from folders
- ⛶ **Fullscreen Mode**: Expand content for distraction-free reading
- 🔄 **Live reload in Chrome, Edge and other Chromium browsers**: a file opened with *Choose File* or dropped on the page re-renders when it changes on disk, with the changes highlighted and an optional **Follow** mode (Safari and Firefox read the file once, as before)
- ✏️ **Edit the markdown**: *Edit* (⌘E) opens the source in an editor; ⌘S saves it in place in the desktop app and in Chromium (for files opened with *Choose File* or dropped), and downloads a copy elsewhere. Changes made on disk while you edit are applied, or offered in a banner if you have unsaved changes. While editing, ⌘F opens find and replace, and the top bar shows the word count (and the selection's)
- 🔤 **Formatting toolbar**: while editing, headings, quotes, code blocks, bold (⌘B), italic (⌘I), strikethrough (⌘⇧X), inline code (⌘⇧C), links (⌘K) and bulleted, numbered and task lists (⌘⇧8, ⌘⇧7, ⌘⇧9), with ⌘⌥0–3 for paragraph and headings (Ctrl instead of ⌘ outside the Mac). It edits the markdown in the document's own style (`*` or `_`, `-` or `*`) and shows the formatting at the cursor
- ➕ **Insert tables, images and rules**: pick a table's size from a grid (Tab and Shift-Tab move between its cells in Rich mode, and Tab in the last cell adds a row); in the desktop app, pick an image file to link it by its path from the document, with an offer to copy it next to the document if it's elsewhere (on the web, `![alt](path)` goes in for you to fill in)
- ◫ **Split view**: beside *Rich* and *Markdown*, *Split* shows the markdown with the rendered document next to it, their scrolling kept in step (⌘/ goes round the three; not offered at phone widths)
- 📱 **Responsive Design**: Works great on desktop and mobile
- ↩️ **Easy Reset**: *Open another* takes you back to the drop zone to load another file

## How to Use

1. Open `index.html` in your web browser
2. Either:
   - Drag and drop a `.md` or `.markdown` file anywhere on the page
   - Drag and drop a folder containing markdown files
   - Click **Open a file** in the header (or "Choose File") to browse for a file
3. If you dropped a folder with multiple markdown files, select which one you want to view from the list
4. Watch your markdown render beautifully!
5. Use the fullscreen button (⛶) for distraction-free reading
6. Click *Open another* to load another file

## Supported File Types

- `.md` (Markdown)
- `.markdown` (Markdown)
- `.txt` (Plain text)
- Any other text file

## Desktop App (macOS)

The same viewer ships as a small native app built with [Tauri](https://tauri.app).

**[Download it from markydowny.com](https://markydowny.com/docs/install/)**: a signed, notarized `.dmg` for Mac, and `.deb` and `.AppImage` packages for Linux.

- 🖱️ **Double-click to open**: registers as a viewer for `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`
- 🗂️ **Documents open as tabs**: open several files at once, or follow a link to another `.md` file, and
  each gets a native macOS tab. Opening a file that is already open reuses its tab. Drag tabs between
  windows or out into their own, or use Window > Merge All Windows
- ⌘T **File > New Tab** opens a tab to drop a file into; dropping a folder offers **Open all as tabs**
- 🖼️ **Local images just work**: relative image paths resolve from the file's location on disk
- 🔄 **Live reload**: when the file changes on disk (another editor, an agent), the window re-renders it within a second and keeps your place
- 👀 **Follow**: changed blocks light up briefly, and with **Follow** on the window keeps the latest change in view (scroll away to pause it, click *Resume* to jump back). Handy for watching an agent edit a document
- ⌘O **File > Open…**, plus drag & drop of files or folders onto any window
- 🕘 **File > Open Recent** lists the last ten files and folders you opened, however you opened them, and survives relaunching
- 🌙 **Dark mode**: follows your macOS appearance
- 🔗 **Links** open in your default browser
- 📂 **Watch a folder**: drop a folder (or `open -a Markydowny path/to/repo`) and choose **Watch this folder**. The window shows the most recently changed markdown file and switches to whichever one changes next, skipping hidden folders, `node_modules` and `target`. Pick a file from the list to stay on it

### Watch Claude edit your docs

The simple route: open the file (or folder) in Markydowny, then ask [Claude Code](https://claude.com/claude-code) to edit it. The window follows each edit as it lands.

To have every markdown file Claude edits open by itself, add a `PostToolUse` hook to `.claude/settings.json` in your project, or to `~/.claude/settings.json` for all projects:

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

The hook reads the edited file's path (`tool_input.file_path`) from the JSON Claude Code passes on stdin, keeps markdown files only, and opens them with `open -g`, which leaves your terminal in front. The first edit to a file opens its window; later edits re-open a file that's already showing, so Markydowny keeps its one window, live-reloads it, and doesn't take focus. It needs [`jq`](https://jqlang.org) (`brew install jq`; recent macOS versions include it).

### Watch all your sessions: markychecky

[markychecky](plugins/markychecky) is a Claude Code plugin that keeps a live board of what every session is doing. Each session gets its own section of one markdown file, with what it's working on now and its checklist, ticked off as it goes. The board opens in Markydowny, so you can watch your agents work.

```
curl -fsSL https://markydowny.com/markychecky.sh | bash
```

That installs the plugin and turns on the task list it reads, which some setups leave off, by adding `"env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" }` to `~/.claude/settings.json`. Then restart your sessions. To do it by hand instead, run `claude plugin install markychecky --marketplace workingdevshero/markydowny` and add that setting yourself. The [markychecky page](https://markydowny.com/docs/markychecky/) has the full setup, step by step, written so you can hand it to your agent, including a section of the board for questions waiting on you.

### Install

```bash
npm install
npm run build
```

Then drag `src-tauri/target/release/bundle/macos/Markydowny.app` into `/Applications` (a `.dmg` is built next to it too).

To make it the default for markdown files: in Finder, select any `.md` file → **Get Info** (⌘I) → **Open with:** Markydowny → **Change All…**

### Develop

```bash
npm run dev                   # launch the app
npm run dev -- -- README.md   # launch with a file
npm test                      # JS + Rust tests
npm run docs                  # re-render docs/ after editing a docs/*.md (tests fail on stale HTML)
```

Requirements: Node 18+, Rust (the version is pinned in `rust-toolchain.toml`, so rustup installs it automatically), and Xcode command line tools.

To build a debug app on a fresh machine or VM, for testing:

```bash
scripts/build-desktop.sh   # prints the built artifact's path as its last line
```

On macOS that's `Markydowny.app`; on Linux it's the `markydowny` binary. The app builds and runs on Linux without the macOS-only parts: window tabs, staying open with no windows, and Finder's open events. The script installs Rust, Node, CMake and Ninja if they're missing, and on Debian or Ubuntu the WebKitGTK build dependencies and Clang. Linux needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12), and Clang rather than GCC, for BugSplat's Crashpad.

### Crash reporting

The desktop app reports crashes to [BugSplat](https://www.bugsplat.com) with
the [`bugsplat`](https://crates.io/crates/bugsplat) and
[`tauri-plugin-bugsplat`](https://crates.io/crates/tauri-plugin-bugsplat) crates: native crashes and Rust panics
(minidumps, symbolicated server-side) and JavaScript errors from the viewer windows.

- Set `BUGSPLAT_DATABASE` when building. Builds without it run without crash reporting.
- Building needs CMake and Ninja (`brew install cmake ninja`) for bugsplat-native.
- Release builds keep line tables in a `.dSYM`; upload it after `npm run build` with
  `npm run symbols` (reads `BUGSPLAT_DATABASE`, `SYMBOL_UPLOAD_CLIENT_ID` and
  `SYMBOL_UPLOAD_CLIENT_SECRET` from the environment).
- Debug builds have a **Crash Test** menu (native crash, Rust panic, JavaScript error). Set
  `MARKYDOWNY_CRASH_MENU=1` to show it in a release build, and `MARKYDOWNY_BUGSPLAT_QUIET=1` to
  upload without the crash dialog.

### Releasing

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml):

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` in a pull request.
2. Merge it. [`.github/workflows/tag-release.yml`](.github/workflows/tag-release.yml) tags the merged commit
   `v1.2.0` and starts the release workflow on that tag. If `v1.2.0` already has a release, or tags another
   commit, it does nothing. Re-running it after a failed start runs the release workflow on the tag it made.
   A version with a hyphen (`1.2.0-beta.1`) makes a prerelease, whose `.deb` is versioned `1.2.0~beta.1` so
   the release upgrades it.
3. The workflow checks the tag against the three files (`node scripts/check-release-version.mjs v1.2.0` does
   the same by hand), builds a universal `.dmg` for macOS, a `.deb` and `.AppImage` for Linux on x86_64
   and arm64, and an installer (`-setup.exe`) and `.msi` for Windows on x64, and attaches them, with
   `SHA256SUMS.txt`, to a release, which it publishes once every file is attached. A prerelease has no `.msi`:
   WiX only takes a numeric prerelease. It shows up on the
   [releases page](https://github.com/workingdevshero/markydowny/releases) about 20 minutes after the tag is pushed.

Pushing a tag by hand still works: `git tag v1.2.0 && git push origin v1.2.0` on a commit with the version
already bumped releases it. tag-release.yml skips a version that already has a release, so the two never make
two releases. If a run fails part way, its release stays a draft; re-running the workflow for the tag replaces the
draft's files and notes, then publishes it. A tag whose release is already published isn't rebuilt. Builds have crash reporting on, and upload
their symbols, when the `BUGSPLAT_DATABASE`, `SYMBOL_UPLOAD_CLIENT_ID` and `SYMBOL_UPLOAD_CLIENT_SECRET`
repository secrets are set; the run summary says when they aren't. The Mac build is signed with the
Developer ID and notarized when the `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`,
`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER_ID` secrets are set, and signed ad hoc and not
notarized when they aren't (a fork's pull request); the run summary says which. Pull requests that change the
release build run the same builds without releasing, as does running the workflow by hand from the Actions tab.

To install a release on a Mac:

```bash
gh release download --repo workingdevshero/markydowny --pattern '*.dmg'
open Markydowny-*-universal.dmg   # then drag Markydowny to Applications
```

The Mac build is notarized, so it opens like any other app, however it was downloaded. (A release built
without the Apple secrets isn't, and its notes say how to open it.) The Linux packages need glibc 2.35 or
newer (Ubuntu 22.04, Debian 12, Fedora 36 and later). The Windows installers aren't code-signed yet, so
SmartScreen warns the first time one runs: click **More info**, then **Run anyway**. See
[Download](https://markydowny.com/docs/install/#windows) for making it the default for `.md` files.

## Project Layout

```
index.html, js/, *.svg, *.png   The web app (served as-is by GitHub Pages from the repo root)
js/core.js                      Pure helpers shared by web + desktop (unit tested)
js/format.js                    The editor toolbar's commands, pure functions on the markdown text (unit tested); loaded on first edit
js/app.js                       UI; detects Tauri and switches to native file handling
js/vendor/marked.umd.js         Vendored markdown parser (refresh with `npm run vendor`)
js/vendor/codemirror.js         Vendored editor, bundled from scripts/codemirror-entry.mjs by `npm run vendor`; loaded on first edit
src-tauri/                      Desktop shell: file associations, window routing, file access, crash reporting
scripts/build-frontend.mjs      Copies the web app into dist/ for the desktop build
docs/*.md                       Docs sources; `npm run docs` renders each into docs/<page>/index.html (committed)
scripts/build-docs.mjs          Renders the docs with the vendored marked and one page template
tests/                          JS unit tests (node --test)
```

## Technical Details

- Pure HTML, CSS, and JavaScript — no build process needed for the website
- Uses [marked.js](https://marked.js.org/) (vendored) for markdown parsing
- Fully static — works offline
- Mobile-responsive design
- Desktop app runs with a strict Content Security Policy, so scripts embedded in markdown files never execute

## Running the Web App

Simply open `index.html` in any modern web browser. No server or installation required!

For development, you can also serve it with a simple HTTP server:

```bash
python3 -m http.server 8000
# or
npx serve .
```

Then open `http://localhost:8000` in your browser.
