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

    /** Most documents "Open all as tabs" opens at once; each tab is a window with its own webview. */
    const MAX_OPEN_ALL = 50;

    /**
     * Label for the file selector's "Open all as tabs" button, or null when it
     * shouldn't be offered (fewer than two files, or too many to open at once).
     */
    function openAllLabel(count) {
        if (!Number.isInteger(count) || count < 2 || count > MAX_OPEN_ALL) return null;
        return `Open all ${count} as tabs`;
    }

    /**
     * 'next' for ⌃Tab, 'previous' for ⌃⇧Tab, otherwise null. The desktop app
     * switches tabs with these; the webview sees them before the app's menu.
     */
    function tabStepForKey(event) {
        if (!event || event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.altKey) return null;
        return event.shiftKey ? 'previous' : 'next';
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    return {
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
        MAX_OPEN_ALL,
        openAllLabel,
        tabStepForKey,
        escapeHtml,
    };
});
