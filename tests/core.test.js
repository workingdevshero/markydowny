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
