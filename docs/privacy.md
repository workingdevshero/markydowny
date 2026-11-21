---
title: Privacy
nav: Privacy
order: 8
description: Markydowny never uploads your files. Documents are read on your device, and there are no analytics, accounts or tracking.
---

# Privacy

**Your files never leave your device.** Markydowny has no server to send them to.

## On the web

- The page reads the files you choose or drop **in your browser**. Nothing is uploaded: there's no backend at all, just static files served by GitHub Pages.
- There are **no analytics**, no cookies, no tracking pixels, no web fonts and no third-party scripts. Once the page has loaded it makes no network requests of its own, so it works offline.
- The exception is a document's own content. The common case is an image in your markdown with a web address (`![](https://…)`), which is loaded from that address, as in any markdown viewer. Raw HTML in the file is rendered too, so it can also load remote resources (HTML images, frames, video) and its inline event handlers (`onerror=…`) run. `<script>` elements in the file don't run. Only open files you trust, or use the Mac app.
- Live reload and saving use your browser's File System Access API. The browser asks you before the page can write a file, and the permission only covers the file you opened.
- The page remembers one setting on your device: whether [Follow](live-reload.md#follow-and-resume) is on.
- While you edit, the page keeps a backup of any document with unsaved changes in your browser's storage for this site (IndexedDB), so you can [restore it](editor.md#unsaved-work-is-kept) after closing the tab. It stays on your device, and goes once you save or discard the changes.

GitHub Pages, which hosts the site, keeps standard web server logs (such as your IP address) when you load the page. That's the only party involved.

## In the Mac app

- The app reads and writes files **on your Mac** and nowhere else. Apart from crash reports (below), it makes no network requests of its own: no analytics, no update checks, no accounts. As on the web, images a document links to by web address are loaded from there. The app's Content Security Policy blocks everything else a document could load or run: scripts, inline event handlers, frames and media.
- A window may only write the document it shows, and only when you save.
- Unsaved changes are kept in a `backups` folder of the app's own (in `~/Library/Application Support/com.workingdevshero.markydowny`), readable by your account only, so they [come back after a quit or crash](editor.md#unsaved-work-is-kept). A backup goes once you save or discard the changes.
- Scripts embedded in a markdown file never run: the app has a strict Content Security Policy.
- Links to websites open in your browser, not in the app. A link to any other kind of local file is shown in Finder rather than opened, so a document can't trick a click into running a program.

### Crash reports

Builds of the app can include crash reporting through [BugSplat](https://www.bugsplat.com), so crashes can be found and fixed. When the app crashes, a dialog appears before a report is sent; the report holds a minidump (the state of the app at the moment it crashed), not your documents. JavaScript errors in a window are reported too.

Builds made from source without `BUGSPLAT_DATABASE` set have crash reporting turned off.
