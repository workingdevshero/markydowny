/**
 * Markydowny core helpers.
 *
 * Pure functions shared by the web app and the desktop (Tauri) app. Written as
 * a classic script so index.html keeps working when opened via file://, and
 * exported for Node so the logic can be unit tested.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.MarkyCore = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'];

    function isMarkdownName(name) {
        const lower = String(name).toLowerCase();
        return MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext));
    }

    /** Accepts markdown, plain text, or anything the OS didn't tag with a MIME type. */
    function isTextFile(file) {
        const type = file.type || '';
        return isMarkdownName(file.name) || type === '' || type.startsWith('text/');
    }

    /** Directory portion of a path, including the trailing slash ('' if none). */
    function dirname(path) {
        return path.substring(0, path.lastIndexOf('/') + 1);
    }

    /** Last segment of a path. */
    function basename(path) {
        return path.substring(path.lastIndexOf('/') + 1);
    }

    /** True for URLs with a scheme (https:, data:, blob:, mailto:, ...) or protocol-relative URLs. */
    function isExternalUrl(url) {
        return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
    }

    /**
     * Classify a link href found in rendered markdown.
     *   'anchor'   -> in-page link (#section)
     *   'external' -> has a scheme, open outside the viewer
     *   'relative' -> points at another file next to the document
     */
    function classifyLink(href) {
        if (!href) return 'anchor';
        if (href.startsWith('#')) return 'anchor';
        if (isExternalUrl(href)) return 'external';
        return 'relative';
    }

    /**
     * Resolve `relPath` against `baseDir`, normalizing `.` and `..` segments.
     * Query strings / fragments are dropped and percent-escapes decoded, since
     * the result is used as a file path rather than a URL.
     *
     * Returns null if the path climbs above the root of `baseDir`.
     */
    function resolveRelativePath(baseDir, relPath) {
        let target = String(relPath).split(/[?#]/)[0];
        try {
            target = decodeURIComponent(target);
        } catch (_) {
            // Leave malformed escapes as-is.
        }

        const isAbsolute = target.startsWith('/');
        const leadingSlash = isAbsolute || baseDir.startsWith('/');
        const parts = (isAbsolute ? [] : baseDir.split('/')).concat(target.split('/'));

        const stack = [];
        for (const part of parts) {
            if (part === '' || part === '.') continue;
            if (part === '..') {
                if (stack.length === 0) return null;
                stack.pop();
                continue;
            }
            stack.push(part);
        }
        return (leadingSlash ? '/' : '') + stack.join('/');
    }

    /** GitHub-style heading slug: "Hello, World!" -> "hello-world". */
    function slugify(text) {
        return String(text)
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/\s/g, '-');
    }

    /** Slug that isn't in `used` yet (adds -1, -2, ... like GitHub); records it in `used`. */
    function uniqueSlug(text, used) {
        const base = slugify(text) || 'section';
        let slug = base;
        for (let n = 1; used.has(slug); n++) {
            slug = `${base}-${n}`;
        }
        used.add(slug);
        return slug;
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ------------------------------------------------------------------
    // Live reload: keeping the reading position
    // ------------------------------------------------------------------

    /**
     * Where the reader is, relative to the rendered blocks rather than as a raw offset, so an
     * edit above the viewport (which changes the height of everything before it) doesn't move
     * the text being read.
     *
     * blocks: [{ top, height }] for the top-level blocks in page coordinates, in order.
     * y: the page offset of the top of the viewport.
     * Returns { index, offset }: the first block that reaches into the viewport, and how far
     * the viewport top is past that block's top (negative in the gap above it). null when there
     * are no blocks.
     */
    function captureScrollAnchor(blocks, y) {
        if (!blocks || blocks.length === 0) return null;
        for (let index = 0; index < blocks.length; index++) {
            const block = blocks[index];
            if (block.top + block.height > y) {
                return { index, offset: y - block.top };
            }
        }
        const index = blocks.length - 1;
        return { index, offset: y - blocks[index].top };
    }

    /**
     * The page offset that puts an anchor from captureScrollAnchor back at the top of the
     * viewport, given the new block positions. If the anchored block got shorter the offset is
     * clamped to it, and a missing block falls back to the last one. null if it can't apply.
     */
    function restoreScrollAnchor(anchor, blocks) {
        if (!anchor || !blocks || blocks.length === 0) return null;
        const index = Math.min(Math.max(anchor.index, 0), blocks.length - 1);
        const block = blocks[index];
        const offset = Math.min(anchor.offset, Math.max(block.height, 0));
        return Math.max(0, block.top + offset);
    }

    return {
        captureScrollAnchor,
        restoreScrollAnchor,
        MARKDOWN_EXTENSIONS,
        isMarkdownName,
        isTextFile,
        dirname,
        basename,
        isExternalUrl,
        classifyLink,
        resolveRelativePath,
        slugify,
        uniqueSlug,
        escapeHtml,
    };
});
