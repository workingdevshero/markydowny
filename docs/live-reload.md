---
title: Live reload & Follow
nav: Live reload & Follow
order: 2
description: Markydowny re-renders a markdown file when it changes on disk, highlights what changed, and with Follow keeps the latest change in view.
---

# Live reload & Follow

Leave a document open while something else edits it (another editor, a script, an AI agent) and Markydowny re-renders it as it changes, highlights what changed, and can keep the latest change in view.

## What reloads

- **In the Mac app**, every open document. The window checks the file and re-renders it within about a second of a change, keeping your scroll position.
- **On the web**, a file opened with **Choose File** or dropped on the page, in a browser that supports it (see [Browser support](#browser-support)).
- A folder dropped on the web page is read once. In the app, a folder you choose to watch follows every change inside it: see [Watch this folder](claude-code.md#watch-this-folder).

While a document is live, the header shows **Follow** and, after the first change, when it last updated (*Updated just now*, *Updated 2 min ago*). Hover over it for the exact time.

On the web, a tab in the background stops checking, and catches up as soon as you switch back to it.

## Change highlights

After a reload, the blocks that changed (a paragraph, a list item, a code block, a table) light up and fade over a couple of seconds. Where something was removed, a thin line marks the spot.

If your system asks for reduced motion, the highlight doesn't fade: it stays still for a few seconds and then disappears.

## Follow and Resume

**Follow** keeps the latest change in view: each time the file changes, the page scrolls to the first block that changed.

- Click **Follow** to turn it on; the button then reads **Following**. Click it again to turn it off.
- Scroll yourself, with the mouse, trackpad, scroll bar or keys, and Follow pauses so it doesn't pull the page away from what you're reading. The button reads **Resume**.
- Click **Resume** to jump to the latest change and carry on following.

Follow is on by default, and Markydowny remembers whether you left it on or off.

## When the file goes missing

If the file is deleted or moved while it's open, Markydowny keeps showing the last version and says *This file was deleted or moved*. Many editors and agents save by replacing the file, so it often comes straight back: when it does, the notice goes away and the document reloads.

## Browser support

| Where | Live reload |
| --- | --- |
| Mac app | Always |
| Chrome, Edge, Brave, Arc, Opera and other Chromium browsers | Files opened with **Choose File** or dropped on the page |
| Safari | Reads the file once |
| Firefox | Reads the file once |

Live reload on the web needs the File System Access API, which only Chromium browsers have. Safari and Firefox show the file as it was when you opened it: open it again to see changes.

Some Chromium versions also tell the page the moment a file changes; the rest check about once a second. Either way you don't need to do anything.

## See also

- [Watching Claude Code](claude-code.md): leave a doc open while an agent edits it.
- [Editor](editor.md#changed-on-disk): what happens when the file changes while you're editing it.
