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

    // Web folder drops: relative path (e.g. "docs/img/a.png") -> File
    const folderFiles = new Map();
    let blobUrls = [];
    // What is on screen: { kind: 'file' | 'folder' | 'desktop', dir, title }
    let currentSource = null;

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
            const doc = await invoke('take_pending_document');
            if (doc) {
                closeFileSelector();
                await showDesktopDocument(doc);
            }
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
            await loadDesktopPath(entries[0].path);
            return;
        }
        showFileSelector(entries.map(entry => ({
            name: core.basename(entry.path),
            display: entry.display,
            load: () => loadDesktopPath(entry.path),
        })));
    }

    async function loadDesktopPath(path) {
        try {
            await showDesktopDocument(await invoke('read_document', { path }));
        } catch (err) {
            alert(String(err));
        }
    }

    async function showDesktopDocument(doc) {
        folderFiles.clear();
        await renderMarkdown(doc.content, { kind: 'desktop', dir: doc.dir, title: doc.name });
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

    async function renderMarkdown(markdownText, source) {
        currentSource = source;
        revokeBlobUrls();

        let nodes;
        try {
            const html = marked.parse(markdownText);
            // Parse into an inert document so images aren't fetched before
            // their paths are resolved.
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            addHeadingIds(parsed);
            await resolveImages(parsed, source);
            nodes = Array.from(parsed.body.childNodes);
        } catch (error) {
            console.error('Error parsing markdown:', error);
            nodes = [renderError(markdownText)];
        }

        markdownContent.replaceChildren(...nodes);
        showMarkdownContent(source.title);
        markdownContent.scrollTop = 0;
        window.scrollTo(0, 0);
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

    function addHeadingIds(doc) {
        const used = new Set();
        for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
            if (heading.id) continue;
            heading.id = core.uniqueSlug(heading.textContent, used);
        }
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
        currentSource = null;
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

    /** entries: [{ name, display, load }] */
    function showFileSelector(entries) {
        dropZone.style.display = 'none';
        markdownContent.style.display = 'none';
        fileSelector.style.display = 'block';
        container.classList.add('file-selector-active');
        fileList.replaceChildren();

        for (const entry of entries) {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.innerHTML = `
                <span class="file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg></span>
                <div>
                    <div class="file-name">${core.escapeHtml(entry.name)}</div>
                    <div class="file-path">${core.escapeHtml(entry.display)}</div>
                </div>
            `;
            item.addEventListener('click', () => {
                fileList.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                entry.load();
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
