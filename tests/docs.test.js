const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const docsDir = path.join(root, 'docs');
const load = () => import('../scripts/build-docs.mjs');

/** A docs folder holding `pages` (name -> markdown), in a temporary directory. */
function sampleDocs(pages) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markydowny-docs-'));
    for (const [name, text] of Object.entries(pages)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
}

const SAMPLE = {
    'index.md': '---\ntitle: Getting started\norder: 1\ndescription: Start here.\n---\n\n# Getting started\n\nSee [Follow](live.md#follow-mode) and [the site](https://markydowny.com).\n',
    'live.md': '---\ntitle: Live reload & Follow\nnav: Live\norder: 2\ndescription: Reloads <fast> & "follows".\n---\n\n# Live reload\n\n## Follow mode\n\n## Follow mode\n\n### `⌘E` *edits*\n\n![shot](media/shot.png)\n',
};

test('a sample page renders its title, description, canonical URL, nav and heading anchors', async () => {
    const { buildDocs } = await load();
    const outputs = buildDocs(sampleDocs(SAMPLE));
    assert.deepEqual([...outputs.keys()], ['docs/index.html', 'docs/live/index.html']);
    const html = outputs.get('docs/live/index.html');

    assert.match(html, /<title>Live reload &amp; Follow · Markydowny docs<\/title>/);
    assert.match(html, /<meta name="description" content="Reloads &lt;fast&gt; &amp; &quot;follows&quot;.">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/markydowny.com\/docs\/live\/">/);
    // The side navigation lists every page in order, by its nav label, marking this one.
    assert.match(html, /<li><a href="\/docs\/">Getting started<\/a><\/li>\s*<li><a href="\/docs\/live\/" aria-current="page">Live<\/a><\/li>/);
    // The header: logo home, Docs, Download and Open a file.
    assert.match(html, /<a class="brand" href="\/">/);
    assert.match(html, /<a href="\/docs\/install\/">Download<\/a>/);
    // Only the page a header link points at is marked current.
    assert.match(html, /<a class="current-section" href="\/docs\/">Docs<\/a>/);
    assert.match(outputs.get('docs/index.html'), /<a class="current-section" href="\/docs\/" aria-current="page">Docs<\/a>/);
    assert.match(html, /<a class="btn btn-primary" href="\/">Open a file<\/a>/);

    assert.match(html, /<h1 id="live-reload">Live reload<\/h1>/);
    // Repeated headings get distinct anchors; markup is left out of the anchor.
    assert.match(html, /<h2 id="follow-mode"><a class="heading-anchor" href="#follow-mode"/);
    assert.match(html, /<h2 id="follow-mode-1"><a class="heading-anchor" href="#follow-mode-1"/);
    assert.match(html, /<h3 id="e-edits">.*<code>⌘E<\/code> <em>edits<\/em><\/h3>/);
    assert.match(html, /<img src="\/docs\/media\/shot.png" alt="shot">/);

    const index = outputs.get('docs/index.html');
    assert.match(index, /<title>Markydowny docs<\/title>/);
    assert.match(index, /<link rel="canonical" href="https:\/\/markydowny.com\/docs\/">/);
    assert.match(index, /<a href="\/docs\/live\/#follow-mode">Follow<\/a>/);
    assert.match(index, /<a href="https:\/\/markydowny.com">the site<\/a>/);
});

test('rendering is deterministic', async () => {
    const { buildDocs } = await load();
    const first = buildDocs();
    const second = buildDocs();
    assert.deepEqual([...second.entries()], [...first.entries()]);
});

test('a page without a title or description is refused', async () => {
    const { buildDocs } = await load();
    assert.throws(() => buildDocs(sampleDocs({ 'a.md': '# No front matter\n' })), /missing front matter/);
    assert.throws(() => buildDocs(sampleDocs({ 'a.md': '---\ntitle: A\n---\n# A\n' })), /needs a description/);
});

test('rewriteHref points markdown links and media at the published pages', async () => {
    const { rewriteHref } = await load();
    assert.equal(rewriteHref('editor.md'), '/docs/editor/');
    assert.equal(rewriteHref('./editor.md#save'), '/docs/editor/#save');
    assert.equal(rewriteHref('index.md#folders'), '/docs/#folders');
    assert.equal(rewriteHref('media/a.png'), '/docs/media/a.png');
    for (const href of ['#top', '/', 'https://x.com/a.md', 'mailto:a@b.c']) {
        assert.equal(rewriteHref(href), href);
    }
});

/** Every committed docs page, relative to the repository root. */
function committedPages(dir = docsDir, rel = 'docs') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) return committedPages(path.join(dir, entry.name), child);
        return entry.name.endsWith('.html') ? [child] : [];
    });
}

test('every docs/*.md has committed, up-to-date HTML (run npm run docs)', async () => {
    const { buildDocs } = await load();
    const outputs = buildDocs();
    assert.ok(outputs.size >= 9, 'expected a page per feature');
    for (const [file, html] of outputs) {
        const target = path.join(root, file);
        assert.ok(fs.existsSync(target), `${file} is missing: run npm run docs`);
        assert.ok(fs.readFileSync(target, 'utf8') === html, `${file} is stale: run npm run docs`);
    }
    // And no page is left over from a markdown file that was removed or renamed.
    assert.deepEqual(committedPages().sort(), [...outputs.keys()].sort());
});

/** The file a site path is served from, or null if there's none. */
function servedFile(urlPath) {
    const file = path.join(root, decodeURIComponent(urlPath), urlPath.endsWith('/') ? 'index.html' : '');
    return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

test('every internal link and image in the docs points at something that exists', async () => {
    const { buildDocs } = await load();
    let checked = 0;
    for (const [file, html] of buildDocs()) {
        const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map(m => m[1]);
        for (const ref of refs) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue; // external
            assert.ok(ref.startsWith('/') || ref.startsWith('#'), `${file}: link "${ref}" should be site-absolute`);
            const [urlPath, hash] = ref.split('#');
            const target = urlPath ? servedFile(urlPath) : path.join(root, file);
            assert.ok(target, `${file}: "${ref}" doesn't exist`);
            if (hash && target.endsWith('.html')) {
                assert.ok(ids(fs.readFileSync(target, 'utf8')).has(hash), `${file}: "${ref}" has no #${hash}`);
            }
            checked++;
        }
    }
    assert.ok(checked > 50, 'expected the docs to link to each other');
});

test('the sitemap lists every docs page', async () => {
    const { buildDocs, SITE } = await load();
    const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
    for (const file of buildDocs().keys()) {
        const url = SITE + '/' + file.replace(/index\.html$/, '');
        assert.ok(sitemap.includes(`<loc>${url}</loc>`), `sitemap.xml has no ${url}`);
    }
});

test("Jekyll (GitHub Pages) doesn't render the docs' markdown sources a second time", () => {
    const config = fs.readFileSync(path.join(root, '_config.yml'), 'utf8');
    assert.match(config, /^exclude:\n(\s+- .*\n)*\s+- docs\/\*\.md$/m);
});
