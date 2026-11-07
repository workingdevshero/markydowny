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

    // ------------------------------------------------------------------
    // Live reload: what changed, and following it
    // ------------------------------------------------------------------

    /**
     * Compares the raw text of the old and new top-level blocks. Everything between the
     * unchanged start and the unchanged end is the change.
     *
     * Returns { changed, start, end, oldEnd, removedBefore }:
     *   new blocks [start, end) are new or changed; they replace old blocks [start, oldEnd).
     *   removedBefore: when blocks were only removed, the index in the new list they were
     *   removed before (=== newRaws.length when removed from the end); otherwise null.
     */
    function changedBlocks(oldRaws, newRaws) {
        const limit = Math.min(oldRaws.length, newRaws.length);
        let start = 0;
        while (start < limit && oldRaws[start] === newRaws[start]) start++;
        // The suffix may not overlap the prefix, or repeated blocks would be counted twice.
        let suffix = 0;
        while (
            suffix < limit - start &&
            oldRaws[oldRaws.length - 1 - suffix] === newRaws[newRaws.length - 1 - suffix]
        ) {
            suffix++;
        }
        const end = newRaws.length - suffix;
        const oldEnd = oldRaws.length - suffix;
        const changed = end > start || oldEnd > start;
        const removedBefore = changed && end === start ? start : null;
        return { changed, start, end, oldEnd, removedBefore };
    }

    /** Where old block `index` is after a change from changedBlocks. */
    function mapBlockIndex(index, diff) {
        if (!diff || !diff.changed || index < diff.start) return index;
        if (index >= diff.oldEnd) return index + (diff.end - diff.oldEnd);
        return Math.min(index, Math.max(diff.end - 1, diff.start));
    }

    /** The block a reload should draw attention to: the first changed one, or the removal point. */
    function changeTarget(diff, blockCount) {
        if (!diff || !diff.changed || blockCount === 0) return null;
        const index = diff.end > diff.start ? diff.start : diff.removedBefore;
        return Math.min(index, blockCount - 1);
    }

    /**
     * Follow mode as a state machine. state: { mode: 'off' | 'following' | 'paused', target }
     * where target is the block of the latest change (or null).
     *
     * Events:
     *   { type: 'reload', target, visible } - the document changed; visible: whether the
     *       target block is already in view.
     *   { type: 'userScroll' } - the reader scrolled. Following pauses, like a terminal.
     *   { type: 'toggle' } - the Follow button. Off or paused -> following, jumping to the
     *       latest change; following -> off.
     *   { type: 'reset' } - a different document: forget the target, un-pause.
     * Returns { state, scrollTo } where scrollTo is a block index to bring into view, or null.
     */
    function followReducer(state, event) {
        const next = { mode: state.mode, target: state.target };
        let scrollTo = null;
        switch (event.type) {
            case 'reload':
                next.target = event.target === undefined ? null : event.target;
                if (next.mode === 'following' && next.target !== null && !event.visible) {
                    scrollTo = next.target;
                }
                break;
            case 'userScroll':
                if (next.mode === 'following') next.mode = 'paused';
                break;
            case 'toggle':
                if (next.mode === 'following') {
                    next.mode = 'off';
                } else {
                    next.mode = 'following';
                    scrollTo = next.target;
                }
                break;
            case 'reset':
                next.target = null;
                if (next.mode === 'paused') next.mode = 'following';
                break;
        }
        return { state: next, scrollTo };
    }

    /** "Updated just now", "Updated 12s ago", "Updated 3 min ago", ... */
    function formatUpdated(elapsedMs) {
        const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
        if (seconds < 5) return 'Updated just now';
        if (seconds < 60) return `Updated ${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `Updated ${minutes} min ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `Updated ${hours} h ago`;
        return `Updated ${Math.floor(hours / 24)} d ago`;
    }

    return {
        changedBlocks,
        mapBlockIndex,
        changeTarget,
        followReducer,
        formatUpdated,
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
