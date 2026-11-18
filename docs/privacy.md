---
title: Privacy
nav: Privacy
order: 8
description: Markydowny never uploads your files. Documents are read on your device, and there are no analytics, accounts or network requests.
---

# Privacy

**Your files never leave your device.** Markydowny has no server to send them to.

## On the web

- The page reads the files you choose or drop **in your browser**. Nothing is uploaded: there's no backend at all, just static files served by GitHub Pages.
- There are **no analytics**, no cookies, no tracking pixels, no web fonts and no third-party scripts. Once the page has loaded it makes no network requests of its own, so it works offline.
- The one exception is a document's own content: an image in your markdown with a web address (`![](https://…)`) is loaded from that address, as in any markdown viewer.
- Live reload and saving use your browser's File System Access API. The browser asks you before the page can write a file, and the permission only covers the file you opened.
- The page remembers one setting on your device: whether [Follow](live-reload.md#follow-and-resume) is on.

GitHub Pages, which hosts the site, keeps standard web server logs (such as your IP address) when you load the page. That's the only party involved.

## In the Mac app

- The app reads and writes files **on your Mac** and nowhere else. Apart from crash reports (below), it makes no network requests of its own: no analytics, no update checks, no accounts. As on the web, images a document links to by web address are loaded from there.
- A window may only write the document it shows, and only when you save.
- Scripts embedded in a markdown file never run: the app has a strict Content Security Policy.
- Links to websites open in your browser, not in the app. A link to any other kind of local file is shown in Finder rather than opened, so a document can't trick a click into running a program.

### Crash reports

Builds of the app can include crash reporting through [BugSplat](https://www.bugsplat.com), so crashes can be found and fixed. When the app crashes, a dialog appears before a report is sent; the report holds a minidump (the state of the app at the moment it crashed), not your documents. JavaScript errors in a window are reported too.

Builds made from source without `BUGSPLAT_DATABASE` set have crash reporting turned off.
