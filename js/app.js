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
    const newFileButton = $('newFileButton');
    const restoreButton = $('restoreButton');
    const restoreLabel = $('restoreLabel');
    const openFileButton = $('openFileButton');
    const fullscreenButton = $('fullscreenButton');
    const docTitle = $('docTitle');
    const fileSelector = $('fileSelector');
    const fileList = $('fileList');
    const selectorHeading = $('selectorHeading');
    const selectorHint = $('selectorHint');
    const SELECTOR_HEADING = selectorHeading.textContent;
    const SELECTOR_HINT = selectorHint.textContent;
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
    const wordCount = $('wordCount');
    const watchFolderButton = $('watchFolderButton');
    const editButton = $('editButton');
    const editLabel = $('editLabel');
    const saveButton = $('saveButton');
    const saveAsButton = $('saveAsButton');
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
    const tableButton = $('tableButton');
    const tablePicker = $('tablePicker');
    const tableGrid = $('tableGrid');
    const tableSize = $('tableSize');
    const splitPreview = $('splitPreview');

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
    // The word count waits for a pause in typing, so a large document stays responsive.
    const WORD_COUNT_DELAY_MS = 200;
    // Insert table: the size picker's grid, columns by rows (the header row counts).
    const TABLE_PICKER_COLUMNS = 8;
    const TABLE_PICKER_ROWS = 6;
    // Phone widths (as index.html's small-screen styles), where Split isn't offered.
    const phoneWidth = window.matchMedia('(max-width: 700px)');
    const MODE_TITLES = {
        rich: 'Rich: formatted as you type',
        markdown: 'Markdown: the plain source',
        split: 'Split: the markdown beside the rendered document',
    };

    // Web folder drops: relative path (e.g. "docs/img/a.png") -> File
    const folderFiles = new Map();
    let blobUrls = [];
    // Rich mode's folder images: File -> its URL in blobUrls.
    let imageBlobUrls = new Map();
    // What is on screen: { kind: 'file' | 'folder' | 'desktop' | 'untitled', dir, title, path?,
    // handle?, markdown }. 'untitled' is a new document not yet saved anywhere.
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
    // written, a promise, or null), words ({ doc, total }: the last document counted) }.
    let editing = null;
    // While Save As is writing (saveDocumentAs), the promise of it: one at a time.
    let savingAs = null;
    let wordCountTimer = null;
    let codeMirrorLoad = null;
    let toolbarReady = false;
    // The editor's view: 'rich' (the markup styled, its markers shown on the cursor's lines),
    // 'markdown' (the plain source) or 'split' (the source beside the rendered document; shown
    // as Markdown at phone widths). Rich unless the reader last chose otherwise.
    let editorMode = loadEditorMode();
    // While the split view is on screen: { blocks, linksKey (as `rendered` has them), seq,
    // timer, frame, expectWindow, expectPreview (scroll positions set to keep the panes in step,
    // so their scroll events aren't taken for the reader's) }.
    let split = null;
    // The button the table picker was opened from, while it's open.
    let tablePickerFrom = null;
    // Desktop: images Rich mode has asked the app to serve (path -> the request's promise).
    const allowedAssets = new Map();
    // Whether the title on screen carries the unsaved-changes mark.
    let titleMarked = false;
    // Desktop: the close-requested listener (a promise of its unlisten), while there are
    // unsaved changes.
    let closeGuard = null;
    // Unsaved work kept across quits and crashes: each document with unsaved changes has a
    // backup, in the app's backups folder or (web) IndexedDB. Null where there's nowhere to keep
    // them (a browser without storage).
    const BACKUP_DB = 'markydowny';
    const BACKUP_TABLE = 'backups';
    // Web: a tab holds this lock (plus the backup's id) while its document's backup is its own,
    // so other tabs don't offer it for restoring.
    const BACKUP_LOCK = 'markydowny-backup:';
    const backupStore = isDesktop ? desktopBackupStore() : webBackupStore();
    // Web: the backups the drop zone offers to restore, newest first.
    let restoreOffer = [];

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    // A file or folder dropped anywhere on the page opens, not just one on the drop zone.
    // Anything else (text, a link, a file dropped into the editor) is the browser's to handle.
    ['dragenter', 'dragover'].forEach(eventName => document.body.addEventListener(eventName, (e) => {
        if (!isPageFileDrag(e)) {
            unhighlight();
            return;
        }
        preventDefaults(e);
        highlight();
    }, false));
    document.body.addEventListener('dragleave', (e) => {
        // Moving between the page's own elements isn't leaving it.
        if (!e.relatedTarget || !document.body.contains(e.relatedTarget)) unhighlight();
    }, false);
    document.body.addEventListener('drop', handlePageDrop, false);

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
    newFileButton.addEventListener('click', (e) => {
        e.stopPropagation();
        newDocument();
    });
    restoreButton.addEventListener('click', (e) => {
        e.stopPropagation();
        offerRestore();
    });
    openFileButton.addEventListener('click', () => {
        // Straight to the picker while the click still counts as the user's, unless there are
        // unsaved changes to ask about first.
        if (!hasUnsavedChanges() && !(editing && editing.saving)) {
            chooseFile();
            return;
        }
        leaveEditor().then(left => {
            if (left) chooseFile();
        });
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
    saveAsButton.addEventListener('click', saveDocumentAs);
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
        if (e.target.closest('.tool, .tool-menu-item, .table-cell')) e.preventDefault();
    });
    document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('.tool-menu-wrap, .table-picker, #tableButton')) closeMenus();
    });
    tableGrid.addEventListener('mouseover', (e) => {
        const cell = e.target.closest('.table-cell');
        if (cell) markTableSize(cell);
    });
    tableGrid.addEventListener('focusin', (e) => {
        const cell = e.target.closest('.table-cell');
        if (cell) markTableSize(cell);
    });
    window.addEventListener('resize', () => {
        if (editing) syncRovingItem();
        placeToolbar();
        placeSplitPreview();
    });
    // Split is offered above phone widths only: crossing that width changes the view shown.
    phoneWidth.addEventListener('change', () => applyEditorView());
    window.addEventListener('scroll', () => syncSplitSoon('editor'), { passive: true });
    splitPreview.addEventListener('scroll', () => syncSplitSoon('preview'), { passive: true });
    splitPreview.addEventListener('click', onSplitPreviewClick);
    // The floating Edit controls change width as Save, Revert and Follow come and go.
    if (isDesktop && typeof ResizeObserver === 'function') {
        new ResizeObserver(() => placeToolbar()).observe(document.querySelector('.topbar'));
    }
    if (!isDesktop) {
        // Still asks, as before. Closing anyway leaves the backup, which the next visit offers.
        window.addEventListener('beforeunload', (e) => {
            if (!hasUnsavedChanges()) return;
            e.preventDefault();
            e.returnValue = '';
        });
        window.addEventListener('pagehide', flushBackup);
        refreshRestoreOffer();
    }
    // The homepage's screenshots and markychecky clip are set up here, not in the HTML: the desktop
    // bundle doesn't ship them, and the clip plays by itself only for people who haven't asked for
    // less motion.
    if (!isDesktop) {
        for (const img of document.querySelectorAll('main > .marketing img[data-src]')) img.src = img.dataset.src;
    }
    const spotlightVideo = document.querySelector('.spotlight-video');
    if (!isDesktop && spotlightVideo) {
        spotlightVideo.autoplay = !prefersReducedMotion();
        spotlightVideo.poster = spotlightVideo.dataset.poster;
        spotlightVideo.src = spotlightVideo.dataset.src;
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
        if (document.hidden) flushBackup();
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
        document.body.classList.add('dragover');
    }

    function unhighlight() {
        dropZone.classList.remove('dragover');
        document.body.classList.remove('dragover');
    }

    /**
     * File > New and the drop zone's New file: an empty, untitled document, straight in the
     * editor. Its first save asks where to put it (writeSession). Resolves to whether it opened.
     * `restore` ({ backup, plan, lock }: core.restorePlan's 'untitled', and on the web its
     * claimed lock) reopens unsaved work as one.
     */
    async function newDocument(restore = null) {
        // The editor loads before anything unsaved is let go: loading it is what can fail.
        try {
            await loadCodeMirror();
        } catch (err) {
            console.error('Could not start editing:', err);
            alert(`Could not open the editor: ${err && err.message ? err.message : err}`);
            return false;
        }
        if (!(await leaveEditor())) return false;
        closeFileSelector();
        stopWebWatch();
        setLive(false);
        folderFiles.clear();
        if (isDesktop) {
            // A watch still starting for this window is no longer wanted.
            watchGeneration++;
            desktopFolder = null;
            renderWatchFolderButton();
        }
        const source = { kind: 'untitled', dir: '', title: restore ? restore.plan.title : core.UNTITLED_TITLE };
        // Kept in its backup, so the note comes back if it's restored again before it's saved.
        if (restore && restore.plan.missing) source.missing = true;
        await renderMarkdown('', source);
        if (currentSource !== source) return true;
        // Unsaved even when it's empty: a file emptied before it went is still a change to save.
        await startEditing(restore ? { id: restore.backup.id, text: restore.plan.text, changed: false, unsaved: true, lock: restore.lock } : null);
        // Its file was moved or deleted since: say so.
        if (restore && restore.plan.missing && currentSource === source) showMissingNotice();
        return true;
    }

    function chooseFile() {
        if (isDesktop) {
            invoke('show_open_dialog').catch(console.error);
        } else if (webWatch.picker) {
            pickFileHandle();
        } else {
            // Cleared first, so picking the file that's already open opens it again.
            fileInput.value = '';
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

        // File > Save As… (⇧⌘S). The page's own shortcut may have started it already.
        await tauri.event.listen('save-as', () => saveDocumentAs());

        // Quitting: unsaved work goes to its backup first, without asking. It's back next launch.
        await tauri.event.listen('flush-backups', async () => {
            if (editing) await writeBackup(editing);
            invoke('backups_flushed').catch(console.error);
        });

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
                    if (left) handleDesktopDrop(paths, { dropped: true });
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
            if (pending.restore) {
                // Unsaved work from before the app last quit (or crashed).
                await restoreDesktopBackup(pending.restore);
                return;
            }
            if (pending.untitled) {
                // File > New. If it can't start, the window goes back to counting as idle.
                if (!(await newDocument()) && !currentSource) showDropZone();
                return;
            }
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

    /**
     * Shows the markdown in dropped files/folders. Returns false when there was none.
     * `dropped` is a drop on the window; a pending folder was recorded by the app already.
     */
    async function handleDesktopDrop(paths, { dropped = false } = {}) {
        if (!paths || paths.length === 0) return false;
        const entries = await invoke('list_markdown_files', { paths });
        if (entries.length === 0) {
            alert('No markdown files found. Drop a .md or .markdown file, or a folder containing them.');
            return false;
        }
        // File > Open Recent lists what was dropped (other opens go through the app already).
        if (dropped) invoke('add_recent_documents', { paths }).catch(console.error);
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
                // Rendered before this resolves, so what's on screen (currentSource.markdown) is
                // the file as it is now.
                await onDocumentChanged(now);
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
     * it (highlighting its edit against the content it had before). Resolves once it's shown.
     */
    async function onDocumentChanged(doc) {
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
                await renderMarkdown(doc.content, { ...currentSource, unhighlighted: false }, { reload: true, previous: doc.previous });
            }
            return;
        }
        await renderMarkdown(doc.content, { ...currentSource, unhighlighted: false }, { reload: true });
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
        return core.isInsideFolder(desktopFolder.root, path);
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

    /** A file dragged over the page, not into the editor (the desktop app's drops are native). */
    function isPageFileDrag(e) {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return false;
        return !(e.target && e.target.closest && e.target.closest('.editor-host'));
    }

    /** A drop anywhere on the page (the desktop app gets its drops natively, as paths). */
    function handlePageDrop(e) {
        unhighlight();
        // Dragged text or a link isn't a document, and mustn't ask about unsaved changes;
        // a drop into the editor is CodeMirror's to handle.
        if (!isPageFileDrag(e)) return;
        preventDefaults(e);
        if (isDesktop) return;
        const prepare = takeDrop(e.dataTransfer);
        // Read (and rejected) before unsaved changes are discarded for it: the discard can't
        // be undone, so it waits until there's something to show instead.
        prepare().then(async show => {
            if (show && await leaveEditor()) show();
        });
    }

    /**
     * Takes what was dropped and returns a function that reads it: that resolves to a function
     * that shows it, or to null once it has said why it can't.
     */
    function takeDrop(dataTransfer) {
        const items = dataTransfer.items;
        const files = Array.from(dataTransfer.files || []);
        // Everything from the DataTransfer has to be taken now: it's emptied once the drop
        // handler returns, so the handle is requested before any await.
        const item = items && items.length > 0 ? items[0] : null;
        const handlePromise = item && item.kind === 'file' && webWatch.dropHandles
            ? item.getAsFileSystemHandle().catch(() => null)
            : null;
        if (item && item.webkitGetAsEntry) {
            const entry = item.webkitGetAsEntry();
            if (entry && entry.isDirectory) {
                // Folders are read once, as before.
                return () => readFolder(entry);
            }
        }
        if (handlePromise) {
            return () => handlePromise.then(
                handle => (handle && handle.kind === 'file' ? readFileHandle(handle) : readFiles(files))
            );
        }
        return () => readFiles(files);
    }

    function handleFiles(files) {
        return readFiles(files).then(show => show && show());
    }

    /** Reads the first of `files`, resolving to a function that shows it (or null). */
    async function readFiles(files) {
        if (!files || files.length === 0) return null;
        const file = files[0];
        if (!core.isTextFile(file)) {
            alert('Please select a markdown (.md) or text file.');
            return null;
        }
        let text;
        try {
            text = await file.text();
        } catch (_) {
            alert('Error loading the markdown file. Please try again.');
            return null;
        }
        return () => {
            closeFileSelector();
            stopWebWatch();
            folderFiles.clear();
            return renderMarkdown(text, { kind: 'file', dir: '', title: file.name });
        };
    }

    /** Reads a dropped folder, resolving to a function that shows it (or null). */
    async function readFolder(folderEntry) {
        const files = new Map();
        let markdownFiles;
        let single = null;
        try {
            await readFolderRecursively(folderEntry, '', files);
            markdownFiles = Array.from(files.entries())
                .filter(([path]) => core.isMarkdownName(path));
            if (markdownFiles.length === 1) single = await markdownFiles[0][1].text();
        } catch (error) {
            console.error('Error reading folder:', error);
            alert('Error reading folder contents. Please try again.');
            return null;
        }
        if (markdownFiles.length === 0) {
            alert('No markdown files found in this folder. Please select a folder containing .md or .markdown files.');
            return null;
        }
        return () => {
            stopWebWatch();
            folderFiles.clear();
            for (const [path, file] of files) folderFiles.set(path, file);
            if (single !== null) {
                const [path, file] = markdownFiles[0];
                closeFileSelector();
                return renderMarkdown(single, { kind: 'folder', dir: core.dirname(path), title: file.name });
            }
            showFileSelector(markdownFiles.map(([path, file]) => ({
                name: file.name,
                display: path,
                load: () => loadFolderFile(file, path),
            })));
        };
    }

    // ------------------------------------------------------------------
    // Web: files opened through a handle, reloaded when they change
    // ------------------------------------------------------------------

    const PICKER_TYPES = [{
        description: 'Markdown or text',
        accept: { 'text/markdown': core.MARKDOWN_EXTENSIONS, 'text/plain': ['.txt'] },
    }];
    // A new document's save: markdown only.
    const SAVE_TYPES = [{
        description: 'Markdown',
        accept: { 'text/markdown': core.MARKDOWN_EXTENSIONS },
    }];

    async function pickFileHandle() {
        let handles;
        try {
            handles = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
        } catch (err) {
            if (err && err.name === 'AbortError') return; // the picker was cancelled
            console.error('File picker unavailable, using the file input:', err);
            fileInput.value = '';
            fileInput.click();
            return;
        }
        if (handles && handles[0]) await openFileHandle(handles[0]);
    }

    /** Shows the file behind a FileSystemFileHandle and reloads it when it changes. */
    async function openFileHandle(handle) {
        const show = await readFileHandle(handle);
        if (show) await show();
    }

    /** Reads the file behind a handle, resolving to a function that shows and watches it (or null). */
    async function readFileHandle(handle) {
        let file;
        try {
            file = await handle.getFile();
        } catch (err) {
            console.error('Error opening file:', err);
            alert('Error loading the markdown file. Please try again.');
            return null;
        }
        if (!core.isTextFile(file)) {
            alert('Please select a markdown (.md) or text file.');
            return null;
        }
        let text;
        try {
            text = await file.text();
        } catch (_) {
            alert('Error loading the markdown file. Please try again.');
            return null;
        }
        return async () => {
            closeFileSelector();
            stopWebWatch();
            folderFiles.clear();
            // The handle saves edits in place (#7's live reload watches it too).
            const source = { kind: 'file', dir: '', title: file.name, handle };
            await renderMarkdown(text, source);
            if (currentSource !== source || isDesktop) return;
            startWebWatch(handle, file, webWatch.observer);
        };
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

    async function readFolderRecursively(entry, path, files) {
        if (entry.isFile) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            files.set(path + entry.name, file);
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            // readEntries returns results in batches; keep reading until empty.
            let batch;
            do {
                batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                for (const child of batch) {
                    await readFolderRecursively(child, path + entry.name + '/', files);
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
        const blocks = placeBlocks(markdownContent, rendered && rendered.blocks, built, diff);
        blocks.forEach((block, index) => {
            for (const node of block.nodes) {
                if (node.nodeType === Node.ELEMENT_NODE) node.dataset.block = String(index);
            }
        });
        rendered = { blocks, linksKey: built.linksKey };
        refreshHeadingIds();
    }

    /**
     * Puts built blocks in `container`, which holds `old` (or nothing), returning the blocks it
     * now holds. With a diff, only the changed blocks are swapped in (commitBlocks).
     */
    function placeBlocks(container, old, built, diff) {
        if (!diff || !old) {
            container.replaceChildren(...built.blocks.flatMap(block => block.nodes));
            return built.blocks;
        }
        for (const block of old.slice(diff.start, diff.oldEnd)) {
            block.nodes.forEach(node => node.remove());
        }
        const fresh = built.blocks.slice(diff.start, diff.end);
        const after = old.slice(diff.oldEnd).find(block => block.nodes.length > 0);
        const fragment = document.createDocumentFragment();
        fresh.forEach(block => block.nodes.forEach(node => fragment.appendChild(node)));
        container.insertBefore(fragment, after ? after.nodes[0] : null);
        const blocks = old.slice(0, diff.start).concat(fresh, old.slice(diff.oldEnd));
        blocks.forEach((block, i) => {
            block.raw = built.blocks[i].raw;
        });
        return blocks;
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

    /**
     * ⌘E / Ctrl+E toggles editing; ⌘S / Ctrl+S saves and ⌘F / Ctrl+F opens find and replace
     * while editing; ⇧⌘S / Ctrl+Shift+S is Save As, while viewing too. While viewing, ⌘F is
     * left to the browser's own find.
     */
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
            setEditorMode(core.nextEditorMode(editorMode, splitOffered()));
        } else if (action === 'find') {
            if (!editing) return;
            e.preventDefault();
            editing.cm.openSearchPanel(editing.view);
        } else if (action === 'saveAs') {
            e.preventDefault();
            saveDocumentAs();
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

    /**
     * Edit: swaps the rendered view for the markdown, with the cursor where the reader was.
     * `restore` ({ id, text, changed, unsaved, fingerprint, lock }) reopens unsaved work kept
     * in the backup `id`: the editor starts with its text, unsaved against the document on
     * screen (`unsaved`: even when it's the same), and with the "changed on disk" banner when
     * `changed`. `lock` ({ release, taken }, web): the backup's lock, already claimed, which the
     * editor takes over (`taken`) once it's open.
     */
    async function startEditing(restore = null) {
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

            const text = restore ? restore.text : currentSource.markdown;
            const raws = rendered ? rendered.blocks.map(block => block.raw) : [];
            const anchor = rendered && !restore && markdownContent.style.display !== 'none' ? captureAnchor() : null;
            const separator = core.lineSeparator(text);
            const session = {
                cm, separator, view: null, state: null, saving: null, words: null,
                backup: newBackup(restore ? restore.id : null, restore && restore.lock ? restore.lock.release : null),
            };
            session.state = core.editReducer(null, { type: 'open', content: currentSource.markdown }).state;
            if (restore) {
                session.state = core.editReducer(session.state, {
                    type: 'restore', text, changed: restore.changed, unsaved: Boolean(restore.unsaved),
                }).state;
                // Until the banner is answered, a backup still says the file changed since.
                if (session.state.conflict !== null) session.backup.keptFingerprint = restore.fingerprint || null;
            }
            editorHost.replaceChildren();
            session.view = cm.createEditor(editorHost, text, editorOptions(session));
            editing = session;
            if (restore && restore.lock) restore.lock.taken = true;
            setUpToolbar();
            renderWordCount();

            markdownContent.style.display = 'none';
            editorHost.hidden = false;
            document.body.classList.add('editing');
            anchorHold = null;
            renderEditControls();
            renderToolbar();
            placeToolbar();
            showSplit(currentView() === 'split');

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
        if (editing) {
            dispatchEdit({ type: 'revert' });
            // Discarded: the backup goes too, before the window can close.
            await editing.backup.queue;
        }
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
                if (editing !== session) return;
                dispatchEdit({ type: 'edit', text: editorText() });
                scheduleWordCount();
                renderSplitSoon();
            },
            onSelect: () => {
                if (editing === session) scheduleWordCount();
            },
            onUpdate: () => {
                if (editing === session) renderToolbar();
            },
            topInset: editorTopInset,
            mode: editorModeFor(currentView()),
            isMac: IS_MAC,
            resolveImage: editorImageSrc,
            openLink: openEditorLink,
            renderInline: (markdown) => marked.parseInline(markdown),
        };
    }

    // ------------------------------------------------------------------
    // Rich mode and the Rich | Markdown | Split switch
    // ------------------------------------------------------------------

    function loadEditorMode() {
        try {
            const saved = window.localStorage.getItem(MODE_KEY);
            return core.EDITOR_MODES.includes(saved) ? saved : 'rich';
        } catch (_) {
            return 'rich';
        }
    }

    function splitOffered() {
        return !phoneWidth.matches;
    }

    /** The view on screen: the chosen mode, but Markdown for Split at phone widths. */
    function currentView() {
        return core.editorView(editorMode, splitOffered());
    }

    /** The editor's own mode for a view: Split shows the plain source beside the rendering. */
    function editorModeFor(view) {
        return view === 'rich' ? 'rich' : 'markdown';
    }

    /** Switches the view to `mode` ('rich', 'markdown' or 'split'), remembering the choice. */
    function setEditorMode(mode) {
        editorMode = mode;
        try {
            window.localStorage.setItem(MODE_KEY, mode);
        } catch (_) {
            // Private browsing: remembered for this page only.
        }
        applyEditorView();
    }

    /**
     * Puts the editor in the view the chosen mode shows at this width. It's the same document
     * with other decorations (and Split adds the rendering beside it), so the text, cursor,
     * selection and undo history stay as they are; the line at the top of the window stays
     * there.
     */
    function applyEditorView() {
        renderModeSwitch();
        if (!editing) return;
        const view = editing.view;
        const shown = currentView();
        const top = editorTopInset();
        const line = view.lineBlockAtHeight(top - view.documentTop);
        const offset = view.documentTop + line.top - top;
        editing.cm.setMode(view, editorModeFor(shown));
        showSplit(shown === 'split');
        // After CodeMirror's measure, which may already have scrolled to keep the line at the
        // top of the window in place: only what's left is corrected.
        view.requestMeasure({
            read: () => null,
            write: () => queueMicrotask(() => {
                if (editing === null || editing.view !== view) return;
                const moved = view.documentTop + view.lineBlockAt(line.from).top - top - offset;
                if (Math.abs(moved) > 1) window.scrollBy(0, moved);
                syncSplit('editor');
            }),
        });
    }

    function renderModeSwitch() {
        modeSwitch.hidden = !editing;
        const shown = currentView();
        modeSwitch.querySelectorAll('[data-mode]').forEach(button => {
            const on = button.dataset.mode === shown;
            button.setAttribute('aria-checked', String(on));
            button.tabIndex = on ? 0 : -1;
            button.title = `${MODE_TITLES[button.dataset.mode]} (${IS_MAC ? '⌘/' : 'Ctrl+/'})`;
        });
    }

    /** The switch's options on screen (Split isn't, at phone widths; there only the current one is). */
    function visibleModes() {
        return [...modeSwitch.querySelectorAll('[data-mode]')].filter(button => button.getClientRects().length > 0);
    }

    function onModeSwitchClick(e) {
        const button = e.target.closest('[data-mode]');
        if (!button) return;
        let mode = button.dataset.mode;
        // On a phone only the current view shows: pressing it switches to the next.
        if (mode === currentView() && visibleModes().length === 1) mode = core.nextEditorMode(mode, splitOffered());
        if (mode !== currentView()) setEditorMode(mode);
        if (editing) editing.view.focus();
    }

    /** A radio group: the arrow keys pick the next or previous view. */
    function onModeSwitchKeydown(e) {
        const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const modes = core.EDITOR_MODES.filter(mode => splitOffered() || mode !== 'split');
        const index = modes.indexOf(currentView());
        setEditorMode(modes[(index + step + modes.length) % modes.length]);
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

    function scheduleWordCount() {
        clearTimeout(wordCountTimer);
        wordCountTimer = setTimeout(renderWordCount, WORD_COUNT_DELAY_MS);
    }

    /** "1,204 words", or "37 of 1,204 words" while text is selected. */
    function renderWordCount() {
        clearTimeout(wordCountTimer);
        wordCountTimer = null;
        if (!editing) {
            wordCount.hidden = true;
            return;
        }
        const session = editing;
        const state = session.view.state;
        // The document is counted again only when it changed, not for every new selection.
        if (!session.words || session.words.doc !== state.doc) {
            session.words = { doc: state.doc, total: core.countWords(state.sliceDoc()) };
        }
        const ranges = state.selection.ranges.filter(range => !range.empty);
        const selected = ranges.length
            ? core.countWords(ranges.map(range => state.sliceDoc(range.from, range.to)).join('\n'))
            : null;
        wordCount.textContent = core.formatWordCount(session.words.total, selected);
        wordCount.hidden = false;
    }

    /** Removes the editor (and its unsaved changes, if any) without asking. */
    function closeEditor() {
        if (!editing) return;
        const session = editing;
        // Anything still unsaved stays kept (every caller asked about it first, so normally
        // nothing is).
        if (session.state.dirty) writeBackup(session);
        else dropBackup(session);
        releaseBackupLock(session);
        editing = null;
        closeMenus();
        renderWordCount();
        showSplit(false);
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
        const { selection, doc } = view.state;
        // Select all (one range over the whole document) stays select all.
        const selectAll = (newLength) => selection.ranges.length === 1
            ? core.selectAllAfterReplace(selection.main, doc.length, newLength)
            : null;
        if (core.lineSeparator(text) !== session.separator) {
            const offset = textOffset(view.state, selection.main.head, session.separator);
            editorHost.replaceChildren();
            view.destroy();
            session.separator = core.lineSeparator(text);
            session.view = session.cm.createEditor(editorHost, text, editorOptions(session));
            scheduleWordCount();
            const length = session.view.state.doc.length;
            const all = selectAll(length);
            const pos = Math.min(docPosition(text, offset, session.separator), length);
            session.view.dispatch({ selection: all || { anchor: pos } });
            return;
        }
        // CodeMirror counts a line break as one position, whatever the separator.
        const flat = (value) => (session.separator === '\r\n' ? value.split('\r\n').join('\n') : value);
        const change = core.textChange(flat(view.state.sliceDoc()), flat(text));
        if (!change) return;
        const all = selectAll(doc.length - (change.to - change.from) + change.insert.length);
        view.dispatch({
            changes: change,
            ...(all ? { selection: all } : {}),
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

    /** How the editor saves: in place, asking where first (a new document), or as a download. */
    function saveMode() {
        return core.saveAction(currentSource, { isDesktop, savePicker: typeof window.showSaveFilePicker === 'function' });
    }

    async function saveDocument() {
        if (!editing || editing.saving || !currentSource) return;
        const session = editing;
        if (!session.state.dirty) return;
        // The file changed on disk: the banner asks what to do first (Keep mine, then Save).
        if (session.state.conflict !== null) return;
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
            if (mode === 'saveAs') {
                await saveToFile(session, source, content, base);
                return;
            }
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
                downloadText(content, source.kind === 'untitled' ? core.UNTITLED_FILE_NAME : source.title);
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

    /**
     * Save As (⇧⌘S / Ctrl+Shift+S, File > Save As…, the Save As button): saves the document as a
     * file the reader picks, which it is from then on (saveToFile). Works while viewing too, with
     * the text on screen, and with or without unsaved changes. Not while a save is being written,
     * or while the "changed on disk" banner waits for an answer (as Save).
     */
    async function saveDocumentAs() {
        const session = editing;
        const source = currentSource;
        if (!source || savingAs) return;
        if (session ? session.saving || session.state.conflict !== null : typeof source.markdown !== 'string') return;
        const writing = writeAs(session, source);
        savingAs = writing;
        if (session) session.saving = writing;
        renderEditControls();
        try {
            await writing;
        } finally {
            savingAs = null;
            if (session) session.saving = null;
            renderEditControls();
        }
    }

    /** Writes the document for Save As (saveDocumentAs). Never rejects: failures are reported here. */
    async function writeAs(session, source) {
        const content = session ? editorText() : source.markdown;
        const base = session ? session.state.base : source.markdown;
        try {
            const mode = core.saveAsAction({ isDesktop, savePicker: typeof window.showSaveFilePicker === 'function' });
            if (mode === 'saveAs') {
                await saveToFile(session, source, content, base);
                return;
            }
            downloadText(content, core.saveAsName(source));
            if (session && editing === session) dispatchEdit({ type: 'saved', content, text: editorText() });
        } catch (err) {
            if (err && err.kind === 'conflict' && session && editing === session) {
                dispatchEdit({ type: 'saveConflict', content: err.content, text: editorText() });
                return;
            }
            if (err && err.name === 'AbortError') return; // the picker was cancelled
            console.error('Save failed:', err);
            alert(`Could not save: ${err && err.message ? err.message : err}`);
        }
    }

    /**
     * Saves `content` as a file the reader picks: the Save panel (desktop) or showSaveFilePicker
     * (web), suggesting the document's own name (Untitled.md while untitled) and, in the app,
     * its folder. Save As, and an untitled document's first save. From then on it's that file:
     * titled by it, saved in place and live reloaded, and the file it came from is left as it
     * was. Picking the file it already is saves it in place, checked as Save is. Cancelling the
     * panel changes nothing. `session` is the editor (null while viewing), `base` the text its
     * changes are against. Errors are the caller's.
     */
    async function saveToFile(session, source, content, base) {
        if (isDesktop) {
            const path = source.kind === 'desktop' ? source.path : null;
            const doc = await invoke('save_document_as', { path, base, content });
            if (!doc) return;
            // Saved as a document of its own, not one of a folder's (the app has it so already).
            let rewatch = doc.path !== source.path;
            if (desktopFolder && currentSource === source) {
                desktopFolder = null;
                renderWatchFolderButton();
                rewatch = true;
            }
            Object.assign(source, { kind: 'desktop', dir: doc.dir, title: doc.name, path: doc.path });
            savedAs(session, source, content);
            if (currentSource !== source || !rewatch) return;
            setLive(true);
            // Watches the new file instead of the old one (or the folder).
            await watchDesktopDocument(doc.path);
            return;
        }
        // Called before anything is awaited, while the key press or click still counts as the
        // reader's. The browser asks before replacing an existing file.
        const handle = await window.showSaveFilePicker({ suggestedName: core.saveAsName(source), types: SAVE_TYPES });
        if (source.handle && await source.handle.isSameEntry(handle)) {
            // The file it already is: an ordinary save (nothing to write while viewing).
            if (session) await writeSession(session, source);
            return;
        }
        const writable = await handle.createWritable();
        try {
            await writable.write(content);
            await writable.close();
        } catch (err) {
            writable.abort().catch(() => {});
            throw err;
        }
        Object.assign(source, { kind: 'file', dir: '', title: handle.name, handle });
        savedAs(session, source, content);
        if (currentSource !== source) return;
        // Watches the new file instead of the old one.
        stopWebWatch();
        startWebWatch(handle, await handle.getFile(), webWatch.observer);
    }

    /**
     * The document was saved as `source`'s file (saveToFile). Its backup, if anything is still
     * unsaved (typed while the panel was up), now names that file.
     */
    function savedAs(session, source, content) {
        if (session && editing === session) {
            dispatchEdit({ type: 'saved', content, text: editorText() });
            if (session.state.dirty) writeBackup(session);
        }
        if (currentSource === source) {
            showTitle(source.title);
            // Reopened unsaved work whose file had gone: it has one again.
            hideMissingNotice();
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
        saveAsButton.hidden = !on;
        revertButton.hidden = !on;
        renderModeSwitch();
        editBanner.hidden = !(on && editing.state.conflict !== null);
        if (on) {
            const download = saveMode() === 'download';
            saveButton.textContent = download ? 'Download' : 'Save';
            saveButton.title = download
                ? 'This browser can\'t save in place: download a copy'
                : `Save (${IS_MAC ? '⌘S' : 'Ctrl+S'})`;
            saveButton.disabled = !dirty || Boolean(editing.saving) || editing.state.conflict !== null;
            // Save As saves even with nothing unsaved: a copy under another name.
            saveAsButton.title = core.saveAsAction({ isDesktop, savePicker: typeof window.showSaveFilePicker === 'function' }) === 'download'
                ? 'This browser can\'t ask where to save: download a copy'
                : `Save under another name (${IS_MAC ? '⇧⌘S' : 'Ctrl+Shift+S'})`;
            saveAsButton.disabled = Boolean(editing.saving) || editing.state.conflict !== null;
            // Dropping the changes waits for the save being written, which would write them.
            revertButton.disabled = Boolean(editing.saving) || (!dirty && editing.state.conflict === null);
            bannerReload.disabled = Boolean(editing.saving);
            bannerKeep.disabled = Boolean(editing.saving);
        }
        if (dirty !== titleMarked && currentSource) showTitle(currentSource.title);
        syncCloseGuard(dirty);
        syncBackup();
        placeSplitPreview();
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
    // Unsaved work kept across quits and crashes
    // ------------------------------------------------------------------

    /**
     * An editing session's backup: { id, stored (whether one is kept now), timer (a write
     * waiting), queue (writes and removals, in order), source (the document it's of),
     * fingerprint ({ base, value }: of what the editor's changes are against), keptFingerprint
     * (a restored backup's, while its banner is up), release (web: lets go of its lock) }.
     * `id` reopens a backup kept before, with `release` its lock's (claimed by claimBackupLock);
     * otherwise it's a new one.
     */
    function newBackup(id, release = null) {
        return {
            id: id || newBackupId(),
            stored: Boolean(id),
            timer: null,
            queue: Promise.resolve(),
            source: null,
            fingerprint: null,
            keptFingerprint: null,
            release: id ? release || holdBackupLock(id) : null,
        };
    }

    function newBackupId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    /**
     * Keeps the editor's backup in step with it (after every change, from renderEditControls):
     * unsaved changes are written about a second after they're made, however long the typing
     * goes on; with nothing unsaved (saved, reverted or discarded), the backup goes.
     */
    function syncBackup() {
        const session = editing;
        if (!session || !backupStore) return;
        if (currentSource) session.backup.source = currentSource;
        if (session.state.conflict === null) session.backup.keptFingerprint = null;
        if (!session.state.dirty) {
            dropBackup(session);
        } else if (!session.backup.timer) {
            session.backup.timer = setTimeout(() => {
                session.backup.timer = null;
                writeBackup(session);
            }, core.BACKUP_DELAY_MS);
        }
    }

    /** Writes a waiting backup now (the page going away or out of sight). */
    function flushBackup() {
        if (editing && editing.backup.timer) writeBackup(editing);
    }

    /**
     * Writes the session's unsaved work to its backup now. Resolves once it's written, or once
     * writing failed, which is logged and never gets in the reader's way.
     */
    function writeBackup(session) {
        const backup = session.backup;
        clearBackupTimer(backup);
        const source = backup.source || currentSource;
        if (!backupStore || editing !== session || !session.state.dirty || !source) return backup.queue;
        const record = backupRecord(session, source);
        if (!backup.release) backup.release = holdBackupLock(backup.id);
        backup.stored = true;
        return queueBackup(backup, () => backupStore.write(record));
    }

    /** Removes the session's backup: nothing is unsaved any more. */
    function dropBackup(session) {
        const backup = session.backup;
        clearBackupTimer(backup);
        if (backupStore && backup.stored) {
            backup.stored = false;
            queueBackup(backup, () => backupStore.remove(backup.id));
        }
        releaseBackupLock(session);
        return backup.queue;
    }

    function clearBackupTimer(backup) {
        if (!backup.timer) return;
        clearTimeout(backup.timer);
        backup.timer = null;
    }

    function queueBackup(backup, operation) {
        backup.queue = backup.queue
            .then(operation)
            .catch(err => console.error('Could not keep unsaved work:', err));
        return backup.queue;
    }

    /** What a backup keeps: the editor's text, and the document it's of. */
    function backupRecord(session, source) {
        const backup = session.backup;
        const base = session.state.base;
        if (!backup.fingerprint || backup.fingerprint.base !== base) {
            backup.fingerprint = { base, value: core.fingerprint(base) };
        }
        const file = source.kind !== 'untitled';
        return {
            id: backup.id,
            text: editorText(),
            title: source.title,
            file,
            name: !file ? '' : source.path ? core.basename(source.path) : source.title,
            path: source.kind === 'desktop' && source.path ? source.path : null,
            // Web, in Chromium: reopening the file asks the browser for permission again.
            handle: source.handle || null,
            fingerprint: file ? backup.keptFingerprint || backup.fingerprint.value : null,
            // Untitled because its file was moved or deleted: restoring it says so again.
            missing: !file && Boolean(source.missing),
            savedAt: Date.now(),
        };
    }

    /** Web: holds the lock that keeps a backup off other tabs' offers. Returns its release. */
    function holdBackupLock(id) {
        if (isDesktop || !navigator.locks) return null;
        let release;
        const held = new Promise(resolve => {
            release = resolve;
        });
        navigator.locks.request(BACKUP_LOCK + id, () => held).catch(() => {});
        return release;
    }

    /**
     * Web: takes the lock of a backup offered for restoring, unless another tab holds it (it
     * restored the backup first). Resolves to its release, or null when it's taken.
     */
    function claimBackupLock(id) {
        if (isDesktop || !navigator.locks) return Promise.resolve(() => {});
        return new Promise(resolve => {
            let release;
            const held = new Promise(done => {
                release = done;
            });
            navigator.locks.request(BACKUP_LOCK + id, { ifAvailable: true }, (lock) => {
                if (!lock) {
                    resolve(null);
                    return null;
                }
                resolve(release);
                return held;
            }).catch(() => resolve(null));
        });
    }

    /** Lets go of the session's lock once its backup's writes are done. */
    function releaseBackupLock(session) {
        const release = session.backup.release;
        if (!release) return;
        session.backup.release = null;
        session.backup.queue.then(release);
    }

    /** The app's backups folder (backups.rs). */
    function desktopBackupStore() {
        return {
            write: (record) => invoke('write_backup', {
                id: record.id,
                text: record.text,
                path: record.path,
                title: record.title,
                fingerprint: record.fingerprint,
                missing: record.missing,
            }),
            remove: (id) => invoke('remove_backup', { id }),
        };
    }

    /**
     * Web: IndexedDB. Null where the browser has none; where it throws (a private window, site
     * data blocked), every write fails and is logged, and editing carries on without backups.
     */
    function webBackupStore() {
        let db;
        try {
            db = window.indexedDB;
        } catch (_) {
            db = null;
        }
        if (!db) return null;
        let opening = null;
        const open = () => {
            if (!opening) {
                opening = new Promise((resolve, reject) => {
                    const request = db.open(BACKUP_DB, 1);
                    request.onupgradeneeded = () => request.result.createObjectStore(BACKUP_TABLE, { keyPath: 'id' });
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                // Tried again next time.
                opening.catch(() => {
                    opening = null;
                });
            }
            return opening;
        };
        const run = (mode, use) => open().then(database => new Promise((resolve, reject) => {
            const transaction = database.transaction(BACKUP_TABLE, mode);
            const request = use(transaction.objectStore(BACKUP_TABLE));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        }));
        return {
            write: (record) => run('readwrite', table => table.put(record)).catch(err => {
                // A browser that can't keep the file's handle keeps the rest.
                if (!record.handle || !err || err.name !== 'DataCloneError') throw err;
                return run('readwrite', table => table.put({ ...record, handle: null }));
            }),
            remove: (id) => run('readwrite', table => table.delete(id)),
            get: (id) => run('readonly', table => table.get(id)),
            list: () => run('readonly', table => table.getAll()),
        };
    }

    /** Web: offers the backups no open tab is editing on the drop zone (Restore 2 unsaved documents). */
    async function refreshRestoreOffer() {
        if (isDesktop || !backupStore) return;
        let offer = [];
        try {
            offer = await backupStore.list();
            if (navigator.locks) {
                const held = new Set(((await navigator.locks.query()).held || []).map(lock => lock.name));
                offer = offer.filter(backup => !held.has(BACKUP_LOCK + backup.id));
            }
        } catch (err) {
            console.error('Could not look for unsaved work:', err);
            offer = [];
        }
        restoreOffer = offer.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        restoreButton.hidden = restoreOffer.length === 0;
        if (restoreOffer.length > 0) restoreLabel.textContent = core.restoreLabel(restoreOffer.length);
    }

    /** Web: the drop zone's Restore. One backup reopens at once; several are listed to choose from. */
    function offerRestore() {
        const offer = restoreOffer.slice();
        if (offer.length === 0) return;
        // Straight away, while the click still counts as the reader's: a file's handle asks for
        // permission again.
        if (offer.length === 1) {
            restoreWebBackup(offer[0]);
            return;
        }
        showFileSelector(offer.map(backup => ({
            name: backup.title || core.UNTITLED_TITLE,
            display: `Unsaved changes from ${new Date(backup.savedAt).toLocaleString()}`,
            load: () => restoreWebBackup(backup),
        })), undefined, {
            heading: 'Unsaved documents',
            hint: 'Choose the one to restore. The others stay here until you restore them.',
        });
    }

    /**
     * Web: reopens a backup. One with a file's handle (Chromium) reopens the file, once the
     * browser has permission again; refused, or in another browser, it's an untitled document
     * named after the file.
     */
    async function restoreWebBackup(offered) {
        restoreOffer = restoreOffer.filter(other => other !== offered);
        // Another tab may have restored it since it was offered, or saved or discarded it: only
        // the tab holding its lock touches it, and only while it's still kept.
        const release = await claimBackupLock(offered.id);
        let backup = null;
        if (release) {
            try {
                backup = await backupStore.get(offered.id);
            } catch (err) {
                console.error('Could not reopen unsaved work:', err);
            }
        }
        if (!backup) {
            if (release) release();
            await refreshRestoreOffer();
            alert('These unsaved changes were already restored in another tab, or saved or discarded there.');
            return;
        }
        const lock = { release, taken: false };
        try {
            await reopenWebBackup(backup, lock);
        } finally {
            // Not reopened (a refused open, or the reader kept what they had): it stays on offer.
            if (!lock.taken) release();
        }
    }

    /** restoreWebBackup, once `backup` is known to be kept and its `lock` is held. */
    async function reopenWebBackup(backup, lock) {
        let status = backup.file ? 'unreachable' : core.backupStatus(backup, null);
        let show = null;
        if (backup.handle) {
            try {
                const mode = { mode: 'read' };
                let permission = await backup.handle.queryPermission(mode);
                if (permission === 'prompt') permission = await backup.handle.requestPermission(mode);
                if (permission === 'granted') {
                    // Throws NotFoundError when the file was moved or deleted.
                    await backup.handle.getFile();
                    show = await readFileHandle(backup.handle);
                }
            } catch (err) {
                if (err && err.name === 'NotFoundError') {
                    status = 'missing';
                } else {
                    console.error('Could not reopen the file:', err);
                }
            }
        }
        if (show) {
            if (!(await leaveEditor())) return;
            await show();
            if (!currentSource || currentSource.handle !== backup.handle) return;
            await editRestored(backup, core.restorePlan(backup, core.backupStatus(backup, currentSource.markdown)), lock);
            return;
        }
        await newDocument({ backup, plan: core.restorePlan(backup, status), lock });
    }

    /**
     * Desktop: reopens a backup at launch. A file that's still there opens with the backup's
     * text as unsaved edits; one that's gone, or an untitled document, opens as untitled.
     */
    async function restoreDesktopBackup(backup) {
        const doc = backup.document;
        if (doc && (backup.status === 'unchanged' || backup.status === 'changed')) {
            watchGeneration++;
            closeFileSelector();
            desktopFolder = null;
            renderWatchFolderButton();
            await showDesktopDocument(doc);
            if (!isShowingPath(doc.path)) return;
            // Checked against the file as it is now: live reload has caught up with it.
            await editRestored(backup, core.restorePlan(backup, core.backupStatus(backup, currentSource.markdown)));
            return;
        }
        const status = backup.status === 'untitled' ? 'untitled' : 'missing';
        if (!(await newDocument({ backup, plan: core.restorePlan(backup, status) })) && !currentSource) showDropZone();
    }

    /** Opens the document on screen in the editor with a backup's text (a 'file' plan). */
    async function editRestored(backup, plan, lock = null) {
        try {
            await startEditing({ id: backup.id, text: plan.text, changed: plan.changed, fingerprint: backup.fingerprint, lock });
        } catch (err) {
            console.error('Could not reopen unsaved work:', err);
            alert(`Could not open the editor: ${err && err.message ? err.message : err}`);
        }
    }

    // ------------------------------------------------------------------
    // Formatting toolbar
    // ------------------------------------------------------------------

    /** Applies a formatting command (format.js) to the editor's text and selection, as one undoable change. */
    function runFormat(command) {
        if (!editing || !window.MarkyFormat) return;
        applyFormat((input) => window.MarkyFormat.apply(command, input));
    }

    /**
     * Applies `edit` to the editor as one undoable change: a function from { text, selection }
     * to { text, selection }, as format.js's commands are.
     */
    function applyFormat(edit) {
        const view = editing.view;
        const state = view.state;
        // Positions count a line break as one character, as in the editor; '\r\n' comes back
        // on the way in.
        const text = state.doc.toString();
        const main = state.selection.main;
        const out = edit({ text, selection: { anchor: main.anchor, head: main.head } });
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
        tableGrid.style.gridTemplateColumns = `repeat(${TABLE_PICKER_COLUMNS}, auto)`;
        for (let rows = 1; rows <= TABLE_PICKER_ROWS; rows++) {
            for (let cols = 1; cols <= TABLE_PICKER_COLUMNS; cols++) {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'table-cell';
                cell.tabIndex = -1;
                cell.dataset.cols = String(cols);
                cell.dataset.rows = String(rows);
                cell.setAttribute('aria-label', `${cols} by ${rows} table`);
                tableGrid.appendChild(cell);
            }
        }
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
        const cell = e.target.closest('.table-cell');
        if (cell) {
            closeMenus();
            if (editing && window.MarkyFormat) {
                applyFormat((input) => window.MarkyFormat.insertTable(input, Number(cell.dataset.cols), Number(cell.dataset.rows)));
            }
            return;
        }
        const action = e.target.closest('[data-action]');
        if (action) {
            runAction(action.dataset.action, action);
            return;
        }
        const item = e.target.closest('[data-command]');
        if (!item) return;
        closeMenus();
        runFormat(item.dataset.command);
    }

    /** The toolbar's inserts: 'table' (opens the size picker), 'image' and 'horizontalRule'. */
    function runAction(action, from) {
        if (action === 'table') {
            // From the overflow menu, the picker opens under its button.
            const under = from === tableButton ? tableButton : moreButton;
            const open = !tablePicker.hidden && tablePickerFrom === under;
            closeMenus();
            if (!open) openTablePicker(under);
            return;
        }
        closeMenus();
        if (!editing || !window.MarkyFormat) return;
        if (action === 'horizontalRule') applyFormat((input) => window.MarkyFormat.insertRule(input));
        else if (action === 'image') insertImage();
    }

    /** Opens the table picker under `button`, with the focus on its first cell. */
    function openTablePicker(button) {
        tablePickerFrom = button;
        // (The overflow button's expanded state is its menu's.)
        if (button === tableButton) tableButton.setAttribute('aria-expanded', 'true');
        tablePicker.hidden = false;
        // Under the button, kept inside the toolbar's width (and the window's).
        const bar = formatToolbar.getBoundingClientRect();
        const room = Math.min(bar.width, window.innerWidth - bar.left - 8) - tablePicker.offsetWidth;
        const left = button.getBoundingClientRect().left - bar.left;
        tablePicker.style.left = `${Math.max(0, Math.min(left, room))}px`;
        const first = tableGrid.querySelector('.table-cell');
        markTableSize(first);
        first.focus();
    }

    /** Highlights the table `cell` picks (from the top left), and shows its size. */
    function markTableSize(cell) {
        const cols = Number(cell.dataset.cols);
        const rows = Number(cell.dataset.rows);
        tableGrid.querySelectorAll('.table-cell').forEach(el => {
            el.classList.toggle('on', Number(el.dataset.cols) <= cols && Number(el.dataset.rows) <= rows);
        });
        tableSize.textContent = `${cols} × ${rows}`;
    }

    /** Arrow keys move around the picker; Enter picks; Escape goes back to the button, Tab closes. */
    function onTablePickerKeydown(e) {
        const cell = e.target.closest('.table-cell');
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            const from = tablePickerFrom;
            closeMenus();
            if (from) from.focus();
            return;
        }
        if (e.key === 'Tab') {
            closeMenus();
            return;
        }
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!step || !cell) return;
        e.preventDefault();
        const cols = Math.min(Math.max(Number(cell.dataset.cols) + step[0], 1), TABLE_PICKER_COLUMNS);
        const rows = Math.min(Math.max(Number(cell.dataset.rows) + step[1], 1), TABLE_PICKER_ROWS);
        tableGrid.querySelector(`[data-cols="${cols}"][data-rows="${rows}"]`).focus();
    }

    /**
     * Insert image. On the desktop: a file picked with the Open panel, linked by its path
     * relative to the document (the app offers to copy one from elsewhere next to it). On the
     * web, which can't link a file by its path: `![alt](path)` with `path` selected to fill in.
     */
    async function insertImage() {
        const session = editing;
        const source = currentSource;
        if (!isDesktop || !source || source.kind !== 'desktop' || !source.path) {
            applyFormat((input) => window.MarkyFormat.insertImage(input));
            return;
        }
        let picked;
        try {
            picked = await invoke('choose_image');
        } catch (err) {
            console.error('Could not insert the image:', err);
            alert(`Could not insert the image: ${err && err.message ? err.message : err}`);
            return;
        }
        if (editing !== session || !currentSource || currentSource.path !== source.path) return;
        if (!picked) {
            // Cancelled: back to where the reader was (the overflow menu took the focus).
            session.view.focus();
            return;
        }
        const path = core.relativePath(source.dir, picked) || picked;
        applyFormat((input) => window.MarkyFormat.insertImage(input, { path }));
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
        if (e.target.closest('.table-picker')) {
            onTablePickerKeydown(e);
            return;
        }
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
        if (e.target === tableButton && e.key === 'ArrowDown') {
            e.preventDefault();
            closeMenus();
            openTablePicker(tableButton);
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
        if (!tablePicker.hidden) {
            tablePicker.hidden = true;
            tableButton.setAttribute('aria-expanded', 'false');
            tablePickerFrom = null;
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
    // Split view: the markdown beside the rendered document
    // ------------------------------------------------------------------

    /** Shows or hides the rendered side of the split view (the editor is on the other). */
    function showSplit(on) {
        if (on === Boolean(split)) return;
        if (!on) {
            clearTimeout(split.timer);
            cancelAnimationFrame(split.frame);
            split = null;
            document.body.classList.remove('split-view');
            splitPreview.hidden = true;
            splitPreview.replaceChildren();
            return;
        }
        split = { blocks: null, linksKey: '', seq: 0, timer: null, frame: 0, expectWindow: null, expectPreview: null };
        document.body.classList.add('split-view');
        splitPreview.hidden = false;
        splitPreview.scrollTop = 0;
        placeSplitPreview();
        renderSplitPreview();
    }

    /** Where the rendered side sticks: under the toolbar (and the desktop's conflict banner). */
    function placeSplitPreview() {
        if (!split) return;
        const bottom = (el) => parseFloat(getComputedStyle(el).top) + el.offsetHeight;
        let top = bottom(formatToolbar);
        if (!editBanner.hidden && getComputedStyle(editBanner).position === 'sticky') top = Math.max(top, bottom(editBanner));
        document.body.style.setProperty('--split-top', `${Math.round((Number.isFinite(top) ? top : 0) + 12)}px`);
    }

    /** Re-renders the rendered side a moment after typing stops. */
    function renderSplitSoon() {
        if (!split) return;
        clearTimeout(split.timer);
        split.timer = setTimeout(renderSplitPreview, 150);
    }

    /** Renders the editor's text beside it, replacing only the blocks that changed. */
    async function renderSplitPreview() {
        const state = split;
        if (!state || !editing) return;
        const seq = ++state.seq;
        const text = editing.view.state.doc.toString();
        let built;
        try {
            built = buildBlocks(text);
            // As Rich mode resolves them: one URL per image, however often it re-renders.
            await Promise.all([...built.doc.querySelectorAll('img[src]')].map(img =>
                Promise.resolve(editorImageSrc(img.getAttribute('src'))).then(url => {
                    if (url) img.setAttribute('src', url);
                }, () => {})));
        } catch (error) {
            console.error('Error parsing markdown:', error);
            built = { blocks: [{ raw: text, nodes: [renderError(text)] }], linksKey: '' };
        }
        if (split !== state || seq !== state.seq) return;
        const diff = state.blocks && built.linksKey === state.linksKey
            ? core.changedBlocks(state.blocks.map(block => block.raw), built.blocks.map(block => block.raw))
            : null;
        state.blocks = placeBlocks(splitPreview, state.blocks, built, diff);
        state.linksKey = built.linksKey;
        syncSplit('editor');
        // Images change the height of the blocks below them as they load: step again then.
        const resync = () => {
            if (split === state && seq === state.seq) syncSplit('editor');
        };
        for (const img of splitPreview.querySelectorAll('img')) {
            if (img.complete) continue;
            img.addEventListener('load', resync, { once: true });
            img.addEventListener('error', resync, { once: true });
        }
    }

    /** A pane scrolled: the other follows on the next frame (once, however many events came). */
    function syncSplitSoon(source) {
        if (!split || !editing) return;
        const expected = source === 'editor' ? split.expectWindow : split.expectPreview;
        const now = source === 'editor' ? window.scrollY : splitPreview.scrollTop;
        if (expected !== null) {
            if (source === 'editor') split.expectWindow = null;
            else split.expectPreview = null;
            // The scroll this page made to keep them in step.
            if (Math.abs(now - expected) <= 1) return;
        }
        cancelAnimationFrame(split.frame);
        split.frame = requestAnimationFrame(() => syncSplit(source));
    }

    /**
     * Brings the other pane in step with `source` ('editor' or 'preview'): the block at the top
     * of one goes to the top of the other, as far into it (core.mapScrollPosition). Blocks are
     * matched through their markdown, as the rendered view finds them in the text.
     */
    function syncSplit(source) {
        if (!split || !editing || !split.blocks) return;
        const view = editing.view;
        const raws = split.blocks.map(block => block.raw);
        const starts = core.blockStarts(raws, view.state.doc.toString());
        const editorTops = starts.map(pos => view.lineBlockAt(Math.min(pos, view.state.doc.length)).top);
        editorTops.push(view.contentHeight);
        const paneTop = splitPreview.getBoundingClientRect().top - splitPreview.scrollTop;
        let last = 0;
        const previewTops = split.blocks.map(block => {
            const el = block.nodes.find(node => node.nodeType === Node.ELEMENT_NODE);
            if (el) last = el.getBoundingClientRect().top - paneTop;
            return last;
        });
        previewTops.push(splitPreview.scrollHeight);
        // The editor scrolls with the page: its top is the first line under the toolbar.
        const editorY = editorTopInset() - view.documentTop;
        // Targets are clamped to how far each pane can scroll, so one already at its end isn't
        // scrolled again (which would leave an expected scroll that never comes).
        if (source === 'editor') {
            const max = splitPreview.scrollHeight - splitPreview.clientHeight;
            const y = Math.max(0, Math.min(max, Math.round(core.mapScrollPosition(editorTops, previewTops, editorY))));
            if (Math.abs(splitPreview.scrollTop - y) <= 1) return;
            splitPreview.scrollTop = y;
            split.expectPreview = splitPreview.scrollTop;
        } else {
            const y = core.mapScrollPosition(previewTops, editorTops, splitPreview.scrollTop);
            const max = document.documentElement.scrollHeight - window.innerHeight;
            const target = Math.max(0, Math.min(max, Math.round(window.scrollY + y - editorY)));
            if (Math.abs(window.scrollY - target) <= 1) return;
            window.scrollTo(0, target);
            split.expectWindow = window.scrollY;
        }
    }

    /** Clicks in the rendered side: images open in the lightbox, links as Rich mode's ⌘-click does. */
    function onSplitPreviewClick(e) {
        const img = e.target.closest('img');
        if (img) {
            e.preventDefault();
            openLightbox(img.src, img.alt || 'Image');
            return;
        }
        const link = e.target.closest('a[href]');
        if (!link) return;
        e.preventDefault();
        const href = link.getAttribute('href');
        if (core.classifyLink(href) !== 'anchor') {
            openEditorLink(href);
            return;
        }
        let id = href.slice(1);
        try {
            id = decodeURIComponent(id);
        } catch (_) {
            // use raw id
        }
        // The headings' ids as the rendered view gives them (refreshHeadingIds).
        const used = new Set();
        const headings = [...splitPreview.querySelectorAll('h1, h2, h3, h4, h5, h6')];
        const target = headings.find(h => (h.id || core.uniqueSlug(h.textContent, used)) === id)
            || (id && splitPreview.querySelector(`[id="${CSS.escape(id)}"]`));
        if (!target) return;
        const top = target.getBoundingClientRect().top - splitPreview.getBoundingClientRect().top + splitPreview.scrollTop;
        splitPreview.scrollTo({ top: Math.max(0, top - 16), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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
        refreshRestoreOffer();
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
     * heading, hint: what the list is, when it isn't a folder's files.
     */
    function showFileSelector(entries, openAll, { heading = SELECTOR_HEADING, hint = SELECTOR_HINT } = {}) {
        selectorHeading.textContent = heading;
        selectorHint.textContent = hint;
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
