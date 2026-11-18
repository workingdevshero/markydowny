---
title: Editor
nav: Editor
order: 4
description: Edit the markdown source in Markydowny, save it in place with ⌘S, revert, and handle changes made on disk while you edit.
---

# Editor

Markydowny is a viewer first, with an editor for the moment you spot a typo. The editor shows the markdown source; saving writes it back to the file.

## Edit and Done

Click **Edit** in the header, or press <kbd>⌘E</kbd> (<kbd>Ctrl+E</kbd> on Windows and Linux), to switch from the rendered document to its source. The editor opens at the part of the document you were reading.

Click **Done**, or press <kbd>⌘E</kbd> again, to go back to the rendered view, near where your cursor was. If you have unsaved changes, Markydowny asks before discarding them.

## Save

Press <kbd>⌘S</kbd> (<kbd>Ctrl+S</kbd>) or click **Save**. Save is only enabled while there's something to save.

Where the file goes depends on how you opened it:

| Opened in | Save |
| --- | --- |
| The Mac app | Writes the file in place |
| Chrome, Edge and other Chromium browsers, with **Choose File** or by dropping the file | Writes the file in place, after the browser asks once for permission |
| Safari, Firefox, or any file from a dropped folder | **Download** saves a copy under the same name, usually to your Downloads folder |

When saving in place isn't possible the button reads **Download** instead of **Save**, so you know before you click.

## Only your edits change

Saving changes only the text you edited. Everything else in the file, down to the byte, stays as it was:

- line endings, Windows (`\r\n`) or Unix (`\n`), are kept as the file has them,
- nothing is reformatted: list markers, indentation, trailing spaces and blank lines are untouched, and
- the file's permissions are kept.

That keeps diffs small and means saving never fights a formatter or another tool. In the Mac app, the new text is written to a temporary file and moved over the original, so a crash mid-save never leaves half a file.

## Revert

**Revert** throws away your unsaved changes and puts the editor back to the last saved text.

## Unsaved changes

While you have unsaved changes, the document's title starts with a dot (•). Markydowny asks before anything would throw them away: **Done**, **Open another**, dropping another file, or closing the window or tab.

## Changed on disk

Markydowny keeps watching the file while you edit (in the app, and in Chromium browsers; see [Live reload](live-reload.md#browser-support)).

- **With no unsaved changes**, a change on disk is applied to the editor as it happens. Your cursor stays where it is.
- **With unsaved changes**, a banner says *This file changed on disk* and offers:
  - **Reload**: discard your changes and load the file as it is now.
  - **Keep mine**: carry on editing. The next save overwrites the file with your version.

Saving checks the file first, too. If it changed since you started editing, the save stops and the banner appears instead, so a change made elsewhere is never overwritten without your say.

## Rich mode

> **Coming soon.** Rich mode will let you edit the rendered document directly, with a switch between Rich and Markdown. This section will describe it once it ships.

![Placeholder: Rich mode](media/rich-mode-placeholder.svg)

## Formatting toolbar

> **Coming soon.** A toolbar and shortcuts for bold, italics, headings, lists, links and code. This section will describe them once they ship.

![Placeholder: formatting toolbar](media/toolbar-placeholder.svg)
