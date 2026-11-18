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
    const openAllTabsButton = $('openAllTabs');
    const lightbox = $('lightbox');
    const lightboxImage = $('lightboxImage');
    const lightboxClose = $('lightboxClose');
    const lightboxInfo = $('lightboxInfo');
    const liveNotice = $('liveNotice');
    const followButton = $('followButton');
    const followLabel = $('followLabel');
    const liveStatus = $('liveStatus');
    const watchFolderButton = $('watchFolderButton');
    const editButton = $('editButton');
    const editLabel = $('editLabel');
    const saveButton = $('saveButton');
    const revertButton = $('revertButton');
    const editorHost = $('editorHost');
    const editBanner = $('editBanner');
    const bannerReload = $('bannerReload');
    const bannerKeep = $('bannerKeep');
    const formatToolbar = $('formatToolbar');
    const blockButton = $('blockButton');
    const blockLabel = $('blockLabel');
    const blockMenu = $('blockMenu');
    const moreButton = $('moreButton');
    const moreMenu = $('moreMenu');
    const modeSwitch = $('modeSwitch');

    const BLOCK_MARK = 'markydowny-block:';
    const FOLLOW_KEY = 'markydowny.follow';
    const MODE_KEY = 'markydowny.editorMode';
    const HIGHLIGHT_FADE_MS = 2400;
    const HIGHLIGHT_STATIC_MS = 4000;
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    // The editor, loaded the first time a document is edited so viewing stays as fast as before.
    const CODEMIRROR_SRC = 'js/vendor/codemirror.js';
    // The toolbar's commands, loaded with it.
    const FORMAT_SRC = 'js/format.js';
    const BLOCK_NAMES = {
        paragraph: 'Paragraph',
        h1: 'Heading 1',
        h2: 'Heading 2',
        h3: 'Heading 3',
        h4: 'Heading 4',
        h5: 'Heading 5',
        h6: 'Heading 6',
        quote: 'Quote',
        codeBlock: 'Code block',
    };
    const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

    // Web folder drops: relative path (e.g. "docs/img/a.png") -> File
    const folderFiles = new Map();
    let blobUrls = [];
    // Rich mode's folder images: File -> its URL in blobUrls.
    let imageBlobUrls = new Map();
    // What is on screen: { kind: 'file' | 'folder' | 'desktop', dir, title, path?, markdown }
    let currentSource = null;
    // Bumped by every render, so a slow render can't overwrite a newer one.
    let renderSeq = 0;
    // Bumped whenever a different document (or the drop zone) is shown, unlike reloads.
    let documentSeq = 0;
    // Bumped by every desktop watch request (a document, a folder, the drop zone), so the app
    // ignores one that finishes after a newer one. Starts from the clock so it keeps growing
    // across reloads of the page.
    let watchGeneration = Date.now();
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
    // Web: live reload through the File System Access API, where the browser has it
    // (Chromium). Elsewhere every flag is false and nothing below is wired.
    const webWatch = isDesktop ? core.fileWatchSupport(null) : core.fileWatchSupport(window);
    // The handle being watched: { handle, poller, observer }.
    let webWatched = null;
    // The file selector's "Open all as tabs" action (desktop only), or null.
    let openAllAction = null;
    // While editing: { view, cm, separator, state (core.editReducer), saving (the save being
    // written, a promise, or null) }.
    let editing = null;
    let codeMirrorLoad = null;
    let toolbarReady = false;
    // The editor's view: 'rich' (the markup styled, its markers shown on the cursor's lines) or
    // 'markdown' (the plain source). Rich unless the reader last chose otherwise.
    let editorMode = loadEditorMode();
    // Desktop: images Rich mode has asked the app to serve (path -> the request's promise).
    const allowedAssets = new Map();
    // Whether the title on screen carries the unsaved-changes mark.
    let titleMarked = false;
    // Desktop: the close-requested listener (a promise of its unlisten), while there are
    // unsaved changes.
    let closeGuard = null;

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
    cancelSelectorButton.addEventListener('click', () => {
        leaveEditor().then(left => {
            if (left) showDropZone();
        });
    });
    openAllTabsButton.addEventListener('click', () => {
        if (openAllAction) openAllAction();
    });
    backButton.addEventListener('click', () => {
        leaveEditor().then(left => {
            if (left) showDropZone();
        });
    });
    fullscreenButton.addEventListener('click', toggleFullscreen);
    editButton.addEventListener('click', toggleEditing);
    saveButton.addEventListener('click', saveDocument);
    revertButton.addEventListener('click', () => dispatchEdit({ type: 'revert' }));
    bannerReload.addEventListener('click', () => dispatchEdit({ type: 'reload' }));
    bannerKeep.addEventListener('click', () => dispatchEdit({ type: 'keepMine', text: editorText() }));
    // Capturing, so the shortcuts work wherever the focus is, the editor included.
    window.addEventListener('keydown', onEditShortcut, true);
    modeSwitch.addEventListener('click', onModeSwitchClick);
    modeSwitch.addEventListener('keydown', onModeSwitchKeydown);
    // Like the toolbar: clicking a mode leaves the focus (and the selection) in the editor.
    modeSwitch.addEventListener('mousedown', (e) => {
        if (e.target.closest('[data-mode]')) e.preventDefault();
    });
    formatToolbar.addEventListener('click', onToolbarClick);
    formatToolbar.addEventListener('keydown', onToolbarKeydown);
    formatToolbar.addEventListener('focusin', (e) => {
        if (e.target.matches('[data-tool]')) setRovingItem(e.target);
    });
    // Clicking a button leaves the focus (and the selection it acts on) in the editor.
    formatToolbar.addEventListener('mousedown', (e) => {
        if (e.target.closest('.tool, .tool-menu-item')) e.preventDefault();
    });
    document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('.tool-menu-wrap')) closeMenus();
    });
    window.addEventListener('resize', () => {
        if (editing) syncRovingItem();
        placeToolbar();
    });
    // The floating Edit controls change width as Save, Revert and Follow come and go.
    if (isDesktop && typeof ResizeObserver === 'function') {
        new ResizeObserver(() => placeToolbar()).observe(document.querySelector('.topbar'));
    }
    if (!isDesktop) {
        window.addEventListener('beforeunload', (e) => {
            if (!hasUnsavedChanges()) return;
            e.preventDefault();
            e.returnValue = '';
        });
    }
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
    document.addEventListener('visibilitychange', () => {
        if (webWatched) webWatched.poller.setVisible(!document.hidden);
    });

    // For tests and verification: open a FileSystemFileHandle (e.g. one from the Origin Private
    // File System) as if it had been picked.
    window.MarkyApp = Object.freeze({ openFileHandle });

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
        } else if (webWatch.picker) {
            pickFileHandle();
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
                leaveEditor().then(left => {
                    if (left) handleDesktopDrop(paths);
                });
            }
        });

        // ⌃Tab / ⌃⇧Tab switch tabs; the webview gets these keys before the menu.
        document.addEventListener('keydown', (e) => {
            const direction = core.tabStepForKey(e);
            if (!direction) return;
            e.preventDefault();
            invoke('select_tab', { direction }).catch(console.error);
        });

        await loadPendingDocument();
    }

    async function loadPendingDocument() {
        try {
            const pending = await invoke('take_pending_document');
            if (!pending) return;
            if (pending.folder) {
                // A folder opened from Finder or `open -a`: offer its files, and watching it.
                // With none to offer, go back to the drop zone so the window counts as idle.
                const offered = await handleDesktopDrop([pending.folder]);
                if (!offered && !currentSource) showDropZone();
                return;
            }
            if (isFollowingFolder() && isInFolder(pending.path)) {
                // Opened from inside the folder this window follows: switch to it, keep following.
                await showFolderFile(pending, null);
                return;
            }
            watchGeneration++;
            closeFileSelector();
            desktopFolder = null;
            renderWatchFolderButton();
            await showDesktopDocument(pending);
        } catch (err) {
            showDropZone();
            alert(String(err));
        }
    }

    /** Shows the markdown in dropped files/folders. Returns false when there was none. */
    async function handleDesktopDrop(paths) {
        if (!paths || paths.length === 0) return false;
        const entries = await invoke('list_markdown_files', { paths });
        if (entries.length === 0) {
            alert('No markdown files found. Drop a .md or .markdown file, or a folder containing them.');
            return false;
        }
        if (entries.length === 1) {
            closeFileSelector();
            desktopFolder = null;
            renderWatchFolderButton();
            await loadDesktopPath(entries[0].path);
            return true;
        }
        // One dropped item with several files in it is a folder, which can be watched.
        const root = paths.length === 1 ? paths[0].replace(/(.)\/+$/, '$1') : null;
        desktopFolder = root ? { root, name: core.basename(root), following: false } : null;
        showFileSelector(entries.map(entry => ({
            name: core.basename(entry.path),
            display: entry.display,
            path: entry.path,
            load: () => loadDesktopPath(entry.path),
        })), () => openAllAsTabs(entries.map(entry => entry.path)));
        return true;
    }

    /**
     * Opens every file from the selector, each in its own tab: the first in
     * this window if it isn't showing a document, the rest beside it.
     */
    async function openAllAsTabs(paths) {
        closeFileSelector();
        // The files open as tabs of their own, so this window stops offering (or following)
        // the folder. The app has to know that before it places them, or it keeps routing
        // them here: so it's awaited, and carries a watch generation that also supersedes a
        // folder watch still starting.
        desktopFolder = null;
        renderWatchFolderButton();
        if (currentSource && currentSource.kind === 'desktop' && currentSource.path) {
            showMarkdownContent(currentSource.title);
            await watchDesktopDocument(currentSource.path);
        } else {
            // Back to idle, so the first file lands here.
            dropZone.style.display = 'flex';
            await invoke('set_document_open', { open: false, title: null, path: null, generation: ++watchGeneration })
                .catch(console.error);
        }
        invoke('open_documents', { paths }).catch(console.error);
    }

    /** Shows a file picked by hand. In a watched folder this pins it: the window stops switching. */
    async function loadDesktopPath(path) {
        // A folder watch still starting is no longer wanted.
        watchGeneration++;
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
        // Something else was shown (or the drop zone) while this rendered: don't watch it.
        if (!isShowingPath(doc.path)) return;
        setLive(true);
        selectFileInList(doc.path);
        await watchDesktopDocument(doc.path);
    }

    /** Starts live reload for the document on screen, catching up if it changed meanwhile. */
    async function watchDesktopDocument(path) {
        const generation = ++watchGeneration;
        try {
            const now = await invoke('watch_document', { path, generation });
            if (generation !== watchGeneration || !isShowingPath(path)) return;
            if (now) {
                onDocumentChanged(now);
            } else {
                showMissingNotice();
            }
        } catch (err) {
            if (generation === watchGeneration) console.error('Live reload unavailable:', err);
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
        if (editing) {
            dispatchEdit({ type: 'disk', content: doc.content, text: editorText() });
            return;
        }
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
        if (!desktopFolder || !path) return false;
        const root = desktopFolder.root;
        return path.startsWith(root.endsWith('/') ? root : root + '/');
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
        // Following switches files by itself, which the editor can't: back to the rendered view
        // first (asking about unsaved changes).
        if (editing) {
            await finishEditing();
            if (editing || !desktopFolder || desktopFolder.following) return;
        }
        const generation = ++watchGeneration;
        try {
            const result = await invoke('watch_folder', { path: desktopFolder.root, generation });
            // A file was pinned or opened, or the window went back to the drop zone, meanwhile.
            if (generation !== watchGeneration || !desktopFolder) return;
            desktopFolder = { root: result.root, name: result.name, following: true };
            renderWatchFolderButton();
            if (result.document) {
                await showFolderFile(result.document, null, { fresh: true });
            }
        } catch (err) {
            if (generation === watchGeneration) alert(String(err));
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

    /**
     * Tells the app what this window shows; the path lets it tell same-named tabs apart, and
     * `edited` marks the title while there are unsaved changes.
     */
    function setDocumentOpen(open, title, path) {
        if (!isDesktop) return;
        // Closing stops the window's watch, which is a watch request of its own.
        const generation = open ? null : ++watchGeneration;
        const edited = open && hasUnsavedChanges();
        invoke('set_document_open', { open, title: title || null, path: path || null, generation, edited }).catch(console.error);
    }

    // ------------------------------------------------------------------
    // Web file / folder input
    // ------------------------------------------------------------------

    function handleDrop(e) {
        const items = e.dataTransfer.items;
        const files = Array.from(e.dataTransfer.files || []);
        // Everything from the DataTransfer has to be taken now: it's emptied once this
        // handler returns, so the handle is requested before any await.
        const item = items && items.length > 0 ? items[0] : null;
        const handlePromise = item && item.kind === 'file' && webWatch.dropHandles
            ? item.getAsFileSystemHandle()
            : null;
        if (item && item.webkitGetAsEntry) {
            const entry = item.webkitGetAsEntry();
            if (entry && entry.isDirectory) {
                // Folders are read once, as before.
                handleFolder(entry);
                return;
            }
        }
        if (handlePromise) {
            handlePromise.then(
                handle => (handle && handle.kind === 'file' ? openFileHandle(handle) : handleFiles(files)),
                () => handleFiles(files)
            );
            return;
        }
        handleFiles(files);
    }

    function handleFiles(files) {
        if (!files || files.length === 0) return;
        const file = files[0];
        if (!core.isTextFile(file)) {
            alert('Please select a markdown (.md) or text file.');
            return;
        }
        stopWebWatch();
        folderFiles.clear();
        file.text().then(
            text => renderMarkdown(text, { kind: 'file', dir: '', title: file.name }),
            () => alert('Error loading the markdown file. Please try again.')
        );
    }

    async function handleFolder(folderEntry) {
        try {
            stopWebWatch();
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

    // ------------------------------------------------------------------
    // Web: files opened through a handle, reloaded when they change
    // ------------------------------------------------------------------

    const PICKER_TYPES = [{
        description: 'Markdown or text',
        accept: { 'text/markdown': core.MARKDOWN_EXTENSIONS, 'text/plain': ['.txt'] },
    }];

    async function pickFileHandle() {
        let handles;
        try {
            handles = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
        } catch (err) {
            if (err && err.name === 'AbortError') return; // the picker was cancelled
            console.error('File picker unavailable, using the file input:', err);
            fileInput.click();
            return;
        }
        if (handles && handles[0]) await openFileHandle(handles[0]);
    }

    /** Shows the file behind a FileSystemFileHandle and reloads it when it changes. */
    async function openFileHandle(handle) {
        let file;
        try {
            file = await handle.getFile();
        } catch (err) {
            console.error('Error opening file:', err);
            alert('Error loading the markdown file. Please try again.');
            return;
        }
        if (!core.isTextFile(file)) {
            alert('Please select a markdown (.md) or text file.');
            return;
        }
        stopWebWatch();
        folderFiles.clear();
        let text;
        try {
            text = await file.text();
        } catch (_) {
            alert('Error loading the markdown file. Please try again.');
            return;
        }
        // The handle saves edits in place (#7's live reload watches it too).
        const source = { kind: 'file', dir: '', title: file.name, handle };
        await renderMarkdown(text, source);
        if (currentSource !== source || isDesktop) return;
        startWebWatch(handle, file, webWatch.observer);
    }

    /** Watches a handle: with FileSystemObserver when `observe`, otherwise by polling. */
    function startWebWatch(handle, file, observe) {
        const watched = { handle, poller: null, observer: null };
        const isCurrent = () => webWatched === watched && currentSource && currentSource.kind === 'file';
        watched.poller = core.createFilePoller({
            getFile: () => handle.getFile(),
            observe,
            onChange: async (changed) => {
                if (!isCurrent()) return;
                hideMissingNotice();
                let text;
                try {
                    text = await changed.text();
                } catch (_) {
                    return;
                }
                if (!isCurrent()) return;
                if (editing) {
                    dispatchEdit({ type: 'disk', content: text, text: editorText() });
                    return;
                }
                if (text === currentSource.markdown) return;
                renderMarkdown(text, { ...currentSource }, { reload: true });
            },
            onUnavailable: () => {
                if (isCurrent()) showMissingNotice();
            },
        });
        webWatched = watched;
        setLive(true);
        watched.poller.start(file);
        watched.poller.setVisible(!document.hidden);
        if (observe) {
            try {
                // A record means the file changed even when its size and timestamp didn't.
                watched.observer = new window.FileSystemObserver(() => watched.poller.check({ force: true }));
                Promise.resolve(watched.observer.observe(handle)).catch(() => pollInstead(watched));
            } catch (_) {
                pollInstead(watched);
            }
        }
    }

    /** The observer can't watch this handle: poll it instead. */
    function pollInstead(watched) {
        if (webWatched !== watched) return;
        watched.poller.stop();
        if (watched.observer) watched.observer.disconnect();
        webWatched = null;
        const isCurrent = () => !webWatched && currentSource && currentSource.kind === 'file';
        watched.handle.getFile().then(file => {
            if (isCurrent()) startWebWatch(watched.handle, file, false);
        }, () => {
            // Can't be observed or read: nothing is watching it any more.
            if (isCurrent()) {
                setLive(false);
                showMissingNotice();
            }
        });
    }

    function stopWebWatch() {
        if (!webWatched) return;
        webWatched.poller.stop();
        if (webWatched.observer) webWatched.observer.disconnect();
        webWatched = null;
        if (!isDesktop) setLive(false);
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
        imageBlobUrls = new Map();
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
        const editorAtStart = editing;
        currentSource = source;
        if (!reload) {
            documentSeq++;
            revokeBlobUrls();
        }

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
            // A different document replaces the one being edited. Every way to get here asks
            // about unsaved changes first (leaveEditor).
            if (editing && editing === editorAtStart) closeEditor();
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

    /**
     * While editing: the top bar, the formatting toolbar under it and (on desktop, where it's
     * sticky too) the conflict banner, which cover the editor's top.
     */
    function editorTopInset() {
        const covers = [formatToolbar];
        if (!editBanner.hidden && getComputedStyle(editBanner).position === 'sticky') covers.push(editBanner);
        const bottoms = covers.map(el => el.getBoundingClientRect()).filter(rect => rect.height > 0).map(rect => rect.bottom);
        return Math.max(topInset(), ...bottoms);
    }

    /**
     * Desktop: the toolbar sits beside the floating Edit controls, or below them when the
     * window is too narrow for both (the controls are fixed over the page, so it would slide
     * under them).
     */
    function placeToolbar() {
        if (!isDesktop || !editing) return;
        document.body.classList.remove('toolbar-below');
        const controls = document.querySelector('.topbar').getBoundingClientRect();
        if (controls.width > 0 && formatToolbar.getBoundingClientRect().right > controls.left - 8) {
            document.body.classList.add('toolbar-below');
        }
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
        if (e.type === 'keydown' && (!SCROLL_KEYS.has(e.key) || e.target.closest('button, input, textarea, select, [contenteditable]'))) return;
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
            // Linked markdown opens in a new tab, like double-clicking it.
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
    // Editing the markdown source
    // ------------------------------------------------------------------

    function hasUnsavedChanges() {
        return Boolean(editing && editing.state.dirty);
    }

    /** ⌘E / Ctrl+E toggles editing; ⌘S / Ctrl+S saves while editing. */
    function onEditShortcut(e) {
        const action = core.editorShortcut(e, IS_MAC);
        // ⌘/ before the formatting shortcuts: where / is Shift+7 it's also ⌘⇧7 (numbered list).
        if (action !== 'mode' && editing && window.MarkyFormat && lightbox.style.display !== 'block') {
            const command = window.MarkyFormat.shortcutCommand(e, IS_MAC);
            if (command) {
                // Before the editor's own keymap (⌘I there selects the enclosing syntax).
                e.preventDefault();
                e.stopPropagation();
                closeMenus();
                runFormat(command);
                return;
            }
        }
        if (!action || !currentSource || lightbox.style.display === 'block') return;
        if (action === 'toggle') {
            e.preventDefault();
            if (!editButton.hidden && !editButton.disabled) toggleEditing();
        } else if (action === 'mode') {
            if (!editing) return;
            // Before the editor's own keymap (⌘/ there toggles an HTML comment).
            e.preventDefault();
            e.stopPropagation();
            setEditorMode(editorMode === 'rich' ? 'markdown' : 'rich');
        } else if (editing) {
            e.preventDefault();
            saveDocument();
        }
    }

    /**
     * Loads the editor bundle and the toolbar's commands (once), which set window.MarkyCodeMirror
     * and window.MarkyFormat. Resolves to MarkyCodeMirror.
     */
    function loadCodeMirror() {
        if (window.MarkyCodeMirror && window.MarkyFormat) return Promise.resolve(window.MarkyCodeMirror);
        if (!codeMirrorLoad) {
            codeMirrorLoad = Promise.all([
                loadScript(CODEMIRROR_SRC, 'MarkyCodeMirror'),
                loadScript(FORMAT_SRC, 'MarkyFormat'),
            ]).then(([cm]) => cm);
            // A failed load can be retried.
            codeMirrorLoad.catch(() => {
                codeMirrorLoad = null;
            });
        }
        return codeMirrorLoad;
    }

    /** Adds a script to the page, resolving to the global `name` it sets. */
    function loadScript(src, name) {
        if (window[name]) return Promise.resolve(window[name]);
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => (window[name] ? resolve(window[name]) : reject(new Error('The editor did not load')));
            script.onerror = () => {
                script.remove();
                reject(new Error(`Could not load ${src}`));
            };
            document.head.appendChild(script);
        });
    }

    function toggleEditing() {
        if (editing) {
            finishEditing();
        } else {
            startEditing().catch(err => {
                console.error('Could not start editing:', err);
                alert(`Could not open the editor: ${err && err.message ? err.message : err}`);
            });
        }
    }

    /** Edit: swaps the rendered view for the markdown, with the cursor where the reader was. */
    async function startEditing() {
        if (editing || !currentSource || typeof currentSource.markdown !== 'string') return;
        const seq = documentSeq;
        editButton.disabled = true;
        try {
            // A followed folder switches files by itself; editing pins the one on screen, which
            // is also the document the app then lets this window save.
            if (isFollowingFolder() && currentSource.path) {
                desktopFolder.following = false;
                renderWatchFolderButton();
                await watchDesktopDocument(currentSource.path);
            }
            const cm = await loadCodeMirror();
            if (seq !== documentSeq || editing || !currentSource) return;

            const text = currentSource.markdown;
            const raws = rendered ? rendered.blocks.map(block => block.raw) : [];
            const anchor = rendered && markdownContent.style.display !== 'none' ? captureAnchor() : null;
            const separator = core.lineSeparator(text);
            const session = { cm, separator, view: null, state: null, saving: null };
            session.state = core.editReducer(null, { type: 'open', content: text }).state;
            editorHost.replaceChildren();
            session.view = cm.createEditor(editorHost, text, editorOptions(session));
            editing = session;
            setUpToolbar();

            markdownContent.style.display = 'none';
            editorHost.hidden = false;
            document.body.classList.add('editing');
            anchorHold = null;
            renderEditControls();
            renderToolbar();
            placeToolbar();

            const pos = docPosition(text, core.blockOffset(raws, text, anchor ? anchor.index : 0), separator);
            session.view.dispatch({
                selection: { anchor: pos },
                effects: cm.EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }),
            });
            session.view.focus();
        } finally {
            editButton.disabled = false;
        }
    }

    /** Done: back to the rendered view, near where the cursor was. Unsaved changes are asked about. */
    async function finishEditing() {
        if (!editing) return;
        editButton.disabled = true;
        let left;
        try {
            left = await leaveEditor();
        } finally {
            editButton.disabled = false;
        }
        if (!left) return;
        // leaveEditor kept the editor open for this: it shows what's saved.
        const session = editing;
        if (!session || !currentSource) return;
        const text = session.state.base;
        const head = session.view.state.selection.main.head;
        const offset = textOffset(session.view.state, head, session.separator);
        closeEditor();
        const source = { ...currentSource, markdown: text };
        await renderMarkdown(text, source);
        if (currentSource !== source || !rendered) return;
        const index = core.blockIndexAt(rendered.blocks.map(block => block.raw), text, offset);
        if (index !== null && index > 0) scrollToBlockTop(index);
    }

    /**
     * Asks before unsaved changes are thrown away (Open another, Done, a drop, closing).
     * Resolves true when it's fine to go on: nothing was unsaved, or the reader chose to
     * discard. Discarding drops the changes; the editor stays open for the caller to close.
     */
    async function leaveEditor() {
        // A save still being written finishes first: discarding meanwhile would let it write
        // the discarded text, and what's unsaved is only known once it's done.
        if (editing && editing.saving) await editing.saving;
        if (!hasUnsavedChanges()) return true;
        if (!(await confirmDiscard())) return false;
        if (editing) dispatchEdit({ type: 'revert' });
        return true;
    }

    async function confirmDiscard() {
        const name = currentSource ? currentSource.title : '';
        if (isDesktop) {
            try {
                return await invoke('confirm_discard', { name });
            } catch (err) {
                console.error('Could not ask about unsaved changes:', err);
            }
        }
        return window.confirm(name ? `Discard your unsaved changes to ${name}?` : 'Discard your unsaved changes?');
    }

    /** createEditor's options for `session`: its line breaks, and keeping the page in step with it. */
    function editorOptions(session) {
        return {
            lineSeparator: session.separator,
            onChange: () => {
                if (editing === session) dispatchEdit({ type: 'edit', text: editorText() });
            },
            onUpdate: () => {
                if (editing === session) renderToolbar();
            },
            topInset: editorTopInset,
            mode: editorMode,
            isMac: IS_MAC,
            resolveImage: editorImageSrc,
            openLink: openEditorLink,
            renderInline: (markdown) => marked.parseInline(markdown),
        };
    }

    // ------------------------------------------------------------------
    // Rich mode and the Rich | Markdown switch
    // ------------------------------------------------------------------

    function loadEditorMode() {
        try {
            return window.localStorage.getItem(MODE_KEY) === 'markdown' ? 'markdown' : 'rich';
        } catch (_) {
            return 'rich';
        }
    }

    /**
     * Switches the editor between Rich and Markdown. It's the same document with other
     * decorations, so the text, cursor, selection and undo history stay as they are; the line
     * at the top of the window stays there.
     */
    function setEditorMode(mode) {
        editorMode = mode;
        try {
            window.localStorage.setItem(MODE_KEY, mode);
        } catch (_) {
            // Private browsing: remembered for this page only.
        }
        renderModeSwitch();
        if (!editing) return;
        const view = editing.view;
        const top = editorTopInset();
        const line = view.lineBlockAtHeight(top - view.documentTop);
        const offset = view.documentTop + line.top - top;
        editing.cm.setMode(view, mode);
        // After CodeMirror's measure, which may already have scrolled to keep the line at the
        // top of the window in place: only what's left is corrected.
        view.requestMeasure({
            read: () => null,
            write: () => queueMicrotask(() => {
                if (editing === null || editing.view !== view) return;
                const moved = view.documentTop + view.lineBlockAt(line.from).top - top - offset;
                if (Math.abs(moved) > 1) window.scrollBy(0, moved);
            }),
        });
    }

    function renderModeSwitch() {
        modeSwitch.hidden = !editing;
        modeSwitch.querySelectorAll('[data-mode]').forEach(button => {
            const on = button.dataset.mode === editorMode;
            button.setAttribute('aria-checked', String(on));
            button.tabIndex = on ? 0 : -1;
            button.title = `${button.dataset.mode === 'rich' ? 'Rich: formatted as you type' : 'Markdown: the plain source'} (${IS_MAC ? '⌘/' : 'Ctrl+/'})`;
        });
    }

    function onModeSwitchClick(e) {
        const button = e.target.closest('[data-mode]');
        if (!button) return;
        let mode = button.dataset.mode;
        // On a phone only the current mode shows: pressing it switches.
        const other = modeSwitch.querySelector(`[data-mode]:not([data-mode="${mode}"])`);
        if (mode === editorMode && other.getClientRects().length === 0) mode = other.dataset.mode;
        if (mode !== editorMode) setEditorMode(mode);
        if (editing) editing.view.focus();
    }

    /** A radio group: the arrow keys pick the other mode. */
    function onModeSwitchKeydown(e) {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        setEditorMode(editorMode === 'rich' ? 'markdown' : 'rich');
        const checked = modeSwitch.querySelector('[aria-checked="true"]');
        if (checked && checked.getClientRects().length) checked.focus();
    }

    /**
     * An image's URL in Rich mode, resolved as the rendered view resolves it (resolveImages):
     * from the dropped folder, or through the asset protocol on the desktop.
     */
    function editorImageSrc(src) {
        if (!src || core.isExternalUrl(src) || !currentSource) return src;
        const path = core.resolveRelativePath(currentSource.dir, src);
        if (!path) return src;
        if (currentSource.kind === 'folder') {
            const file = folderFiles.get(path);
            if (!file) return src;
            // Widgets are redrawn as they scroll into view: one URL per file.
            if (!imageBlobUrls.has(file)) imageBlobUrls.set(file, blobUrlFor(file));
            return imageBlobUrls.get(file);
        }
        if (currentSource.kind === 'desktop') {
            // Widgets are redrawn as they scroll into view: each file is allowed once.
            if (!allowedAssets.has(path)) {
                allowedAssets.set(path, invoke('allow_asset_files', { paths: [path] })
                    .catch(err => console.error('Could not allow local images:', err)));
            }
            return allowedAssets.get(path).then(() => tauri.core.convertFileSrc(path));
        }
        return src;
    }

    /** A link ⌘-clicked (Ctrl-clicked) in Rich mode, handled as in the rendered view. */
    function openEditorLink(href) {
        switch (core.classifyLink(href)) {
            case 'anchor':
                scrollEditorToAnchor(href);
                break;
            case 'external':
                openExternal(href);
                break;
            case 'relative': {
                // Another file of a dropped folder replaces this one: leave the editor first.
                const path = currentSource && core.resolveRelativePath(currentSource.dir, href);
                if (currentSource && currentSource.kind === 'folder' && path && core.isMarkdownName(path)) {
                    leaveEditor().then(left => {
                        if (!left) return;
                        closeEditor();
                        openRelative(href);
                    });
                } else {
                    openRelative(href);
                }
                break;
            }
        }
    }

    /** An HTML entity (&amp;) as the text it stands for. */
    function decodeEntity(entity) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = entity;
        return textarea.value;
    }

    /** #anchor in the editor: the cursor goes to the heading with that id (as refreshHeadingIds names them). */
    function scrollEditorToAnchor(href) {
        if (!editing) return;
        let id = href.slice(1);
        try {
            id = decodeURIComponent(id);
        } catch (_) {
            // use raw id
        }
        const used = new Set();
        const heading = editing.cm.headings(editing.view.state, decodeEntity).find(h => core.uniqueSlug(h.text, used) === id);
        if (!heading) return;
        editing.view.dispatch({
            selection: { anchor: heading.from },
            effects: editing.cm.EditorView.scrollIntoView(heading.from, { y: 'start', yMargin: 24 }),
        });
        editing.view.focus();
    }

    /** Removes the editor (and its unsaved changes, if any) without asking. */
    function closeEditor() {
        if (!editing) return;
        const session = editing;
        editing = null;
        closeMenus();
        session.view.destroy();
        editorHost.replaceChildren();
        editorHost.hidden = true;
        document.body.classList.remove('editing');
        renderEditControls();
    }

    /** The editor's text, with the document's own line breaks. */
    function editorText() {
        return editing ? editing.view.state.sliceDoc() : '';
    }

    /** Runs an event through core.editReducer and applies what it says to the editor. */
    function dispatchEdit(event) {
        if (!editing) return;
        const session = editing;
        const result = core.editReducer(session.state, event);
        session.state = result.state;
        if (result.apply !== null) replaceEditorText(session, result.apply);
        renderEditControls();
    }

    /**
     * Puts `text` in the editor as one minimal change (only the span that differs), so the
     * cursor, selection and undo history survive. Text with other line breaks than the editor's
     * replaces the editor's state outright.
     */
    function replaceEditorText(session, text) {
        const view = session.view;
        if (core.lineSeparator(text) !== session.separator) {
            const offset = textOffset(view.state, view.state.selection.main.head, session.separator);
            editorHost.replaceChildren();
            view.destroy();
            session.separator = core.lineSeparator(text);
            session.view = session.cm.createEditor(editorHost, text, editorOptions(session));
            const pos = Math.min(docPosition(text, offset, session.separator), session.view.state.doc.length);
            session.view.dispatch({ selection: { anchor: pos } });
            return;
        }
        // CodeMirror counts a line break as one position, whatever the separator.
        const flat = (value) => (session.separator === '\r\n' ? value.split('\r\n').join('\n') : value);
        const change = core.textChange(flat(view.state.sliceDoc()), flat(text));
        if (!change) return;
        view.dispatch({
            changes: change,
            annotations: session.cm.Transaction.addToHistory.of(false),
        });
    }

    /** Editor position of a text offset (the two differ by one per '\r\n' line break). */
    function docPosition(text, offset, separator) {
        if (separator !== '\r\n') return offset;
        return offset - text.slice(0, offset).split('\r\n').length + 1;
    }

    /** Text offset of an editor position. */
    function textOffset(state, pos, separator) {
        return separator === '\r\n' ? pos + state.doc.lineAt(pos).number - 1 : pos;
    }

    /** How the editor saves: in place (desktop, or a writable file handle), or as a download. */
    function saveMode() {
        if (isDesktop) return 'save';
        const handle = currentSource && currentSource.handle;
        return handle && typeof handle.createWritable === 'function' ? 'save' : 'download';
    }

    async function saveDocument() {
        if (!editing || editing.saving || !currentSource) return;
        const session = editing;
        if (!session.state.dirty) return;
        session.saving = writeSession(session, currentSource);
        renderEditControls();
        try {
            await session.saving;
        } finally {
            session.saving = null;
            renderEditControls();
        }
    }

    /** Writes the editor's text (saveDocument). Never rejects: failures are reported here. */
    async function writeSession(session, source) {
        const content = editorText();
        const base = session.state.base;
        let writable = null;
        try {
            const mode = saveMode();
            if (isDesktop) {
                await invoke('write_document', { path: source.path, base, content });
            } else if (mode === 'save') {
                const current = await (await source.handle.getFile()).text();
                if (current !== base) {
                    if (editing === session) dispatchEdit({ type: 'saveConflict', content: current, text: editorText() });
                    return;
                }
                // Left meanwhile (the drop zone): nothing to save any more.
                if (editing !== session) return;
                writable = await source.handle.createWritable();
                await writable.write(content);
                // The permission prompt may have been up for a while: a change from elsewhere
                // meanwhile still wins, and the file is left as it is.
                const now = await (await source.handle.getFile()).text();
                if (now !== base) {
                    if (editing === session) dispatchEdit({ type: 'saveConflict', content: now, text: editorText() });
                    return;
                }
                const closing = writable;
                writable = null;
                await closing.close();
            } else {
                downloadText(content, source.title);
            }
            if (editing === session) dispatchEdit({ type: 'saved', content, text: editorText() });
        } catch (err) {
            if (err && err.kind === 'conflict' && editing === session) {
                dispatchEdit({ type: 'saveConflict', content: err.content, text: editorText() });
                return;
            }
            if (err && err.name === 'AbortError') return; // the browser's permission prompt was declined
            console.error('Save failed:', err);
            alert(`Could not save: ${err && err.message ? err.message : err}`);
        } finally {
            // Not closed: drop what was written, and the lock on the file with it.
            if (writable) writable.abort().catch(() => {});
        }
    }

    /** Web without a writable handle: saves a copy under the original file name. */
    function downloadText(text, name) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = name || 'document.md';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    /** Edit / Done, Save, Revert, the conflict banner, the unsaved-changes mark and close guard. */
    function renderEditControls() {
        const on = Boolean(editing);
        const dirty = hasUnsavedChanges();
        editLabel.textContent = on ? 'Done' : 'Edit';
        editButton.setAttribute('aria-pressed', String(on));
        editButton.title = on
            ? `Back to the rendered view (${IS_MAC ? '⌘E' : 'Ctrl+E'})`
            : `Edit the markdown (${IS_MAC ? '⌘E' : 'Ctrl+E'})`;
        saveButton.hidden = !on;
        revertButton.hidden = !on;
        renderModeSwitch();
        editBanner.hidden = !(on && editing.state.conflict !== null);
        if (on) {
            const download = saveMode() === 'download';
            saveButton.textContent = download ? 'Download' : 'Save';
            saveButton.title = download
                ? 'This browser can\'t save in place: download a copy'
                : `Save (${IS_MAC ? '⌘S' : 'Ctrl+S'})`;
            saveButton.disabled = !dirty || Boolean(editing.saving);
            // Dropping the changes waits for the save being written, which would write them.
            revertButton.disabled = Boolean(editing.saving) || (!dirty && editing.state.conflict === null);
            bannerReload.disabled = Boolean(editing.saving);
            bannerKeep.disabled = Boolean(editing.saving);
        }
        if (dirty !== titleMarked && currentSource) showTitle(currentSource.title);
        syncCloseGuard(dirty);
    }

    /** Desktop: while there are unsaved changes, closing the window asks first. */
    function syncCloseGuard(dirty) {
        if (!isDesktop || !tauri.window) return;
        if (dirty && !closeGuard) {
            const guard = tauri.window.getCurrentWindow().onCloseRequested(async (event) => {
                if (!(await leaveEditor())) event.preventDefault();
            });
            closeGuard = guard;
            guard.catch(err => {
                console.error('Could not guard closing the window:', err);
                if (closeGuard === guard) closeGuard = null;
            });
        } else if (!dirty && closeGuard) {
            const guard = closeGuard;
            closeGuard = null;
            guard.then(unlisten => unlisten(), () => {});
        }
    }

    // ------------------------------------------------------------------
    // Formatting toolbar
    // ------------------------------------------------------------------

    /** Applies a formatting command (format.js) to the editor's text and selection, as one undoable change. */
    function runFormat(command) {
        if (!editing || !window.MarkyFormat) return;
        const view = editing.view;
        const state = view.state;
        // Positions count a line break as one character, as in the editor; '\r\n' comes back
        // on the way in.
        const text = state.doc.toString();
        const main = state.selection.main;
        const out = window.MarkyFormat.apply(command, { text, selection: { anchor: main.anchor, head: main.head } });
        // Only the span that differs, so nothing outside what the command touched changes.
        const change = core.textChange(text, out.text);
        view.dispatch({
            changes: change ? { from: change.from, to: change.to, insert: change.insert.split('\n').join(state.lineBreak) } : [],
            selection: out.selection,
            scrollIntoView: true,
            userEvent: 'input.format',
        });
        view.focus();
    }

    /** Fills in the tooltips and shortcuts (they depend on the platform). Once. */
    function setUpToolbar() {
        if (toolbarReady) return;
        toolbarReady = true;
        const format = window.MarkyFormat;
        formatToolbar.querySelectorAll('[data-command]').forEach(el => {
            const command = el.dataset.command;
            const shortcut = format.shortcutLabel(command, IS_MAC);
            if (!shortcut) return;
            el.setAttribute('aria-keyshortcuts', format.ariaKeyShortcuts(command, IS_MAC));
            if (el.classList.contains('tool')) {
                el.title = `${el.getAttribute('aria-label')} (${shortcut})`;
            } else {
                const hint = document.createElement('span');
                hint.className = 'tool-shortcut';
                hint.setAttribute('aria-hidden', 'true');
                hint.textContent = shortcut;
                el.appendChild(hint);
            }
        });
        // One tab stop, on the first item (the block style menu, which never overflows).
        setRovingItem(formatToolbar.querySelector('[data-tool]'));
    }

    /** Shows the formatting at the cursor: pressed buttons, checked menu items, the block style. */
    function renderToolbar() {
        if (!editing || !editing.cm.formatState) return;
        const state = editing.cm.formatState(editing.view.state);
        const isOn = (command) => {
            if (command.startsWith('block:')) return state.block === command.slice(6);
            if (command === 'bulletList') return state.list === 'bullet';
            if (command === 'orderedList') return state.list === 'ordered';
            if (command === 'taskList') return state.list === 'task';
            return Boolean(state[command]);
        };
        formatToolbar.querySelectorAll('[data-command]').forEach(el => {
            const on = String(isOn(el.dataset.command));
            const attribute = el.hasAttribute('aria-pressed') ? 'aria-pressed' : 'aria-checked';
            if (el.getAttribute(attribute) !== on) el.setAttribute(attribute, on);
        });
        const name = BLOCK_NAMES[state.block] || BLOCK_NAMES.paragraph;
        if (blockLabel.textContent !== name) blockLabel.textContent = name;
        blockButton.setAttribute('aria-label', `Block style: ${name}`);
    }

    function onToolbarClick(e) {
        const menuButton = e.target.closest('[aria-haspopup="menu"]');
        if (menuButton) {
            const menu = $(menuButton.getAttribute('aria-controls'));
            if (menu.hidden) openMenu(menuButton, menu, 'checked');
            else closeMenus();
            return;
        }
        const item = e.target.closest('[data-command]');
        if (!item) return;
        closeMenus();
        runFormat(item.dataset.command);
    }

    /** The toolbar's items on screen (the overflow hides some), for arrow keys and tabindex. */
    function toolbarItems() {
        return [...formatToolbar.querySelectorAll('[data-tool]')].filter(el => el.getClientRects().length > 0);
    }

    /** Roving tabindex: only `item` is in the tab order, so Tab enters and leaves the toolbar in one step. */
    function setRovingItem(item) {
        formatToolbar.querySelectorAll('[data-tool]').forEach(el => {
            el.tabIndex = el === item ? 0 : -1;
        });
    }

    /** Keeps the tab stop on an item that's on screen (the overflow changes with the width). */
    function syncRovingItem() {
        const items = toolbarItems();
        const current = items.find(el => el.tabIndex === 0);
        if (!current && items.length) setRovingItem(items[0]);
    }

    function onToolbarKeydown(e) {
        const menu = e.target.closest('[role="menu"]');
        if (menu) {
            onMenuKeydown(e, menu);
            return;
        }
        if (!e.target.matches('[data-tool]')) return;
        if (e.target.getAttribute('aria-haspopup') === 'menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openMenu(e.target, $(e.target.getAttribute('aria-controls')), e.key === 'ArrowDown' ? 'checked' : 'last');
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            if (editing) editing.view.focus();
            return;
        }
        if (moveAlongToolbar(e.target, e.key)) e.preventDefault();
    }

    /** Arrow keys, Home and End along the toolbar. Returns whether `key` moved the focus. */
    function moveAlongToolbar(from, key) {
        const items = toolbarItems();
        const index = items.indexOf(from);
        let next = null;
        if (key === 'ArrowRight') next = items[(index + 1) % items.length];
        else if (key === 'ArrowLeft') next = items[(index - 1 + items.length) % items.length];
        else if (key === 'Home') next = items[0];
        else if (key === 'End') next = items[items.length - 1];
        if (!next) return false;
        closeMenus();
        setRovingItem(next);
        next.focus();
        return true;
    }

    function onMenuKeydown(e, menu) {
        const items = [...menu.querySelectorAll('[role^="menuitem"]')];
        const index = items.indexOf(document.activeElement);
        const button = formatToolbar.querySelector(`[aria-controls="${menu.id}"]`);
        let next = null;
        if (e.key === 'ArrowDown') next = items[(index + 1) % items.length];
        else if (e.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
        else if (e.key === 'Home') next = items[0];
        else if (e.key === 'End') next = items[items.length - 1];
        else if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            closeMenus();
            // Left and right go on along the toolbar, as from the button.
            if (e.key === 'Escape' || !moveAlongToolbar(button, e.key)) button.focus();
            return;
        } else if (e.key === 'Tab') {
            closeMenus();
            return;
        }
        if (!next) return;
        e.preventDefault();
        next.focus();
    }

    /** Opens a toolbar menu, focusing its checked item ('checked', or the first), or its last. */
    function openMenu(button, menu, focus) {
        closeMenus();
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        const items = [...menu.querySelectorAll('[role^="menuitem"]')];
        const target = focus === 'last'
            ? items[items.length - 1]
            : items.find(item => item.getAttribute('aria-checked') === 'true' && focus === 'checked') || items[0];
        if (target) target.focus();
    }

    function closeMenus() {
        for (const menu of [blockMenu, moreMenu]) {
            if (menu.hidden) continue;
            menu.hidden = true;
            formatToolbar.querySelector(`[aria-controls="${menu.id}"]`).setAttribute('aria-expanded', 'false');
        }
    }

    /** Scrolls so block `index` sits just below the top bar. */
    function scrollToBlockTop(index) {
        const [el] = blockElements(index);
        if (!el) return;
        const top = el.getBoundingClientRect().top + window.scrollY;
        window.scrollTo(0, Math.max(0, top - topInset() - 16));
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function showMarkdownContent(title) {
        dropZone.style.display = 'none';
        if (!container.classList.contains('file-selector-active')) {
            fileSelector.style.display = 'none';
        }
        markdownContent.style.display = editing ? 'none' : 'block';
        backButton.style.display = 'inline-flex';
        fullscreenButton.style.display = 'inline-flex';
        editButton.hidden = false;
        document.body.classList.add('document-open');
        hideMissingNotice();
        showTitle(title);
    }

    /** Puts the document's title in the top bar, the page title and (desktop) the window. */
    function showTitle(title) {
        titleMarked = hasUnsavedChanges();
        const mark = titleMarked ? '• ' : '';
        docTitle.textContent = title ? mark + title : '';
        document.title = title ? `${mark}${title} - Markydowny` : DEFAULT_TITLE;
        // In a folder the title names the folder too, so the app uses it as is. Otherwise the
        // path lets the app tell same-named tabs apart.
        const path = currentSource && currentSource.kind === 'desktop' && !desktopFolder ? currentSource.path : null;
        setDocumentOpen(true, title, path);
    }

    function closeFileSelector() {
        fileSelector.style.display = 'none';
        container.classList.remove('file-selector-active');
    }

    function showDropZone() {
        dropZone.style.display = 'flex';
        markdownContent.style.display = 'none';
        closeFileSelector();
        closeEditor();
        backButton.style.display = 'none';
        fullscreenButton.style.display = 'none';
        editButton.hidden = true;
        document.body.classList.remove('document-open');

        if (container.classList.contains('fullscreen')) {
            toggleFullscreen();
        }

        folderFiles.clear();
        revokeBlobUrls();
        renderSeq++;
        documentSeq++;
        currentSource = null;
        rendered = null;
        anchorHold = null;
        hideMissingNotice();
        stopWebWatch();
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

    /**
     * entries: [{ name, display, path?, load }]
     * openAll: opens every entry as a tab (desktop), or undefined to hide that button.
     */
    function showFileSelector(entries, openAll) {
        dropZone.style.display = 'none';
        markdownContent.style.display = 'none';
        fileSelector.style.display = 'block';
        container.classList.add('file-selector-active');
        // Shown again with the file picked from the list. (A drop, the only way here while
        // editing, asked about unsaved changes first.)
        closeEditor();
        editButton.hidden = true;
        fileList.replaceChildren();
        renderWatchFolderButton();

        const openAllLabel = openAll ? core.openAllLabel(entries.length) : null;
        openAllAction = openAllLabel ? openAll : null;
        openAllTabsButton.hidden = !openAllLabel;
        if (openAllLabel) openAllTabsButton.textContent = openAllLabel;

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
            const pick = async () => {
                // The list stays up beside the document, so the file being edited can be left
                // from here.
                if (!(await leaveEditor())) return;
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
