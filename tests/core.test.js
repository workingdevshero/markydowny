const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

test('isMarkdownName recognizes markdown extensions case-insensitively', () => {
    assert.ok(core.isMarkdownName('README.md'));
    assert.ok(core.isMarkdownName('notes.MARKDOWN'));
    assert.ok(core.isMarkdownName('a.mkd'));
    assert.ok(!core.isMarkdownName('image.png'));
    assert.ok(!core.isMarkdownName('md'));
});

test('isTextFile accepts markdown, text MIME types, and untyped files', () => {
    assert.ok(core.isTextFile({ name: 'a.md', type: 'application/octet-stream' }));
    assert.ok(core.isTextFile({ name: 'a.txt', type: 'text/plain' }));
    assert.ok(core.isTextFile({ name: 'notes', type: '' }));
    assert.ok(!core.isTextFile({ name: 'photo.png', type: 'image/png' }));
});

test('dirname and basename split paths', () => {
    assert.equal(core.dirname('docs/guide/intro.md'), 'docs/guide/');
    assert.equal(core.dirname('intro.md'), '');
    assert.equal(core.dirname('/Users/me/a.md'), '/Users/me/');
    assert.equal(core.basename('/Users/me/a.md'), 'a.md');
    assert.equal(core.basename('a.md'), 'a.md');
});

test('isExternalUrl detects schemes and protocol-relative URLs', () => {
    for (const url of ['https://x.com/a.png', 'http://x', 'data:image/png;base64,AA', 'blob:abc', 'mailto:a@b.c', '//cdn.x/y.png', 'asset://localhost/a']) {
        assert.ok(core.isExternalUrl(url), url);
    }
    for (const url of ['img.png', './img.png', '../img.png', '/abs/img.png']) {
        assert.ok(!core.isExternalUrl(url), url);
    }
});

test('classifyLink sorts hrefs into anchor, external, and relative', () => {
    assert.equal(core.classifyLink('#install'), 'anchor');
    assert.equal(core.classifyLink(''), 'anchor');
    assert.equal(core.classifyLink(null), 'anchor');
    assert.equal(core.classifyLink('https://markydowny.com'), 'external');
    assert.equal(core.classifyLink('mailto:hi@example.com'), 'external');
    assert.equal(core.classifyLink('./other.md'), 'relative');
    assert.equal(core.classifyLink('docs/other.md#part'), 'relative');
});

test('resolveRelativePath handles folder-relative paths (web folder drop)', () => {
    assert.equal(core.resolveRelativePath('docs/', 'img/a.png'), 'docs/img/a.png');
    assert.equal(core.resolveRelativePath('docs/', './img/a.png'), 'docs/img/a.png');
    assert.equal(core.resolveRelativePath('docs/guide/', '../img/a.png'), 'docs/img/a.png');
    assert.equal(core.resolveRelativePath('docs/a/b/', '../../c.png'), 'docs/c.png');
    assert.equal(core.resolveRelativePath('', 'a.png'), 'a.png');
});

test('resolveRelativePath handles absolute base directories (desktop)', () => {
    assert.equal(core.resolveRelativePath('/Users/me/notes/', 'img/a.png'), '/Users/me/notes/img/a.png');
    assert.equal(core.resolveRelativePath('/Users/me/notes', '../pics/a.png'), '/Users/me/pics/a.png');
    assert.equal(core.resolveRelativePath('/Users/me/notes/', '/etc/hosts'), '/etc/hosts');
});

test('resolveRelativePath strips query/fragment and decodes escapes', () => {
    assert.equal(core.resolveRelativePath('docs/', 'my%20image.png?raw=1'), 'docs/my image.png');
    assert.equal(core.resolveRelativePath('docs/', 'other.md#section'), 'docs/other.md');
    assert.equal(core.resolveRelativePath('docs/', 'bad%zz.png'), 'docs/bad%zz.png');
});

test('resolveRelativePath returns null when escaping the root', () => {
    assert.equal(core.resolveRelativePath('docs/', '../../a.png'), null);
    assert.equal(core.resolveRelativePath('/', '../a.png'), null);
});

