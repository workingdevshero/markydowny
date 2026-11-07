/**
 * Markydowny UI. Runs unchanged on markydowny.com and inside the desktop app;
 * when Tauri is present it switches to native file handling (real paths,
 * Finder integration, links opened in the default browser).
 */
(function () {
    'use strict';

    const core = window.MarkyCore;
    const tauri = window.__TAURI__ || null;
    const isDesktop = Boolean(tauri && tauri.core);
    const invoke = isDesktop ? tauri.core.invoke : null;
    const DEFAULT_TITLE = document.title;

    const $ = (id) => document.getElementById(id);
    const container = document.querySelector('.container');
    const dropZone = $('dropZone');
    const markdownContent = $('markdownContent');
    const backButton = $('backButton');
    const fileInput = $('fileInput');
    const uploadButton = $('uploadButton');
    const fullscreenButton = $('fullscreenButton');
    const docTitle = $('docTitle');
    const fileSelector = $('fileSelector');
    const fileList = $('fileList');
    const cancelSelectorButton = $('cancelSelector');
    const lightbox = $('lightbox');
    const lightboxImage = $('lightboxImage');
    const lightboxClose = $('lightboxClose');
    const lightboxInfo = $('lightboxInfo');
    const liveNotice = $('liveNotice');
    const followButton = $('followButton');
    const followLabel = $('followLabel');
    const liveStatus = $('liveStatus');
    const watchFolderButton = $('watchFolderButton');

    const BLOCK_MARK = 'markydowny-block:';
    const FOLLOW_KEY = 'markydowny.follow';
    const HIGHLIGHT_FADE_MS = 2400;
    const HIGHLIGHT_STATIC_MS = 4000;
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

    // Web folder drops: relative path (e.g. "docs/img/a.png") -> File
    const folderFiles = new Map();
    let blobUrls = [];
    // What is on screen: { kind: 'file' | 'folder' | 'desktop', dir, title, path?, markdown }
    let currentSource = null;
    // Bumped by every render, so a slow render can't overwrite a newer one.
    let renderSeq = 0;
    // While a reload's images load, keep re-applying its scroll anchor (until the reader scrolls).
    let anchorHold = null;
    // The blocks on screen: { blocks: [{ raw, nodes }], linksKey }.
    let rendered = null;
    // Headings whose id we generated (as opposed to ids in the markdown's own HTML).
    const autoHeadingIds = new WeakSet();
    const highlightTimers = new Map();
    // Live mode: the document on screen is watched (desktop, or a file handle on the web).
    let isLive = false;
    let follow = { mode: loadFollowPreference() ? 'following' : 'off', target: null };
    let updatedAt = null;
    let updatedTimer = null;
    // Desktop: the folder behind the file list, { root, name, following }. While following,
    // the window shows whichever markdown file in it changed last.
    let desktopFolder = null;

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });
    ['dragenter', 'dragover'].forEach(eventName => dropZone.addEventListener(eventName, highlight, false));
    ['dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, unhighlight, false));
    dropZone.addEventListener('drop', handleDrop, false);

    fileInput.addEventListener('change', (e) => handleFiles(e.target.files), false);
    dropZone.addEventListener('click', chooseFile);
    dropZone.addEventListener('keydown', (e) => {
        if (e.target === dropZone && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            chooseFile();
        }
    });
    uploadButton.addEventListener('click', (e) => {
        e.stopPropagation();
        chooseFile();
    });
    cancelSelectorButton.addEventListener('click', showDropZone);
    backButton.addEventListener('click', showDropZone);
    fullscreenButton.addEventListener('click', toggleFullscreen);
    markdownContent.addEventListener('click', handleContentClick);

    lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', (e) => {
        if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lightbox.style.display === 'block') closeLightbox();
    });
    followButton.addEventListener('click', toggleFollow);
    watchFolderButton.addEventListener('click', toggleWatchFolder);
    ['wheel', 'touchmove', 'keydown', 'mousedown'].forEach(type => {
        window.addEventListener(type, onUserInput, { passive: true });
    });
    renderFollowButton();

    if (isDesktop) {
        initDesktop().catch(err => console.error('Desktop init failed:', err));
    }

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    function highlight() {
        dropZone.classList.add('dragover');
    }

    function unhighlight() {
        dropZone.classList.remove('dragover');
    }

    function chooseFile() {
        if (isDesktop) {
            invoke('show_open_dialog').catch(console.error);
        } else {
            fileInput.click();
        }
    }

    // ------------------------------------------------------------------
    // Desktop (Tauri)
    // ------------------------------------------------------------------

    async function initDesktop() {
        document.body.classList.add('desktop');

        // Finder / Dock / File > Open… route documents to a window and ping it.
        await tauri.event.listen('document-pending', loadPendingDocument);

        // Live reload: the window's watch reports changes to the document it shows.
        await tauri.event.listen('document-changed', (event) => onDocumentChanged(event.payload));
        await tauri.event.listen('document-missing', (event) => onDocumentMissing(event.payload));

        // Native drag & drop gives real file paths (HTML5 drops don't in the app).
        await tauri.webview.getCurrentWebview().onDragDropEvent((event) => {
            const { type, paths } = event.payload;
            if (type === 'enter' || type === 'over') {
                highlight();
            } else if (type === 'leave') {
                unhighlight();
            } else if (type === 'drop') {
                unhighlight();
                handleDesktopDrop(paths);
            }
        });

        await loadPendingDocument();
    }

    async function loadPendingDocument() {
        try {
            const pending = await invoke('take_pending_document');
            if (!pending) return;
            if (pending.folder) {
                // A folder opened from Finder or `open -a`: offer its files, and watching it.
                await handleDesktopDrop([pending.folder]);
                return;
            }
            if (isFollowingFolder() && isInFolder(pending.path)) {
                // Opened from inside the folder this window follows: switch to it, keep following.
                await showFolderFile(pending, null);
                return;
            }
            closeFileSelector();
            desktopFolder = null;
            renderWatchFolderButton();
            await showDesktopDocument(pending);
        } catch (err) {
            showDropZone();
            alert(String(err));
        }
    }

    async function handleDesktopDrop(paths) {
        if (!paths || paths.length === 0) return;
        const entries = await invoke('list_markdown_files', { paths });
        if (entries.length === 0) {
            alert('No markdown files found. Drop a .md or .markdown file, or a folder containing them.');
            return;
        }
        if (entries.length === 1) {
            closeFileSelector();
            desktopFolder = null;
            renderWatchFolderButton();
            await loadDesktopPath(entries[0].path);
            return;
        }
        // One dropped item with several files in it is a folder, which can be watched.
        const root = paths.length === 1 ? paths[0].replace(/\/+$/, '') : null;
        desktopFolder = root ? { root, name: core.basename(root), following: false } : null;
        showFileSelector(entries.map(entry => ({
            name: core.basename(entry.path),
            display: entry.display,
            path: entry.path,
            load: () => loadDesktopPath(entry.path),
        })));
    }

    /** Shows a file picked by hand. In a watched folder this pins it: the window stops switching. */
    async function loadDesktopPath(path) {
        if (desktopFolder) desktopFolder.following = false;
        renderWatchFolderButton();
        try {
            await showDesktopDocument(await invoke('read_document', { path }));
        } catch (err) {
            alert(String(err));
        }
    }

    async function showDesktopDocument(doc) {
        folderFiles.clear();
        const title = desktopFolder ? folderTitle(doc) : doc.name;
        await renderMarkdown(doc.content, { kind: 'desktop', dir: doc.dir, title, path: doc.path });
        setLive(true);
        selectFileInList(doc.path);
        await watchDesktopDocument(doc.path);
    }

    /** Starts live reload for the document on screen, catching up if it changed meanwhile. */
    async function watchDesktopDocument(path) {
        try {
            const now = await invoke('watch_document', { path });
            if (!isShowingPath(path)) return;
            if (now) {
                onDocumentChanged(now);
            } else {
                showMissingNotice();
            }
        } catch (err) {
            console.error('Live reload unavailable:', err);
        }
    }

    function isShowingPath(path) {
        return Boolean(currentSource && currentSource.kind === 'desktop' && currentSource.path === path);
    }

    /**
     * A watched document changed. In a followed folder, a change to another file switches to
     * it (highlighting its edit against the content it had before).
     */
    function onDocumentChanged(doc) {
        if (!currentSource || currentSource.kind !== 'desktop') return;
        if (doc.path !== currentSource.path) {
            if (isFollowingFolder() && isInFolder(doc.path)) {
                showFolderFile(doc, typeof doc.previous === 'string' ? doc.previous : '');
            }
            return;
        }
        hideMissingNotice();
        if (doc.content === currentSource.markdown) {
            // Already showing this content, but switched to without knowing what changed
            // (opened while following): the watch's report still has the edit to highlight.
            if (currentSource.unhighlighted && typeof doc.previous === 'string' && doc.previous !== doc.content) {
                renderMarkdown(doc.content, { ...currentSource, unhighlighted: false }, { reload: true, previous: doc.previous });
            }
            return;
        }
        renderMarkdown(doc.content, { ...currentSource, unhighlighted: false }, { reload: true });
    }

    function onDocumentMissing(payload) {
        if (isShowingPath(payload.path)) showMissingNotice();
    }

    // ------------------------------------------------------------------
    // Desktop: following a folder
    // ------------------------------------------------------------------

    function isFollowingFolder() {
        return Boolean(desktopFolder && desktopFolder.following);
    }

    function isInFolder(path) {
        return Boolean(desktopFolder && path && path.startsWith(desktopFolder.root + '/'));
    }

    function folderTitle(doc) {
        return `${desktopFolder.name} › ${doc.name}`;
    }

    /** Watch this folder (follow whichever file changes), or stop and stay on the current file. */
    async function toggleWatchFolder() {
        if (!desktopFolder) return;
        if (desktopFolder.following) {
            desktopFolder.following = false;
            renderWatchFolderButton();
            if (currentSource && currentSource.path) await watchDesktopDocument(currentSource.path);
            return;
        }
        try {
            const result = await invoke('watch_folder', { path: desktopFolder.root });
            desktopFolder = { root: result.root, name: result.name, following: true };
            renderWatchFolderButton();
            if (result.document) {
                await showFolderFile(result.document, null, { fresh: true });
            }
        } catch (err) {
            alert(String(err));
        }
    }

    /**
     * Shows a file of the followed folder. `previous` is its earlier content (to highlight the
     * edit), or null when unknown; `fresh` starts it as a new document.
     */
    async function showFolderFile(doc, previous, { fresh = false } = {}) {
        // Already on screen as it is (the watch got there first): keep its highlight.
        if (!fresh && isShowingPath(doc.path) && doc.content === currentSource.markdown) return;
        folderFiles.clear();
        const source = {
            kind: 'desktop',
            dir: doc.dir,
            title: folderTitle(doc),
            path: doc.path,
            unhighlighted: previous === null,
        };
        if (fresh || !rendered || currentSource === null) {
            await renderMarkdown(doc.content, source);
            setLive(true);
        } else {
            await renderMarkdown(doc.content, source, {
                reload: true,
                previous: previous === null ? doc.content : previous,
            });
        }
        selectFileInList(doc.path);
    }

    function renderWatchFolderButton() {
        const show = Boolean(isDesktop && desktopFolder);
        watchFolderButton.hidden = !show;
        if (!show) return;
        const on = desktopFolder.following;
        watchFolderButton.setAttribute('aria-pressed', String(on));
        watchFolderButton.textContent = on ? 'Watching folder' : 'Watch this folder';
        watchFolderButton.title = on
            ? 'Showing whichever markdown file changes. Click to stay on this file.'
            : 'Show whichever markdown file in this folder changes next';
    }

    function selectFileInList(path) {
        for (const item of fileList.querySelectorAll('.file-item')) {
            item.classList.toggle('selected', item.dataset.path === path);
        }
    }

    function setDocumentOpen(open, title) {
        if (!isDesktop) return;
        invoke('set_document_open', { open, title: title || null }).catch(console.error);
    }

    // ------------------------------------------------------------------
    // Web file / folder input
    // ------------------------------------------------------------------

    function handleDrop(e) {
        const items = e.dataTransfer.items;
        if (items && items.length > 0 && items[0].webkitGetAsEntry) {
            const entry = items[0].webkitGetAsEntry();
            if (entry && entry.isDirectory) {
                handleFolder(entry);
                return;
            }
        }
        handleFiles(e.dataTransfer.files);
    }

    function handleFiles(files) {
        if (!files || files.length === 0) return;
        const file = files[0];
        if (!core.isTextFile(file)) {
            alert('Please select a markdown (.md) or text file.');
            return;
        }
        folderFiles.clear();
        file.text().then(
            text => renderMarkdown(text, { kind: 'file', dir: '', title: file.name }),
            () => alert('Error loading the markdown file. Please try again.')
        );
    }

    async function handleFolder(folderEntry) {
        try {
            folderFiles.clear();
            await readFolderRecursively(folderEntry, '');

            const markdownFiles = Array.from(folderFiles.entries())
                .filter(([path]) => core.isMarkdownName(path));

            if (markdownFiles.length === 0) {
                alert('No markdown files found in this folder. Please select a folder containing .md or .markdown files.');
                return;
            }
            if (markdownFiles.length === 1) {
                const [path, file] = markdownFiles[0];
                loadFolderFile(file, path);
                return;
            }
            showFileSelector(markdownFiles.map(([path, file]) => ({
                name: file.name,
                display: path,
                load: () => loadFolderFile(file, path),
            })));
        } catch (error) {
            console.error('Error reading folder:', error);
            alert('Error reading folder contents. Please try again.');
        }
    }

    async function readFolderRecursively(entry, path) {
        if (entry.isFile) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            folderFiles.set(path + entry.name, file);
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            // readEntries returns results in batches; keep reading until empty.
            let batch;
            do {
                batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                for (const child of batch) {
                    await readFolderRecursively(child, path + entry.name + '/');
                }
            } while (batch.length > 0);
        }
    }

    async function loadFolderFile(file, filePath) {
        try {
            const text = await file.text();
            await renderMarkdown(text, { kind: 'folder', dir: core.dirname(filePath), title: file.name });
        } catch (error) {
            console.error('Error loading markdown file:', error);
            alert('Error loading the markdown file. Please try again.');
        }
    }

    function blobUrlFor(file) {
        const url = URL.createObjectURL(file);
        blobUrls.push(url);
        return url;
    }

    function revokeBlobUrls() {
        blobUrls.forEach(url => URL.revokeObjectURL(url));
        blobUrls = [];
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    /**
     * Renders markdown into the content area. A new document starts at the top. A reload
     * (same document, new content) keeps the reader's position, replaces only the blocks that
     * changed, highlights them, and follows them in Follow mode.
     *
     * options.reload: same document, new content.
     * options.previous: for a reload that switches to another file (a watched folder), that
     *   file's earlier content, so its changes can still be highlighted.
     */
    async function renderMarkdown(markdownText, source, { reload = false, previous = null } = {}) {
        const seq = ++renderSeq;
        currentSource = source;
        if (!reload) revokeBlobUrls();

        let built;
        try {
            built = buildBlocks(markdownText);
            await resolveImages(built.doc, source);
        } catch (error) {
            console.error('Error parsing markdown:', error);
            built = { blocks: [{ raw: markdownText, nodes: [renderError(markdownText)] }], linksKey: '' };
        }

        if (seq !== renderSeq) return;
        source.markdown = markdownText;

        if (!reload || !rendered) {
            commitBlocks(built, null);
            anchorHold = null;
            dispatchFollow({ type: 'reset' });
            // "Updated ..." describes this document's reloads, which haven't happened yet.
            updatedAt = null;
            liveStatus.hidden = true;
            showMarkdownContent(source.title);
            markdownContent.scrollTop = 0;
            window.scrollTo(0, 0);
            return;
        }

        let oldRaws = rendered.blocks.map(block => block.raw);
        let reuse = built.linksKey === rendered.linksKey;
        if (previous !== null) {
            // Another file: nothing on screen can be reused, but its own edit is still shown.
            try {
                oldRaws = buildBlocks(previous).blocks.map(block => block.raw);
            } catch (_) {
                oldRaws = [];
            }
            reuse = false;
        }
        const diff = core.changedBlocks(oldRaws, built.blocks.map(block => block.raw));
        const switching = previous !== null;
        const anchor = switching ? null : captureAnchor();

        commitBlocks(built, reuse ? diff : null);
        if (switching) showMarkdownContent(source.title);
        if (anchor) {
            restoreAnchor({ ...anchor, index: core.mapBlockIndex(anchor.index, diff) });
        } else {
            window.scrollTo(0, 0);
        }
        highlightChanges(diff);
        markUpdated();

        const target = core.changeTarget(diff, rendered.blocks.length);
        const scrolled = dispatchFollow({ type: 'reload', target, visible: isBlockVisible(target) });
        if (scrolled || !anchor) {
            anchorHold = null;
        } else {
            keepAnchor({ ...anchor, index: core.mapBlockIndex(anchor.index, diff) });
        }
    }

    /**
     * Parses markdown into top-level blocks: [{ raw, nodes }]. Each block is one top-level
     * token, or several when raw HTML spans them (e.g. a <details> around paragraphs). The
     * markup is identical to marked.parse(): the tokens are rendered with a marker comment
     * before each, parsed as one document (so HTML nests exactly as before), grouped by the
     * markers, and the markers removed.
     */
    function buildBlocks(markdownText) {
        const tokens = marked.lexer(markdownText);
        const kept = tokens.filter(token => token.type !== 'space');
        let html = '';
        kept.forEach((token, index) => {
            const one = [token];
            one.links = tokens.links;
            html += `<!--${BLOCK_MARK}${index}-->` + marked.parser(one);
        });
        // An inert document, so images aren't fetched before their paths are resolved.
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const groups = [];
        let group = null;
        for (const node of Array.from(doc.body.childNodes)) {
            const mark = blockMark(node);
            if (mark !== null) {
                node.remove();
                if (!group || mark > group.last) {
                    group = { first: mark, last: mark, nodes: [] };
                    groups.push(group);
                }
                continue;
            }
            if (!group) {
                group = { first: 0, last: 0, nodes: [] };
                groups.push(group);
            }
            group.nodes.push(node);
            if (node.nodeType === Node.ELEMENT_NODE) {
                // Markers nested in this element: it spans those tokens too.
                const walker = doc.createTreeWalker(node, NodeFilter.SHOW_COMMENT);
                const nested = [];
                while (walker.nextNode()) nested.push(walker.currentNode);
                for (const comment of nested) {
                    const inner = blockMark(comment);
                    if (inner === null) continue;
                    group.last = Math.max(group.last, inner);
                    comment.remove();
                }
            }
        }

        const blocks = groups.map(g => ({
            raw: kept.slice(g.first, g.last + 1).map(token => token.raw).join('').trimEnd(),
            nodes: g.nodes,
        }));
        return { blocks, doc, linksKey: JSON.stringify(tokens.links || {}) };
    }

    function blockMark(node) {
        if (node.nodeType !== Node.COMMENT_NODE || !node.data.startsWith(BLOCK_MARK)) return null;
        const index = Number(node.data.slice(BLOCK_MARK.length));
        return Number.isInteger(index) ? index : null;
    }

    /**
     * Puts built blocks on screen. With a diff, the unchanged blocks before and after the
     * change keep their existing elements (so their images don't reload or resize) and only
     * the changed ones are swapped in.
     */
    function commitBlocks(built, diff) {
        let blocks;
        if (diff && rendered) {
            const old = rendered.blocks;
            for (const block of old.slice(diff.start, diff.oldEnd)) {
                block.nodes.forEach(node => node.remove());
            }
            const fresh = built.blocks.slice(diff.start, diff.end);
            const after = old.slice(diff.oldEnd).find(block => block.nodes.length > 0);
            const fragment = document.createDocumentFragment();
            fresh.forEach(block => block.nodes.forEach(node => fragment.appendChild(node)));
            markdownContent.insertBefore(fragment, after ? after.nodes[0] : null);
            blocks = old.slice(0, diff.start).concat(fresh, old.slice(diff.oldEnd));
            blocks.forEach((block, i) => {
                block.raw = built.blocks[i].raw;
            });
        } else {
            blocks = built.blocks;
            markdownContent.replaceChildren(...blocks.flatMap(block => block.nodes));
        }
        blocks.forEach((block, index) => {
            for (const node of block.nodes) {
                if (node.nodeType === Node.ELEMENT_NODE) node.dataset.block = String(index);
            }
        });
        rendered = { blocks, linksKey: built.linksKey };
        refreshHeadingIds();
    }

    function renderError(markdownText) {
        const box = document.createElement('div');
        box.className = 'render-error';
        box.innerHTML = `
            <h3>Error parsing markdown</h3>
            <p>There was an error parsing the markdown file. Here's the raw content:</p>
            <pre>${core.escapeHtml(markdownText)}</pre>
        `;
        return box;
    }

    /**
     * GitHub-style ids for headings that don't have one, recomputed after every change so
     * duplicates stay numbered in document order. Ids written in the markdown's own HTML are
     * left alone.
     */
    function refreshHeadingIds() {
        const used = new Set();
        for (const heading of markdownContent.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
            if (heading.id && !autoHeadingIds.has(heading)) continue;
            heading.id = core.uniqueSlug(heading.textContent, used);
            autoHeadingIds.add(heading);
        }
    }

    // ------------------------------------------------------------------
    // Live reload: reading position, highlight, Follow, notices
    // ------------------------------------------------------------------

    /** Height of the sticky top bar covering the top of the page (0 when it isn't there). */
    function topInset() {
        const bar = document.querySelector('.topbar');
        if (!bar) return 0;
        const style = getComputedStyle(bar);
        if (style.display === 'none' || style.position !== 'sticky') return 0;
        return bar.getBoundingClientRect().height;
    }

    /** Page position of each rendered block (blocks without elements sit where the last ended). */
    function blockRects() {
        if (!rendered) return [];
        let bottom = 0;
        return rendered.blocks.map(block => {
            let top = Infinity;
            let end = -Infinity;
            for (const node of block.nodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                const rect = node.getBoundingClientRect();
                top = Math.min(top, rect.top + window.scrollY);
                end = Math.max(end, rect.bottom + window.scrollY);
            }
            if (top === Infinity) return { top: bottom, height: 0 };
            bottom = end;
            return { top, height: end - top };
        });
    }

    function captureAnchor() {
        return core.captureScrollAnchor(blockRects(), window.scrollY + topInset());
    }

    function restoreAnchor(anchor) {
        const y = core.restoreScrollAnchor(anchor, blockRects());
        if (y !== null) window.scrollTo(0, y - topInset());
    }

    /**
     * Keeps re-applying the anchor as images in the new content finish loading (they change
     * the height of the blocks above), until the reader scrolls or a few seconds pass.
     */
    function keepAnchor(anchor) {
        const loading = Array.from(markdownContent.querySelectorAll('img')).filter(img => !img.complete);
        if (loading.length === 0) {
            anchorHold = null;
            return;
        }
        const hold = { anchor };
        anchorHold = hold;
        const reapply = () => {
            if (anchorHold === hold) restoreAnchor(anchor);
        };
        for (const img of loading) {
            img.addEventListener('load', reapply, { once: true });
            img.addEventListener('error', reapply, { once: true });
        }
        setTimeout(() => {
            if (anchorHold === hold) anchorHold = null;
        }, 3000);
    }

    function prefersReducedMotion() {
        return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function blockElements(index) {
        if (!rendered || index === null || index < 0 || index >= rendered.blocks.length) return [];
        return rendered.blocks[index].nodes.filter(node => node.nodeType === Node.ELEMENT_NODE);
    }

    /** Tints the changed blocks (fading out), or marks where blocks were removed. */
    function highlightChanges(diff) {
        if (!diff.changed) return;
        const targets = [];
        for (let i = diff.start; i < diff.end; i++) {
            blockElements(i).forEach(el => targets.push([el, 'block-changed']));
        }
        if (diff.removedBefore !== null && rendered.blocks.length > 0) {
            if (diff.removedBefore < rendered.blocks.length) {
                const [el] = blockElements(diff.removedBefore);
                if (el) targets.push([el, 'block-removed-before']);
            } else {
                const els = blockElements(rendered.blocks.length - 1);
                if (els.length) targets.push([els[els.length - 1], 'block-removed-after']);
            }
        }
        const duration = prefersReducedMotion() ? HIGHLIGHT_STATIC_MS : HIGHLIGHT_FADE_MS;
        for (const [el, className] of targets) {
            // Restart the animation if the same element changes again.
            el.classList.remove(className);
            void el.offsetWidth;
            el.classList.add(className);
            clearTimeout(highlightTimers.get(el));
            highlightTimers.set(el, setTimeout(() => {
                el.classList.remove(className);
                highlightTimers.delete(el);
            }, duration));
        }
    }

    function isBlockVisible(index) {
        const els = blockElements(index);
        if (els.length === 0) return true;
        const top = els[0].getBoundingClientRect().top;
        const bottom = els[els.length - 1].getBoundingClientRect().bottom;
        return bottom > topInset() && top < window.innerHeight;
    }

    function scrollToBlock(index) {
        const [el] = blockElements(index);
        if (!el) return;
        const top = el.getBoundingClientRect().top + window.scrollY;
        // A little context above the change.
        const y = Math.max(0, top - topInset() - window.innerHeight * 0.2);
        window.scrollTo({ top: y, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }

    /** Runs a Follow event; returns true if it scrolled. */
    function dispatchFollow(event) {
        const result = core.followReducer(follow, event);
        follow = result.state;
        renderFollowButton();
        if (result.scrollTo === null) return false;
        anchorHold = null;
        scrollToBlock(result.scrollTo);
        return true;
    }

    function toggleFollow() {
        dispatchFollow({ type: 'toggle' });
        saveFollowPreference(follow.mode !== 'off');
    }

    function renderFollowButton() {
        const label = { off: 'Follow', following: 'Following', paused: 'Resume' }[follow.mode];
        followLabel.textContent = label;
        followButton.setAttribute('aria-pressed', String(follow.mode === 'following'));
        followButton.classList.toggle('paused', follow.mode === 'paused');
        followButton.title = {
            off: 'Follow changes: keep the latest edit in view',
            following: 'Following changes. Click to stop.',
            paused: 'Paused because you scrolled. Click to jump to the latest change.',
        }[follow.mode];
    }

    function loadFollowPreference() {
        try {
            return window.localStorage.getItem(FOLLOW_KEY) !== 'off';
        } catch (_) {
            return true;
        }
    }

    function saveFollowPreference(on) {
        try {
            window.localStorage.setItem(FOLLOW_KEY, on ? 'on' : 'off');
        } catch (_) {
            // Private mode or storage disabled: the choice lasts for this page only.
        }
    }

    /** Reader input that scrolls the page: releases the anchor and pauses Follow. */
    function onUserInput(e) {
        if (e.type === 'keydown' && (!SCROLL_KEYS.has(e.key) || e.target.closest('button, input, textarea, select'))) return;
        if (e.type === 'mousedown') {
            // Only a press on the page's scrollbar scrolls; clicks on content don't.
            const root = document.documentElement;
            if (e.target !== root && e.clientX < root.clientWidth) return;
        }
        if (e.type === 'wheel' && !e.deltaY) return;
        anchorHold = null;
        if (isLive) dispatchFollow({ type: 'userScroll' });
    }

    /** Live mode: the document on screen is watched. Shows Follow (and later "Updated"). */
    function setLive(on) {
        isLive = on;
        document.body.classList.toggle('live', on);
        followButton.hidden = !on;
        if (!on) {
            liveStatus.hidden = true;
            updatedAt = null;
            clearInterval(updatedTimer);
            updatedTimer = null;
        }
    }

    function markUpdated() {
        if (!isLive) return;
        updatedAt = new Date();
        liveStatus.title = `Updated at ${updatedAt.toLocaleTimeString()}`;
        liveStatus.hidden = false;
        refreshUpdated();
        if (!updatedTimer) updatedTimer = setInterval(refreshUpdated, 5000);
    }

    function refreshUpdated() {
        if (updatedAt) liveStatus.textContent = core.formatUpdated(Date.now() - updatedAt.getTime());
    }

    function showMissingNotice() {
        liveNotice.hidden = false;
    }

    function hideMissingNotice() {
        liveNotice.hidden = true;
    }

    async function resolveImages(doc, source) {
        const allowed = [];
        for (const img of doc.querySelectorAll('img[src]')) {
            const src = img.getAttribute('src');
            if (!src || core.isExternalUrl(src)) continue;

            const path = core.resolveRelativePath(source.dir, src);
            if (!path) continue;

            if (source.kind === 'folder') {
                const file = folderFiles.get(path);
                if (file) img.setAttribute('src', blobUrlFor(file));
            } else if (source.kind === 'desktop') {
                allowed.push(path);
                img.setAttribute('src', tauri.core.convertFileSrc(path));
            }
        }
        if (allowed.length > 0) {
            try {
                await invoke('allow_asset_files', { paths: allowed });
            } catch (err) {
                console.error('Could not allow local images:', err);
            }
        }
    }

    function handleContentClick(e) {
        const img = e.target.closest('img');
        if (img) {
            e.preventDefault();
            openLightbox(img.src, img.alt || 'Image');
            return;
        }

        const link = e.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href');
        e.preventDefault();

        switch (core.classifyLink(href)) {
            case 'anchor':
                scrollToAnchor(href);
                break;
            case 'external':
                openExternal(href);
                break;
            case 'relative':
                openRelative(href);
                break;
        }
    }

    function scrollToAnchor(href) {
        let id = href.slice(1);
        try {
            id = decodeURIComponent(id);
        } catch (_) {
            // use raw id
        }
        const target = id && markdownContent.querySelector(`[id="${CSS.escape(id)}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function openExternal(url) {
        if (isDesktop) {
            invoke('plugin:opener|open_url', { url }).catch(console.error);
        } else {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }

    function openRelative(href) {
        if (!currentSource) return;
        const path = core.resolveRelativePath(currentSource.dir, href);
        if (!path) return;

        if (currentSource.kind === 'desktop') {
            // Linked markdown opens in its own window, like double-clicking it.
            // Anything else is revealed in Finder rather than launched, so a
            // document can't trick a click into running a script or app.
            const command = core.isMarkdownName(path)
                ? invoke('open_documents', { paths: [path] })
                : invoke('plugin:opener|reveal_item_in_dir', { paths: [path] });
            command.catch(console.error);
        } else if (currentSource.kind === 'folder') {
            const file = folderFiles.get(path);
            if (!file) return;
            if (core.isMarkdownName(path)) {
                loadFolderFile(file, path);
            } else {
                window.open(blobUrlFor(file), '_blank', 'noopener');
            }
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function showMarkdownContent(title) {
        dropZone.style.display = 'none';
        if (!container.classList.contains('file-selector-active')) {
            fileSelector.style.display = 'none';
        }
        markdownContent.style.display = 'block';
        backButton.style.display = 'inline-flex';
        fullscreenButton.style.display = 'inline-flex';
        docTitle.textContent = title || '';
        document.title = title ? `${title} - Markydowny` : DEFAULT_TITLE;
        hideMissingNotice();
        setDocumentOpen(true, title);
    }

    function closeFileSelector() {
        fileSelector.style.display = 'none';
        container.classList.remove('file-selector-active');
    }

    function showDropZone() {
        dropZone.style.display = 'flex';
        markdownContent.style.display = 'none';
        closeFileSelector();
        backButton.style.display = 'none';
        fullscreenButton.style.display = 'none';

        if (container.classList.contains('fullscreen')) {
            toggleFullscreen();
        }

        folderFiles.clear();
        revokeBlobUrls();
        renderSeq++;
        currentSource = null;
        rendered = null;
        anchorHold = null;
        hideMissingNotice();
        setLive(false);
        desktopFolder = null;
        renderWatchFolderButton();
        fileInput.value = '';
        docTitle.textContent = '';
        document.title = DEFAULT_TITLE;
        setDocumentOpen(false);
    }

    function toggleFullscreen() {
        const entering = !container.classList.contains('fullscreen');
        container.classList.toggle('fullscreen', entering);
        fullscreenButton.title = entering ? 'Exit Fullscreen' : 'Enter Fullscreen';
        fullscreenButton.setAttribute('aria-pressed', String(entering));
    }

    /** entries: [{ name, display, path?, load }] */
    function showFileSelector(entries) {
        dropZone.style.display = 'none';
        markdownContent.style.display = 'none';
        fileSelector.style.display = 'block';
        container.classList.add('file-selector-active');
        fileList.replaceChildren();
        renderWatchFolderButton();

        for (const entry of entries) {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.dataset.path = entry.path || '';
            item.innerHTML = `
                <span class="file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg></span>
                <div>
                    <div class="file-name">${core.escapeHtml(entry.name)}</div>
                    <div class="file-path">${core.escapeHtml(entry.display)}</div>
                </div>
            `;
            // A button to keyboards and assistive tech, so a file can be picked without a mouse.
            item.setAttribute('role', 'button');
            item.tabIndex = 0;
            const pick = () => {
                fileList.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                entry.load();
            };
            item.addEventListener('click', pick);
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick();
                }
            });
            fileList.appendChild(item);
        }
    }

    // ------------------------------------------------------------------
    // Lightbox
    // ------------------------------------------------------------------

    function openLightbox(imageSrc, imageAlt) {
        lightboxImage.src = imageSrc;
        lightboxImage.alt = imageAlt;
        lightboxInfo.textContent = imageAlt || 'Click anywhere to close';
        lightbox.style.display = 'block';
        document.body.style.overflow = 'hidden';
    }

    function closeLightbox() {
        lightbox.style.display = 'none';
        document.body.style.overflow = '';
        lightboxImage.src = '';
    }
})();
