// Renders the docs: each docs/<page>.md becomes docs/<page>/index.html (docs/index.md becomes
// docs/index.html), using the vendored marked and one shared page template. The output is
// committed, like js/vendor/, so GitHub Pages serves real HTML with no build step.
// Run after editing a page: npm run docs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Marked } = require('../js/vendor/marked.umd.js');

export const DOCS_DIR = join(root, 'docs');
export const SITE = 'https://markydowny.com';

/** The URL path a page is served at: /docs/ for index, /docs/<slug>/ otherwise. */
export function pageUrl(slug) {
    return slug === 'index' ? '/docs/' : `/docs/${slug}/`;
}

/** The output file for a page, relative to the repository root. */
export function outputPath(slug) {
    return slug === 'index' ? 'docs/index.html' : `docs/${slug}/index.html`;
}

/**
 * Splits a page into its front matter (`key: value` lines between `---` fences) and body.
 * Every page needs a title and a description; `nav` (the side navigation's label) and
 * `order` (its position) are optional.
 */
export function parsePage(source, slug) {
    const match = source.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) throw new Error(`docs/${slug}.md: missing front matter`);
    const meta = {};
    for (const line of match[1].split('\n')) {
        if (!line.trim()) continue;
        const pair = line.match(/^(\w+):\s*(.*)$/);
        if (!pair) throw new Error(`docs/${slug}.md: bad front matter line "${line}"`);
        meta[pair[1]] = pair[2].trim();
    }
    for (const key of ['title', 'description']) {
        if (!meta[key]) throw new Error(`docs/${slug}.md: front matter needs a ${key}`);
    }
    return {
        slug,
        title: meta.title,
        description: meta.description,
        nav: meta.nav || meta.title,
        order: Number(meta.order || 0),
        body: match[2],
    };
}

/** All pages in docs/, in navigation order. */
export function loadPages(dir = DOCS_DIR) {
    return readdirSync(dir)
        .filter(name => name.endsWith('.md'))
        .map(name => parsePage(readFileSync(join(dir, name), 'utf8'), name.slice(0, -3)))
        .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** A heading's anchor: its text, lowercased, with runs of anything else turned into dashes. */
export function slugify(text) {
    return text
        .replace(/<[^>]*>/g, '')
        .replace(/&[a-z]+;|&#\d+;/gi, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Where a link in a page's markdown goes once rendered: `other.md#part` to /docs/other/#part,
 * `media/x.png` to /docs/media/x.png. Anything else (external, anchors, absolute) is unchanged.
 */
export function rewriteHref(href) {
    if (!href || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return href;
    const page = href.match(/^(?:\.\/)?([\w-]+)\.md(#.*)?$/);
    if (page) return pageUrl(page[1]) + (page[2] || '');
    return `/docs/${href.replace(/^\.\//, '')}`;
}

/** The page's markdown as HTML, with anchored headings and links rewritten for the site. */
export function renderBody(markdown) {
    const used = new Map();
    const marked = new Marked({
        gfm: true,
        walkTokens(token) {
            if (token.type === 'link' || token.type === 'image') token.href = rewriteHref(token.href);
        },
        renderer: {
            heading({ tokens, depth }) {
                const inner = this.parser.parseInline(tokens);
                const base = slugify(inner) || 'section';
                const seen = used.get(base) || 0;
                used.set(base, seen + 1);
                const id = seen ? `${base}-${seen}` : base;
                if (depth === 1) return `<h1 id="${id}">${inner}</h1>\n`;
                return `<h${depth} id="${id}"><a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${depth}>\n`;
            },
        },
    });
    return marked.parse(markdown);
}

const FOOTER_LINKS = [
    ['https://workingdevshero.com', 'Website', '/web.svg'],
    ['https://discord.gg/UxNXrBukjZ', 'Discord', '/discord.svg'],
    ['https://github.com/workingdevshero', 'GitHub', '/github.svg'],
    ['https://x.com/workingdevshero', 'X', '/x.svg'],
];

/** One page of the docs, as a complete HTML document. */
export function renderPage(page, pages) {
    const url = SITE + pageUrl(page.slug);
    const title = page.slug === 'index'
        ? 'Markydowny docs'
        : `${page.title} · Markydowny docs`;
    const nav = pages.map(p => {
        const current = p.slug === page.slug ? ' aria-current="page"' : '';
        return `                <li><a href="${pageUrl(p.slug)}"${current}>${escapeHtml(p.nav)}</a></li>`;
    }).join('\n');
    const footer = FOOTER_LINKS.map(([href, name, icon]) => `                <a href="${href}" target="_blank" rel="noopener noreferrer" title="${name}">
                    <img src="${icon}" alt="${name}" class="footer-icon" />
                </a>`).join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Generated from docs/${page.slug}.md by scripts/build-docs.mjs. Edit the markdown, then run npm run docs. -->
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(page.description)}">
    <link rel="canonical" href="${url}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${url}">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(page.description)}">
    <meta property="og:image" content="${SITE}/og-image.png">
    <meta property="og:site_name" content="Markydowny">
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="apple-touch-icon" href="/marky.png">
    <link rel="stylesheet" href="/docs/docs.css">
</head>
<body>
    <a class="skip-link" href="#content">Skip to content</a>
    <header class="topbar">
        <a class="brand" href="/">
            <img src="/marky.png" alt="" class="brand-mark" />
            <span>Markydowny</span>
        </a>
        <nav class="topbar-nav" aria-label="Site">
            <a class="current-section" href="/docs/"${page.slug === 'index' ? ' aria-current="page"' : ''}>Docs</a>
            <a href="/docs/install/"${page.slug === 'install' ? ' aria-current="page"' : ''}>Download</a>
            <a class="btn btn-primary" href="/">Open a file</a>
        </nav>
    </header>
    <div class="docs-layout">
        <nav class="docs-nav" aria-label="Documentation">
            <ul>
${nav}
            </ul>
        </nav>
        <main class="docs-content" id="content">
${renderBody(page.body).trimEnd()}
        </main>
    </div>
    <footer class="footer">
        <div class="footer-credit">
            Made by <a href="https://workingdevshero.com" target="_blank" rel="noopener noreferrer">Working Devs Hero</a>
        </div>
        <div class="footer-links">
${footer}
        </div>
    </footer>
</body>
</html>
`;
}

/** Every output file (path relative to the repository root -> HTML), without writing any. */
export function buildDocs(dir = DOCS_DIR) {
    const pages = loadPages(dir);
    return new Map(pages.map(page => [outputPath(page.slug), renderPage(page, pages)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outputs = buildDocs();
    for (const [path, html] of outputs) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), html);
    }
    console.log(`Built ${outputs.size} docs pages`);
}