test('escapeHtml escapes markup characters', () => {
    assert.equal(core.escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});

test('slugify produces GitHub-style heading ids', () => {
    assert.equal(core.slugify('Hello, World!'), 'hello-world');
    assert.equal(core.slugify('  Getting Started  '), 'getting-started');
    assert.equal(core.slugify('API v2.0 (beta)'), 'api-v20-beta');
    assert.equal(core.slugify('snake_case & kebab-case'), 'snake_case--kebab-case');
    assert.equal(core.slugify('Café über'), 'café-über');
});

test('uniqueSlug de-duplicates repeated headings', () => {
    const used = new Set();
    assert.equal(core.uniqueSlug('Usage', used), 'usage');
    assert.equal(core.uniqueSlug('Usage', used), 'usage-1');
    assert.equal(core.uniqueSlug('Usage', used), 'usage-2');
    assert.equal(core.uniqueSlug('!!!', used), 'section');
});

// ---------------------------------------------------------------------------
// Live reload: scroll anchoring
// ---------------------------------------------------------------------------

// Three blocks: 0-100, 120-320, 340-400 (20px gaps).
const BLOCKS = [{ top: 0, height: 100 }, { top: 120, height: 200 }, { top: 340, height: 60 }];

test('captureScrollAnchor anchors to the first block reaching into the viewport', () => {
    assert.deepEqual(core.captureScrollAnchor(BLOCKS, 0), { index: 0, offset: 0 });
    assert.deepEqual(core.captureScrollAnchor(BLOCKS, 150), { index: 1, offset: 30 });
    // In the gap above block 1: anchored to it with a negative offset.
    assert.deepEqual(core.captureScrollAnchor(BLOCKS, 110), { index: 1, offset: -10 });
    // Past the end: the last block.
    assert.deepEqual(core.captureScrollAnchor(BLOCKS, 500), { index: 2, offset: 160 });
    assert.equal(core.captureScrollAnchor([], 10), null);
});

test('restoreScrollAnchor keeps the same text at the top after an edit above it', () => {
    const anchor = core.captureScrollAnchor(BLOCKS, 150);
    // The first paragraph grew by 80px: everything below moved down.
    const grown = [{ top: 0, height: 180 }, { top: 200, height: 200 }, { top: 420, height: 60 }];
    assert.equal(core.restoreScrollAnchor(anchor, grown), 230);
    // ...or shrank.
    const shrunk = [{ top: 0, height: 40 }, { top: 60, height: 200 }, { top: 280, height: 60 }];
    assert.equal(core.restoreScrollAnchor(anchor, shrunk), 90);
});

test('restoreScrollAnchor clamps to the block and to the document', () => {
    // The anchored block shrank below the offset.
    assert.equal(core.restoreScrollAnchor({ index: 1, offset: 150 }, [{ top: 0, height: 10 }, { top: 20, height: 50 }]), 70);
    // The anchored block is gone: fall back to the last one.
    assert.equal(core.restoreScrollAnchor({ index: 5, offset: 10 }, BLOCKS), 350);
    // Never above the page.
    assert.equal(core.restoreScrollAnchor({ index: 0, offset: -30 }, BLOCKS), 0);
    assert.equal(core.restoreScrollAnchor(null, BLOCKS), null);
    assert.equal(core.restoreScrollAnchor({ index: 0, offset: 0 }, []), null);
});

test('openAllLabel offers "Open all as tabs" for 2 to MAX_OPEN_ALL files', () => {
    assert.equal(core.openAllLabel(2), 'Open all 2 as tabs');
    assert.equal(core.openAllLabel(8), 'Open all 8 as tabs');
    assert.equal(core.openAllLabel(core.MAX_OPEN_ALL), `Open all ${core.MAX_OPEN_ALL} as tabs`);
    assert.equal(core.openAllLabel(core.MAX_OPEN_ALL + 1), null);
    assert.equal(core.openAllLabel(1), null);
    assert.equal(core.openAllLabel(0), null);
    assert.equal(core.openAllLabel(undefined), null);
});

test('tabStepForKey maps ⌃Tab and ⌃⇧Tab to tab switches', () => {
    const key = (props) => ({ key: 'Tab', ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...props });
    assert.equal(core.tabStepForKey(key({ ctrlKey: true })), 'next');
    assert.equal(core.tabStepForKey(key({ ctrlKey: true, shiftKey: true })), 'previous');
    assert.equal(core.tabStepForKey(key({})), null, 'plain Tab moves focus as usual');
    assert.equal(core.tabStepForKey(key({ shiftKey: true })), null);
    assert.equal(core.tabStepForKey(key({ ctrlKey: true, metaKey: true })), null);
    assert.equal(core.tabStepForKey(key({ ctrlKey: true, altKey: true })), null);
    assert.equal(core.tabStepForKey(key({ key: 'a', ctrlKey: true })), null);
    assert.equal(core.tabStepForKey(null), null);
});

test('relativePath links a file from a document\'s folder', () => {
    assert.equal(core.relativePath('/a/docs/', '/a/docs/shot.png'), 'shot.png');
    assert.equal(core.relativePath('/a/docs/', '/a/docs/img/shot.png'), 'img/shot.png');
    assert.equal(core.relativePath('/a/docs/', '/a/shot.png'), '../shot.png');
    assert.equal(core.relativePath('/a/docs/guide/', '/a/img/shot.png'), '../../img/shot.png');
    assert.equal(core.relativePath('/a/docs', '/b/shot.png'), '../../b/shot.png');
    assert.equal(core.relativePath('/', '/shot.png'), 'shot.png');
    // A folder named like the file isn't one it shares.
    assert.equal(core.relativePath('/a/shot.png/', '/a/shot.png'), '../shot.png');
    assert.equal(core.relativePath('docs/', 'docs/img/a.png'), 'img/a.png');
    assert.equal(core.relativePath('docs/', '/abs/a.png'), null);
    // It reads back as the file, the way the page resolves links.
    for (const [dir, file] of [['/a/docs/guide/', '/a/img/shot.png'], ['/a/docs/', '/a/docs/x/y.png'], ['/x/', '/y/z/w.png']]) {
        assert.equal(core.resolveRelativePath(dir, core.relativePath(dir, file)), file);
    }
});

test('mapScrollPosition keeps the split view\'s panes on the same block', () => {
    // Three blocks: the editor's are 100px apart, the rendering's 300px; then the ends.
    const editor = [0, 100, 200, 300];
    const preview = [50, 350, 650, 950];
    // At a block's top: the same block's top.
    assert.equal(core.mapScrollPosition(editor, preview, 100), 350);
    assert.equal(core.mapScrollPosition(preview, editor, 650), 200);
    // Partway through a block: as far through the other one.
    assert.equal(core.mapScrollPosition(editor, preview, 150), 500);
    assert.equal(core.mapScrollPosition(preview, editor, 425), 125);
    // Above the first block (the rendering's padding): scaled from the top.
    assert.equal(core.mapScrollPosition(preview, editor, 25), 0);
    assert.equal(core.mapScrollPosition([20, 40], [100, 200], 10), 50);
    // Past the end: one for one.
    assert.equal(core.mapScrollPosition(editor, preview, 320), 970);
    // Blocks with no height (a link definition renders nothing) don't divide by zero.
    assert.equal(core.mapScrollPosition([0, 100, 100, 200], [0, 50, 50, 100], 100), 50);
    assert.equal(core.mapScrollPosition([0, 100, 100, 200], [0, 50, 50, 100], 150), 75);
    assert.equal(core.mapScrollPosition([], [], 40), 40);
});

test('the scroll mapping uses block starts from the markdown, as the rendered view has them', () => {
    const text = '# Title\n\nPara one.\n\n- a\n- b\n\nEnd.\n';
    const raws = ['# Title', 'Para one.', '- a\n- b', 'End.'];
    assert.deepEqual(core.blockStarts(raws, text), [0, 9, 20, 29]);
    // CRLF files: offsets in the text as it is.
    assert.deepEqual(core.blockStarts(raws, text.replace(/\n/g, '\r\n')), [0, 11, 24, 36]);
});

test('editorView shows Split as Markdown where it isn\'t offered', () => {
    assert.equal(core.editorView('rich', true), 'rich');
    assert.equal(core.editorView('split', true), 'split');
    assert.equal(core.editorView('split', false), 'markdown');
    assert.equal(core.editorView('nonsense', true), 'rich');
});

test('nextEditorMode goes round Rich, Markdown and Split (⌘/)', () => {
    assert.equal(core.nextEditorMode('rich', true), 'markdown');
    assert.equal(core.nextEditorMode('markdown', true), 'split');
    assert.equal(core.nextEditorMode('split', true), 'rich');
    // At phone widths: Rich and Markdown only, Split counting as the Markdown it shows.
    assert.equal(core.nextEditorMode('markdown', false), 'rich');
    assert.equal(core.nextEditorMode('rich', false), 'markdown');
    assert.equal(core.nextEditorMode('split', false), 'rich');
});
