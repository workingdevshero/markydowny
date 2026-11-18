---
title: Tabs & windows
nav: Tabs & windows
order: 5
description: Markydowny for macOS opens documents as native tabs. Open several files at once, merge and drag tabs between windows, and keep the app open with no windows.
---

# Tabs & windows

*Mac app.* Markydowny uses macOS's own window tabs, the same ones as Finder and Safari, so they look and behave the way you expect.

## Every document gets a tab

- Opening several files at once (selecting them in Finder, **File > Open…**, or dropping them) opens each in its own tab, in order.
- A link from one markdown file to another opens the linked file in a new tab.
- Opening a file that's already open brings its tab to the front instead of opening it twice.
- An empty window (one showing the drop zone) is used first, before any new tab.

The tab's title is the document's name. Files that share a name are told apart by their folders, as in *README.md — docs* and *README.md — src*. A dot (•) in front means it has unsaved changes.

## New Tab

**File > New Tab** (<kbd>⌘T</kbd>), or the **+** at the end of the tab bar, opens an empty tab with a drop zone. Drop a file or folder into it, or use **File > Open…** (<kbd>⌘O</kbd>).

## Open all as tabs

Drop a folder with several markdown files, and the list of files offers **Open all *N* as tabs**, where *N* is the number of files: each file opens in a tab of its own. The button isn't shown for folders with more than 50 markdown files.

## Switching tabs

- <kbd>⌃Tab</kbd> and <kbd>⌃⇧Tab</kbd>: next and previous tab.
- <kbd>⌘⇧]</kbd> and <kbd>⌘⇧[</kbd>: **Window > Show Next Tab** and **Show Previous Tab**.
- Or click the tab.

## Merging and dragging tabs

- Drag a tab out of the tab bar to give it its own window, or use **Window > Move Tab to New Window**.
- Drag a tab onto another window's tab bar to move it there.
- **Window > Merge All Windows** gathers every window into tabs of one window.

## Closing

**File > Close Window** (<kbd>⌘W</kbd>) closes the current tab. If it has unsaved changes, Markydowny asks first.

Like other Mac document apps, Markydowny stays open after its last window closes. Its Dock icon stays, and **File > Open…**, dropping a file on the Dock icon, or double-clicking a file in Finder opens a new window. Quit with <kbd>⌘Q</kbd>.

## On Linux

The app also builds for Linux, without macOS-only parts: documents open in separate windows rather than tabs, and the app quits when its last window closes.
