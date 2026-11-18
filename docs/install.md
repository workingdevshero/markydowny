---
title: Download
nav: Download
order: 6
description: Download Markydowny for macOS (signed and notarized) or Linux, make it the default app for markdown files, or use it on the web with nothing to install.
---

# Download

## Mac app

**[⬇ Download Markydowny for Mac](https://github.com/workingdevshero/markydowny/releases/latest/download/Markydowny-mac.dmg)**

For Apple silicon and Intel Macs, macOS 12 or later. It's signed and notarized by Apple, so it opens like any other app.

1. Open `Markydowny-mac.dmg` and drag **Markydowny** to **Applications**.
2. Open Markydowny from Applications, or double-click any `.md` file once it's the default (below).

### Make it the default for markdown

1. In Finder, select any `.md` file.
2. Choose **File > Get Info** (<kbd>⌘I</kbd>).
3. Under **Open with**, choose **Markydowny**, then click **Change All…**.

Repeat for `.markdown` (and `.mdown`, `.mkd` or `.mkdn`) if you use them.

## Linux

| Package | x86_64 | arm64 |
|---|---|---|
| `.deb` for Debian and Ubuntu | [Download](https://github.com/workingdevshero/markydowny/releases/latest/download/markydowny-linux-x86_64.deb) | [Download](https://github.com/workingdevshero/markydowny/releases/latest/download/markydowny-linux-arm64.deb) |
| `.AppImage` for other distributions | [Download](https://github.com/workingdevshero/markydowny/releases/latest/download/Markydowny-linux-x86_64.AppImage) | [Download](https://github.com/workingdevshero/markydowny/releases/latest/download/Markydowny-linux-arm64.AppImage) |

They need glibc 2.38 or newer: Ubuntu 24.04, Debian 13, Fedora 39 and later.

- **`.deb`:** `sudo apt install ./markydowny-linux-x86_64.deb`, or the arm64 file. Markydowny then appears with your other apps.
- **`.AppImage`:** `chmod +x Markydowny-linux-x86_64.AppImage`, then run it.

Documents open in separate windows rather than tabs.

## Windows

> **Coming soon.** A Windows installer is on its way in the next release.

## On the web

Nothing to install: open [markydowny.com](https://markydowny.com) in any modern browser. Once it has loaded it works offline. For live reload and saving in place, use Chrome, Edge or another Chromium browser (see [Browser support](live-reload.md#browser-support)).

## Checksums and older versions

Every release lists a SHA-256 checksum for each file in `SHA256SUMS.txt`, and the [releases page](https://github.com/workingdevshero/markydowny/releases) has every version and its notes. The links above always download the latest release.

## Build from source

You need macOS 12 or later, [Node](https://nodejs.org) 18 or later, the Xcode command line tools (`xcode-select --install`), and CMake and Ninja (`brew install cmake ninja`). Rust installs itself through [rustup](https://rustup.rs) at the version the project pins.

```bash
git clone https://github.com/workingdevshero/markydowny.git
cd markydowny
npm install
npm run build
```

Then drag `src-tauri/target/release/bundle/macos/Markydowny.app` into your Applications folder. A `.dmg` is built next to it too.

On Linux, run `scripts/build-desktop.sh` in a clone of the repository instead. It installs what it needs on Debian and Ubuntu.

## App stores

> **Coming soon.** Markydowny isn't in the Mac App Store or Microsoft Store yet. The store editions need sandboxing, which limits folder watching and the [Claude Code hook](claude-code.md#open-every-file-the-agent-edits), so they're a separate effort.
