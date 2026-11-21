const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

/** Applies a textChange result to `text`. */
function apply(text, change) {
    return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}

test('textChange replaces only the span that differs', () => {
    assert.equal(core.textChange('same', 'same'), null);
    assert.deepEqual(core.textChange('# Title\n\nOld text.\n', '# Title\n\nNew text.\n'), { from: 9, to: 12, insert: 'New' });
    // Insertions and deletions are empty on one side.
    assert.deepEqual(core.textChange('ac', 'abc'), { from: 1, to: 1, insert: 'b' });
    assert.deepEqual(core.textChange('abc', 'ac'), { from: 1, to: 2, insert: '' });
    assert.deepEqual(core.textChange('', 'new'), { from: 0, to: 0, insert: 'new' });
    assert.deepEqual(core.textChange('old', ''), { from: 0, to: 3, insert: '' });
});

test('textChange never lets the prefix and suffix overlap', () => {
    // "aa" -> "aaa": the common prefix is "aa" and so is the suffix.
    assert.deepEqual(core.textChange('aa', 'aaa'), { from: 2, to: 2, insert: 'a' });
    assert.deepEqual(core.textChange('aaa', 'aa'), { from: 2, to: 3, insert: '' });
    for (const [a, b] of [['abab', 'ab'], ['ab', 'abab'], ['x\n\nx', 'x\n\n\nx'], ['', ''], ['a', 'b']]) {
        assert.equal(apply(a, core.textChange(a, b)), b, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
});

test('textChange keeps surrogate pairs whole', () => {
    // 😀 and 😃 share their high surrogate; 😀 and 🙀 share their low one.
    const change = core.textChange('a😀b', 'a😃b');
    assert.deepEqual(change, { from: 1, to: 3, insert: '😃' });
    const other = core.textChange('x😀', 'x🙀');
    assert.deepEqual(other, { from: 1, to: 3, insert: '🙀' });
});

test('textChange round-trips random edits', () => {
    let seed = 7;
    const random = (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
    };
    const alphabet = ['a', 'b', '\n', ' ', '#', '😀'];
    const word = (n) => Array.from({ length: n }, () => alphabet[random(alphabet.length)]).join('');
    for (let i = 0; i < 500; i++) {
        const a = word(random(12));
        const at = random(a.length + 1);
        const b = a.slice(0, at) + word(random(4)) + a.slice(Math.min(a.length, at + random(4)));
        const change = core.textChange(a, b);
        assert.equal(apply(a, change), b);
        if (change) {
            assert.ok(change.to - change.from <= a.length);
            assert.ok(change.insert.length <= b.length);
        }
    }
});

test('lineSeparator keeps CRLF files CRLF, and anything mixed as it is', () => {
    assert.equal(core.lineSeparator('a\nb\n'), '\n');
    assert.equal(core.lineSeparator('a\r\nb\r\n'), '\r\n');
    assert.equal(core.lineSeparator('a\r\nb\n'), '\n');
    assert.equal(core.lineSeparator('\na\r\n'), '\n');
    assert.equal(core.lineSeparator('one line'), '\n');
    assert.equal(core.lineSeparator(''), '\n');
});

test('editorShortcut: ⌘E, ⌘S and ⌘F on a Mac, Ctrl+E, Ctrl+S and Ctrl+F elsewhere', () => {
    const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    assert.equal(core.editorShortcut(key('e', { metaKey: true }), true), 'toggle');
    assert.equal(core.editorShortcut(key('s', { metaKey: true }), true), 'save');
    assert.equal(core.editorShortcut(key('E', { metaKey: true }), true), 'toggle', 'caps lock');
    // Ctrl+E is "end of line" on a Mac.
    assert.equal(core.editorShortcut(key('e', { ctrlKey: true }), true), null);
    assert.equal(core.editorShortcut(key('e', { ctrlKey: true }), false), 'toggle');
    assert.equal(core.editorShortcut(key('s', { ctrlKey: true }), false), 'save');
    assert.equal(core.editorShortcut(key('f', { metaKey: true }), true), 'find');
    assert.equal(core.editorShortcut(key('f', { ctrlKey: true }), false), 'find');
    assert.equal(core.editorShortcut(key('f', { ctrlKey: true }), true), null, 'Ctrl+F is "forward a character" on a Mac');
    assert.equal(core.editorShortcut(key('f', { metaKey: true, shiftKey: true }), true), null);
    assert.equal(core.editorShortcut(key('e', { metaKey: true }), false), null);
    assert.equal(core.editorShortcut(key('s', { metaKey: true, shiftKey: true }), true), null, 'Save As is not Save');
    assert.equal(core.editorShortcut(key('e', { metaKey: true, altKey: true }), true), null);
    assert.equal(core.editorShortcut(key('e'), true), null);
    assert.equal(core.editorShortcut(key('x', { metaKey: true }), true), null);
    // ⌘/ switches between Rich and Markdown; '/' is Shift+7 on a German keyboard.
    assert.equal(core.editorShortcut(key('/', { metaKey: true }), true), 'mode');
    assert.equal(core.editorShortcut(key('/', { metaKey: true, shiftKey: true }), true), 'mode');
    assert.equal(core.editorShortcut(key('/', { ctrlKey: true }), false), 'mode');
    assert.equal(core.editorShortcut(key('/', { ctrlKey: true }), true), null);
    assert.equal(core.editorShortcut(key('/', { metaKey: true, altKey: true }), true), null);
    assert.equal(core.editorShortcut(key('/'), true), null);
    assert.equal(core.editorShortcut(null, true), null);
});

test('blockIndexAt and blockOffset map between text offsets and rendered blocks', () => {
    const text = '# Title\n\nFirst para.\n\n- a\n- b\n\nLast.\n';
    // Raw block text as the renderer keeps it (trimmed at the end).
    const raws = ['# Title', 'First para.', '- a\n- b', 'Last.'];
    assert.equal(core.blockIndexAt(raws, text, 0), 0);
    assert.equal(core.blockIndexAt(raws, text, 3), 0);
    assert.equal(core.blockIndexAt(raws, text, text.indexOf('First') + 2), 1);
    assert.equal(core.blockIndexAt(raws, text, text.indexOf('- b')), 2);
    assert.equal(core.blockIndexAt(raws, text, text.length), 3);
    assert.equal(core.blockIndexAt([], text, 4), null);

    assert.equal(core.blockOffset(raws, text, 0), 0);
    assert.equal(core.blockOffset(raws, text, 2), text.indexOf('- a'));
    assert.equal(core.blockOffset(raws, text, 99), text.indexOf('Last.'));
    assert.equal(core.blockOffset(raws, text, null), 0);
    assert.equal(core.blockOffset([], text, 1), 0);

    // Repeated blocks are found in order, not all at the first copy.
    const twice = 'Same.\n\nSame.\n';
    assert.equal(core.blockIndexAt(['Same.', 'Same.'], twice, 8), 1);
    assert.equal(core.blockOffset(['Same.', 'Same.'], twice, 1), 7);
});

test('blockIndexAt and blockOffset find multi-line blocks in CRLF and CR text', () => {
    // The lexer hands back raws with '\n' line breaks whatever the file uses.
    const raws = ['# Title', '```\ncode\n```', '- a\n- b', 'Last.'];
    for (const eol of ['\r\n', '\r']) {
        const text = ['# Title', '', '```', 'code', '```', '', '- a', '- b', '', 'Last.', ''].join(eol);
        assert.equal(core.blockOffset(raws, text, 1), text.indexOf('```'));
        assert.equal(core.blockOffset(raws, text, 2), text.indexOf('- a'));
        assert.equal(core.blockOffset(raws, text, 3), text.indexOf('Last.'));
        assert.equal(core.blockIndexAt(raws, text, text.indexOf('code')), 1);
        assert.equal(core.blockIndexAt(raws, text, text.indexOf('- b')), 2);
        assert.equal(core.blockIndexAt(raws, text, text.indexOf('Last.') + 2), 3);
    }
});

// ------------------------------------------------------------------
// The unsaved-changes and conflict reducer
// ------------------------------------------------------------------

function run(events, state = null) {
    const applied = [];
    for (const event of events) {
        const result = core.editReducer(state, event);
        state = result.state;
        applied.push(result.apply);
    }
    return { state, applied };
}

test('editing marks unsaved changes, and undoing back to the file clears them', () => {
    const { state } = run([{ type: 'open', content: 'a' }]);
    assert.deepEqual(state, { base: 'a', dirty: false, conflict: null, restored: false, written: [] });
    assert.equal(run([{ type: 'edit', text: 'ab' }], state).state.dirty, true);
    assert.equal(run([{ type: 'edit', text: 'ab' }, { type: 'edit', text: 'a' }], state).state.dirty, false);
});

test('saving clears the mark, and the save coming back from the watch is not a reload', () => {
    const { state, applied } = run([
        { type: 'open', content: 'a' },
        { type: 'edit', text: 'ab' },
        { type: 'saved', content: 'ab', text: 'ab' },
        { type: 'disk', content: 'ab', text: 'ab' },
    ]);
    assert.equal(state.base, 'ab');
    assert.equal(state.dirty, false);
    assert.equal(state.conflict, null);
    assert.deepEqual(applied, [null, null, null, null]);
});

test('typing during a save keeps the new text unsaved', () => {
    const { state } = run([
        { type: 'open', content: 'a' },
        { type: 'edit', text: 'ab' },
        { type: 'saved', content: 'ab', text: 'abc' },
    ]);
    assert.equal(state.base, 'ab');
    assert.equal(state.dirty, true);
});

test('an earlier save reported after a later one is still recognised as ours', () => {
    const { state, applied } = run([
        { type: 'open', content: 'a' },
        { type: 'edit', text: 'ab' },
        { type: 'saved', content: 'ab', text: 'ab' },
        { type: 'edit', text: 'abc' },
        { type: 'saved', content: 'abc', text: 'abc' },
        { type: 'disk', content: 'ab', text: 'abc' },
    ]);
    assert.equal(state.base, 'abc');
    assert.equal(state.dirty, false);
    assert.equal(state.conflict, null);
    assert.equal(applied[5], null, 'the editor is not reverted to the older save');
});

test('a change on disk with nothing unsaved goes straight into the editor', () => {
    const { state, applied } = run([
        { type: 'open', content: 'a' },
        { type: 'disk', content: 'a2', text: 'a' },
    ]);
    assert.equal(applied[1], 'a2');
    assert.deepEqual(state, { base: 'a2', dirty: false, conflict: null, restored: false, written: [] });
});

test('a change on disk with unsaved changes asks: Reload takes the file', () => {
    const opened = run([
        { type: 'open', content: 'a' },
        { type: 'edit', text: 'mine' },
        { type: 'disk', content: 'theirs', text: 'mine' },
    ]);
    assert.equal(opened.state.conflict, 'theirs');
    assert.equal(opened.state.dirty, true);
    assert.equal(opened.state.base, 'a');
    assert.deepEqual(opened.applied, [null, null, null], 'nothing is overwritten until the reader chooses');

    const { state, applied } = run([{ type: 'reload' }], opened.state);
    assert.equal(applied[0], 'theirs');
    assert.deepEqual(state, { base: 'theirs', dirty: false, conflict: null, restored: false, written: [] });
});

test('Keep mine keeps the editor as it is, and the next save is checked against the new file', () => {
    const opened = run([
        { type: 'open', content: 'a' },
        { type: 'edit', text: 'mine' },
        { type: 'disk', content: 'theirs', text: 'mine' },
    ]);
    const { state, applied } = run([{ type: 'keepMine', text: 'mine' }], opened.state);
    assert.equal(applied[0], null);
    // The save that follows expects the file to hold "theirs", and overwrites it.
    assert.deepEqual(state, { base: 'theirs', dirty: true, conflict: null, restored: false, written: [] });
});

test('a later change on disk while the banner is up replaces what Reload would load', () => {
    const { state } = run([
        { type: 'open', content: 'a' },
        { type: 'edit', text: 'mine' },
        { type: 'disk', content: 'theirs', text: 'mine' },
        { type: 'disk', content: 'theirs 2', text: 'mine' },
    ]);
    assert.equal(state.conflict, 'theirs 2');
    // The file going back to what the editor started from settles it.
    assert.equal(run([{ type: 'disk', content: 'a', text: 'mine' }], state).state.conflict, null);
});

test('a refused save leads to the banner, never an overwrite', () => {
    const { state, applied } = run([
        { type: 'open', content: 'a' },
        { type: 'edit', text: 'mine' },
        { type: 'saveConflict', content: 'theirs', text: 'mine' },
    ]);
    assert.equal(state.conflict, 'theirs');
    assert.equal(state.dirty, true);
    assert.deepEqual(applied, [null, null, null]);
});

test('a change on disk that matches the editor settles everything', () => {
    const { state } = run([
        { type: 'open', content: 'a' },
        { type: 'edit', text: 'same' },
        { type: 'disk', content: 'same', text: 'same' },
    ]);
    assert.deepEqual(state, { base: 'same', dirty: false, conflict: null, restored: false, written: [] });
});

test('Revert restores the saved content, or the file as it is now after a conflict', () => {
    let result = run([
        { type: 'open', content: 'saved' },
        { type: 'edit', text: 'changed' },
        { type: 'revert' },
    ]);
    assert.equal(result.applied[2], 'saved');
    assert.equal(result.state.dirty, false);

    result = run([
        { type: 'open', content: 'saved' },
        { type: 'edit', text: 'changed' },
        { type: 'disk', content: 'theirs', text: 'changed' },
        { type: 'revert' },
    ]);
    assert.equal(result.applied[3], 'theirs');
    assert.deepEqual(result.state, { base: 'theirs', dirty: false, conflict: null, restored: false, written: [] });

    // Nothing to revert: the editor is left alone.
    result = run([{ type: 'open', content: 'saved' }, { type: 'revert' }]);
    assert.equal(result.applied[1], null);
});

test('Reload and Keep mine without a conflict change nothing', () => {
    const opened = run([{ type: 'open', content: 'a' }, { type: 'edit', text: 'b' }]).state;
    for (const event of [{ type: 'reload' }, { type: 'keepMine', text: 'b' }]) {
        const { state, applied } = run([event], opened);
        assert.deepEqual(state, opened);
        assert.deepEqual(applied, [null]);
    }
});

test('only a few recent saves are remembered', () => {
    let state = run([{ type: 'open', content: '0' }]).state;
    for (let i = 1; i <= 10; i++) {
        state = run([{ type: 'saved', content: String(i), text: String(i) }], state).state;
    }
    assert.deepEqual(state.written, ['7', '8', '9', '10']);
});

test('countWords counts plain prose', () => {
    assert.equal(core.countWords('The quick brown fox jumps over the lazy dog.'), 9);
    assert.equal(core.countWords('One,two three—four well-known it’s 3.14'), 5);
    assert.equal(core.countWords('First paragraph here.\n\nSecond one.\r\nThird line\rfourth'), 8);
});

test('countWords leaves out heading markers and emphasis', () => {
    assert.equal(core.countWords('# A title\n\n## Second level ##\n\nSetext\n======\n\n---'), 5);
    assert.equal(core.countWords('**bold** and *italic* and ***both*** and ~~gone~~ and __under__'), 9);
    assert.equal(core.countWords('a ** b * c _ d'), 4, 'stray markers are not words');
});

test('countWords leaves out list markers and task boxes', () => {
    assert.equal(core.countWords('- one\n* two\n+ three\n1. four\n2) five\n10. six'), 6);
    assert.equal(core.countWords('- [ ] buy milk\n- [x] walk the dog\n  - [X] nested'), 6);
    assert.equal(core.countWords('> quoted words\n> - in a list'), 5);
    assert.equal(core.countWords('In 2024 we shipped 3 things'), 6, 'numbers in prose still count');
});

test('countWords counts link text, not URLs', () => {
    assert.equal(core.countWords('See [the docs](https://example.com/docs "Docs title") now.'), 4);
    assert.equal(core.countWords('A [reference link][ref] and [another] [x][].\n\n[ref]: https://example.com "Title"'), 6);
    assert.equal(core.countWords('[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) done'), 2);
    assert.equal(core.countWords('[spaced](<a url with spaces.md>) here'), 2);
    assert.equal(core.countWords('Bare <https://example.com> autolink'), 3, 'an autolink shows its URL');
    assert.equal(core.countWords('Note[^1] here.\n\n[^1]: The footnote text.'), 5);
    assert.equal(core.countWords('[foo]: /url\n"title words here"\n\nSee [foo].'), 2, 'a title on the next line');
    assert.equal(core.countWords('[ref]: <my file.md> "Title words"\n\nSee [ref].'), 2, 'a <destination> with spaces');
});

test('countWords counts image alt text, not the path', () => {
    assert.equal(core.countWords('![A happy mascot](marky.png "Marky")'), 3);
    assert.equal(core.countWords('[![build status](https://ci/badge.svg)](https://ci/run)'), 2);
    assert.equal(core.countWords('![](empty-alt.png) text'), 1);
});

test('countWords counts inline code as written', () => {
    assert.equal(core.countWords('Run `npm test` now'), 4);
    assert.equal(core.countWords('Literal `[not](a link)` stays'), 4);
    assert.equal(core.countWords('``code with ` tick`` x'), 4);
});

test('countWords counts code but not fences or info strings', () => {
    assert.equal(core.countWords('Before\n\n```javascript title="a.js"\nconst answer = 42;\n```\n\nAfter'), 5);
    assert.equal(core.countWords('~~~python\nprint("hi")\n~~~'), 1);
    assert.equal(core.countWords('```\n[x](y) **z**\n````\nafter'), 3, 'markup inside code is code');
    assert.equal(core.countWords('- item\n  ```sh\n  ls -la\n  ```'), 3);
    assert.equal(core.countWords('```\nunclosed fence\nruns to the end'), 6);
    const link = '\n\nSee [docs](https://example.com "title words")';
    assert.equal(core.countWords('> ```\n> code\n> ```' + link), 3, 'a fence in a blockquote closes');
    assert.equal(core.countWords('- item\n    ```\n    code word\n    ```' + link), 5, 'an indented fence in a list closes');
    assert.equal(core.countWords('``` not a fence ``` x'), 4, 'backticks with a backtick after are inline code');
});

test('countWords counts table cells, not their borders', () => {
    const table = '| Name | Role |\n|:-----|-----:|\n| Ada Lovelace | Engineer |\n|Bob|Ops|';
    assert.equal(core.countWords(table), 7);
});

test('countWords counts each CJK character, and leaves out HTML tags and comments', () => {
    assert.equal(core.countWords('日本語のテキスト'), 8);
    assert.equal(core.countWords('你好，世界'), 4);
    assert.equal(core.countWords('Hello世界 world'), 4);
    assert.equal(core.countWords('한국어 단어 세 개'), 4, 'Korean spaces its words');
    assert.equal(core.countWords('<div align="center">Centered text</div> <!-- a hidden note -->'), 2);
    assert.equal(core.countWords('<img src="a.png" alt="x"> <br/>'), 0);
});

test('countWords of an empty document is 0', () => {
    assert.equal(core.countWords(''), 0);
    assert.equal(core.countWords('   \n\n\t'), 0);
    assert.equal(core.countWords(null), 0);
    assert.equal(core.countWords('---\n***\n- \n#'), 0);
});

test('formatWordCount reads "1,204 words" and "37 of 1,204 words"', () => {
    assert.equal(core.formatWordCount(1204), '1,204 words');
    assert.equal(core.formatWordCount(1204, 37), '37 of 1,204 words');
    assert.equal(core.formatWordCount(1), '1 word');
    assert.equal(core.formatWordCount(0), '0 words');
    assert.equal(core.formatWordCount(5, 0), '0 of 5 words');
    assert.equal(core.formatWordCount(1, 1), '1 of 1 word');
});

test('the editor\'s focus ring stands off the text, on the editor rather than the text itself', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
    const rule = selector => {
        const match = html.match(new RegExp(`\\n {8}${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
        assert.ok(match, `${selector} has a rule`);
        return match[1];
    };
    // The editor's scroller clips anything drawn outside the editable text, so its ring is off.
    assert.match(rule('.editor-host .cm-content:focus-visible'), /outline: none;/);
    const ring = rule('.editor-host .cm-editor.cm-focused');
    assert.match(ring, /outline: 2px solid var\(--accent\);/);
    const offset = Number(ring.match(/outline-offset: (\d+)px;/)[1]);
    assert.ok(offset >= 12 && offset <= 16, `${offset}px between the ring and the text`);
    assert.match(ring, /border-radius: \d+px;/);
    // The ring is drawn in the host's padding, so the narrowest padding has to hold it.
    let checked = 0;
    for (const [, selectors, body] of html.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selectors.split(',').some(selector => /\.editor-host(:not\(\[hidden\]\))?$/.test(selector.trim()))) continue;
        for (const [, padding] of body.matchAll(/\bpadding(?:-\w+)?: ([^;]+);/g)) {
            for (const px of padding.match(/\d+(?=px)/g)) {
                assert.ok(Number(px) >= offset + 2, `padding ${padding} holds a ${offset}px ring`);
                checked++;
            }
        }
    }
    assert.ok(checked >= 6, 'the web, fullscreen, phone, desktop and split paddings');
});

test('saveAction: a new document asks where to save it first, in the app and where the browser can', () => {
    const untitled = { kind: 'untitled', dir: '', title: core.UNTITLED_TITLE };
    assert.equal(core.saveAction(untitled, { isDesktop: true, savePicker: false }), 'saveAs');
    assert.equal(core.saveAction(untitled, { isDesktop: false, savePicker: true }), 'saveAs');
    // Safari and Firefox: Download, as the existing fallback.
    assert.equal(core.saveAction(untitled, { isDesktop: false, savePicker: false }), 'download');
    assert.equal(core.UNTITLED_FILE_NAME, 'Untitled.md');
});

test('saveAction: once saved, a document saves in place like any opened file', () => {
    const handle = { createWritable() {} };
    assert.equal(core.saveAction({ kind: 'desktop', path: '/a.md' }, { isDesktop: true, savePicker: false }), 'save');
    assert.equal(core.saveAction({ kind: 'file', handle }, { isDesktop: false, savePicker: true }), 'save');
    // A file without a writable handle (dropped in Safari, or from a folder) downloads.
    assert.equal(core.saveAction({ kind: 'file' }, { isDesktop: false, savePicker: true }), 'download');
    assert.equal(core.saveAction({ kind: 'folder' }, { isDesktop: false, savePicker: true }), 'download');
    assert.equal(core.saveAction(null, { isDesktop: false, savePicker: true }), 'download');
});
