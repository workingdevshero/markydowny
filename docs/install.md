---
title: Install
nav: Install
order: 6
description: Install Markydowny for macOS, make it the default app for markdown files, or use it on the web with nothing to install. Linux and app store builds are coming.
---

# Install

## On the web

Nothing to install: open [markydowny.com](https://markydowny.com) in any modern browser. Once it has loaded it works offline. For live reload and saving in place, use Chrome, Edge or another Chromium browser (see [Browser support](live-reload.md#browser-support)).

## Mac app

> **Downloads are coming.** Signed, notarized builds of the Mac app will be downloadable from this page. Until then, build it from source; it takes a few minutes.

### Build from source

You need macOS 12 or later, [Node](https://nodejs.org) 18 or later, the Xcode command line tools (`xcode-select --install`), and CMake and Ninja (`brew install cmake ninja`). Rust installs itself through [rustup](https://rustup.rs) at the version the project pins.

```bash
git clone https://github.com/workingdevshero/markydowny.git
cd markydowny
npm install
npm run build
```

Then drag `src-tauri/target/release/bundle/macos/Markydowny.app` into your Applications folder. A `.dmg` is built next to it too.

### Make it the default for markdown

1. In Finder, select any `.md` file.
2. Choose **File > Get Info** (<kbd>⌘I</kbd>).
3. Under **Open with**, choose **Markydowny**, then click **Change All…**.

Repeat for `.markdown` (and `.mdown`, `.mkd` or `.mkdn`) if you use them.

## Linux

> **Coming soon.** Packaged Linux builds will be listed here.

The app already builds on Linux from source, for testing: run `scripts/build-desktop.sh` in a clone of the repository. It needs glibc 2.38 or newer (Debian 13, Ubuntu 24.04) and installs what it needs on Debian and Ubuntu. Documents open in separate windows rather than tabs.

## App stores

> **Coming soon.** Markydowny isn't in the Mac App Store or Microsoft Store yet. The store editions need sandboxing, which limits folder watching and the [Claude Code hook](claude-code.md#open-every-file-the-agent-edits), so they're a separate effort.
