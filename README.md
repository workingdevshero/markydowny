<img src="marky.png" style="width:200px">

# Markydowny

A simple, beautiful markdown viewer — on the web at [markydowny.com](https://markydowny.com), and as a native macOS app that opens `.md` files when you double-click them.

## Features

- 📤 **Drag & Drop**: Simply drag your markdown files or folders into the drop zone
- 📁 **Folder Support**: Drop entire folders containing markdown files
- 📄 **Multiple File Selection**: When multiple markdown files are found, choose which one to view
- 🖱️ **Click to Browse**: Alternative file selection via clicking
- 🎨 **Beautiful Rendering**: Clean, readable markdown output with syntax highlighting
- 🖼️ **Image Support**: Relative image paths in markdown are automatically resolved from folders
- ⛶ **Fullscreen Mode**: Expand content for distraction-free reading
- 📱 **Responsive Design**: Works great on desktop and mobile
- ↩️ **Easy Reset**: Go back to drop zone to load another file

## How to Use

1. Open `index.html` in your web browser
2. Either:
   - Drag and drop a `.md` or `.markdown` file into the drop zone
   - Drag and drop a folder containing markdown files
   - Click the "Choose File" button to browse for a file
3. If you dropped a folder with multiple markdown files, select which one you want to view from the list
4. Watch your markdown render beautifully!
5. Use the fullscreen button (⛶) for distraction-free reading
6. Click the "← Back to Drop Zone" button to load another file

## Supported File Types

- `.md` (Markdown)
- `.markdown` (Markdown)
- `.txt` (Plain text)
- Any other text file

## Desktop App (macOS)

The same viewer ships as a small native app built with [Tauri](https://tauri.app).

- 🖱️ **Double-click to open**: registers as a viewer for `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`
- 🪟 **One window per document**: open several files at once, or follow a link to another `.md` file
- 🖼️ **Local images just work**: relative image paths resolve from the file's location on disk
- 🔄 **Live reload**: when the file changes on disk (another editor, an agent), the window re-renders it within a second and keeps your place
- ⌘O **File > Open…**, plus drag & drop of files or folders onto any window
- 🌙 **Dark mode**: follows your macOS appearance
- 🔗 **Links** open in your default browser

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
```

Requirements: Node 18+, Rust (the version is pinned in `rust-toolchain.toml`, so rustup installs it automatically), and Xcode command line tools.

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

## Project Layout

```
index.html, js/, *.svg, *.png   The web app (served as-is by GitHub Pages from the repo root)
js/core.js                      Pure helpers shared by web + desktop (unit tested)
js/app.js                       UI; detects Tauri and switches to native file handling
js/vendor/marked.umd.js         Vendored markdown parser (refresh with `npm run vendor`)
src-tauri/                      Desktop shell: file associations, window routing, file access, crash reporting
scripts/build-frontend.mjs      Copies the web app into dist/ for the desktop build
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
