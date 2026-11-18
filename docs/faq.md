---
title: FAQ
nav: FAQ
order: 9
description: Answers to common questions about Markydowny, the markdown viewer for the web and macOS.
---

# FAQ

## Is Markydowny free?

Yes. The website and the Mac app are free, and the source is on [GitHub](https://github.com/workingdevshero/markydowny).

## Are my files uploaded anywhere?

No. Files are read on your device, in your browser or in the app, and never sent anywhere. There are no analytics. See [Privacy](privacy.md).

## Why don't my images show up?

On the web, drop the **folder** that holds the document, not just the file. A browser only lets the page read the files you give it, so a single file can't reach the images next to it. In the Mac app, relative images resolve from the file's location automatically. See [Relative images and links](index.md#relative-images-and-links).

## Why doesn't the page update when my file changes?

Live reload on the web needs a Chromium browser (Chrome, Edge, Brave, Arc, Opera…) and a file opened with **Choose File** or dropped on its own. Safari and Firefox read the file once, and a dropped folder is read once. The Mac app always live-reloads. See [Browser support](live-reload.md#browser-support).

## Why did the page stop scrolling to changes?

You scrolled, which pauses [Follow](live-reload.md#follow-and-resume) so the page doesn't jump away from what you're reading. Click **Resume**.

## Why does Save download a copy?

Your browser can't write files in place (Safari, Firefox), or the file came from a dropped folder. Open the file with **Choose File** in a Chromium browser, or use the Mac app, to save in place. See [Save](editor.md#save).

## Will saving reformat my markdown?

No. Only the text you changed is different; line endings, spacing and everything else stay as they were. See [Only your edits change](editor.md#only-your-edits-change).

## Which files can it open?

`.md` and `.markdown` files, plain `.txt` files and other text files. The Mac app registers as a viewer for `.md`, `.markdown`, `.mdown`, `.mkd` and `.mkdn`.

## Does it run scripts or HTML in my markdown?

HTML in a markdown file is rendered in both.

- **In the Mac app**, scripts never run: the app's Content Security Policy blocks both `<script>` elements and inline event handlers (`onclick=…`).
- **On the web**, `<script>` elements don't run, but inline event handlers in the file's HTML do, and its HTML can load remote resources. Only open files you trust there. See [Privacy](privacy.md#on-the-web).

## Is there a Windows or Linux app?

Not packaged yet. The app builds on Linux from source, and the website works in any browser on any system. See [Install](install.md).

## Why can't I find it in the Mac App Store?

The App Store requires sandboxing, which gets in the way of watching folders, opening any path you give it and the [Claude Code hook](claude-code.md). Downloads come first; store editions are planned separately.

## Where do I report a bug or ask for a feature?

Open an issue on [GitHub](https://github.com/workingdevshero/markydowny/issues), or ask on [Discord](https://discord.gg/UxNXrBukjZ).
