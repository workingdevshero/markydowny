const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../js/core.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const lib = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');

/** The body of `function name` in app.js. */
function fn(name) {
    return app.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n {4}}\\n`))[0];
}

// ---------------------------------------------------------------------------
// Restore decisions (js/core.js)
// ---------------------------------------------------------------------------

test('fingerprint matches the desktop app\'s (backups.rs)', () => {
    // The same values src-tauri/src/backups.rs expects of its own fingerprint.
    assert.equal(core.fingerprint(''), '0:811c9dc5');
    assert.equal(core.fingerprint('a'), '1:e40c292c');
    assert.equal(core.fingerprint('foobar'), '6:bf9cf968');
    assert.equal(core.fingerprint('café'), '5:a82b5049');
    assert.notEqual(core.fingerprint('# Notes\n'), core.fingerprint('# Notes\r\n'));
});

test('an untitled backup stays untitled', () => {
    const backup = { id: 'u', text: '# Draft\n', title: 'Untitled', file: false, path: null, fingerprint: null };
    assert.equal(core.backupStatus(backup, null), 'untitled');
    assert.deepEqual(core.restorePlan(backup, 'untitled'), { kind: 'untitled', title: 'Untitled', text: '# Draft\n', missing: false });
    // Whatever it was called, and with no title at all.
    assert.equal(core.restorePlan({ ...backup, title: 'Notes' }, 'untitled').title, 'Notes');
    assert.equal(core.restorePlan({ ...backup, title: '' }, 'untitled').title, core.UNTITLED_TITLE);
});

test('a file-backed backup whose file is unchanged reopens the file with its edits', () => {
    const base = '# Notes\n\nOld.\n';
    const backup = { id: 'f', text: '# Notes\n\nNew.\n', title: 'notes.md', path: '/docs/notes.md', fingerprint: core.fingerprint(base) };
    assert.equal(core.backupStatus(backup, base), 'unchanged');
    assert.deepEqual(core.restorePlan(backup, 'unchanged'), { kind: 'file', text: '# Notes\n\nNew.\n', changed: false });
    // The web's backups say "file" instead of a path.
    const web = { id: 'w', text: 'x', title: 'notes.md', file: true, name: 'notes.md', fingerprint: core.fingerprint(base) };
    assert.equal(core.backupStatus(web, base), 'unchanged');
});

test('a file that changed on disk since shows the banner', () => {
    const backup = { id: 'f', text: 'mine', title: 'notes.md', path: '/docs/notes.md', fingerprint: core.fingerprint('before') };
    assert.equal(core.backupStatus(backup, 'changed elsewhere'), 'changed');
    assert.deepEqual(core.restorePlan(backup, 'changed'), { kind: 'file', text: 'mine', changed: true });
});

test('a missing file becomes untitled, named after the file, with a note', () => {
    const backup = { id: 'f', text: 'mine', title: 'docs › notes.md', path: '/docs/notes.md', fingerprint: core.fingerprint('x') };
    assert.equal(core.backupStatus(backup, null), 'missing');
    assert.deepEqual(core.restorePlan(backup, 'missing'), { kind: 'untitled', title: 'notes.md', text: 'mine', missing: true });
    // Windows paths too.
    assert.equal(core.restorePlan({ ...backup, path: 'C:\\docs\\notes.md' }, 'missing').title, 'notes.md');
});

test('a file the browser can\'t reopen becomes untitled, named after the file, without a note', () => {
    const backup = { id: 'w', text: 'mine', title: 'notes.md', file: true, name: 'notes.md', handle: null, fingerprint: core.fingerprint('x') };
    assert.deepEqual(core.restorePlan(backup, 'unreachable'), { kind: 'untitled', title: 'notes.md', text: 'mine', missing: false });
});

test('a reopened backup is unsaved against the file, and changed on disk asks first', () => {
    const open = core.editReducer(null, { type: 'open', content: 'on disk' }).state;
    const unchanged = core.editReducer(open, { type: 'restore', text: 'mine', changed: false });
    assert.deepEqual(unchanged.state, { base: 'on disk', dirty: true, conflict: null, restored: false, written: [] });
    assert.equal(unchanged.apply, 'mine');

    const changed = core.editReducer(open, { type: 'restore', text: 'mine', changed: true }).state;
    assert.equal(changed.dirty, true);
    assert.equal(changed.conflict, 'on disk', 'the banner is up');
    // Reload takes the file as it is; Keep mine keeps the backup's text, to save over it.
    const reloaded = core.editReducer(changed, { type: 'reload' });
    assert.equal(reloaded.apply, 'on disk');
    assert.equal(reloaded.state.dirty, false);
    const kept = core.editReducer(changed, { type: 'keepMine', text: 'mine' }).state;
    assert.deepEqual(kept, { base: 'on disk', dirty: true, conflict: null, restored: false, written: [] });

    // A backup that matches the file has nothing unsaved, and nothing to ask about.
    const same = core.editReducer(open, { type: 'restore', text: 'on disk', changed: true });
    assert.deepEqual(same.state, { base: 'on disk', dirty: false, conflict: null, restored: false, written: [] });
    assert.equal(same.apply, null);
});

test('a restored banner stays up until it is answered, even if the file goes back to how it was', () => {
    // Edited against 'before'; the file held 'on disk' at restore, then changed and changed back.
    const open = core.editReducer(null, { type: 'open', content: 'on disk' }).state;
    let state = core.editReducer(open, { type: 'restore', text: 'mine', changed: true }).state;
    assert.equal(state.restored, true);
    state = core.editReducer(state, { type: 'disk', content: 'someone else', text: 'mine' }).state;
    assert.equal(state.conflict, 'someone else');
    state = core.editReducer(state, { type: 'disk', content: 'on disk', text: 'mine' }).state;
    assert.equal(state.conflict, 'on disk', 'still asks: the work wasn\'t done against this either');
    assert.equal(state.dirty, true);
    // Answering it makes it an ordinary edit again, where going back to base clears the banner.
    const kept = core.editReducer(state, { type: 'keepMine', text: 'mine' }).state;
    assert.deepEqual(kept, { base: 'on disk', dirty: true, conflict: null, restored: false, written: [] });
    const reloaded = core.editReducer(state, { type: 'reload' }).state;
    assert.equal(reloaded.restored, false);
    // An ordinary conflict still clears when the file goes back.
    let plain = core.editReducer(open, { type: 'edit', text: 'mine' }).state;
    plain = core.editReducer(plain, { type: 'disk', content: 'theirs', text: 'mine' }).state;
    plain = core.editReducer(plain, { type: 'disk', content: 'on disk', text: 'mine' }).state;
    assert.equal(plain.conflict, null);
});

test('an emptied document whose file is gone stays unsaved when it reopens', () => {
    const open = core.editReducer(null, { type: 'open', content: '' }).state;
    const restored = core.editReducer(open, { type: 'restore', text: '', changed: false, unsaved: true });
    assert.equal(restored.state.dirty, true);
    assert.equal(restored.apply, null);
    assert.match(fn('newDocument'), /changed: false, unsaved: true,/);
    assert.match(fn('startEditing'), /unsaved: Boolean\(restore\.unsaved\)/);
});

test('the drop zone counts the unsaved documents it offers', () => {
    assert.equal(core.restoreLabel(1), 'Restore 1 unsaved document');
    assert.equal(core.restoreLabel(2), 'Restore 2 unsaved documents');
});

test('a backup is written about a second after a change', () => {
    assert.equal(core.BACKUP_DELAY_MS, 1000);
});

// ---------------------------------------------------------------------------
// Wiring (js/app.js, index.html, lib.rs)
// ---------------------------------------------------------------------------

test('every change keeps the backup in step: written while unsaved, removed once nothing is', () => {
    assert.match(fn('renderEditControls'), /syncBackup\(\);/);
    const sync = fn('syncBackup');
    assert.match(sync, /if \(!session\.state\.dirty\) \{\s*dropBackup\(session\);/);
    // Throttled rather than debounced: typing without a pause still gets written.
    assert.match(sync, /else if \(!session\.backup\.timer\) \{\s*session\.backup\.timer = setTimeout\([\s\S]*core\.BACKUP_DELAY_MS\)/);
    // Writes and removals go in order, so a late write can't bring back a removed backup.
    assert.match(fn('writeBackup'), /queueBackup\(backup, \(\) => backupStore\.write\(record\)\)/);
    assert.match(fn('dropBackup'), /queueBackup\(backup, \(\) => backupStore\.remove\(backup\.id\)\)/);
    assert.match(fn('queueBackup'), /\.catch\(err => console\.error\(/, 'a failed write is logged, never in the way');
});

test('Discard waits for the backup to go, so a closed window doesn\'t come back', () => {
    const leave = fn('leaveEditor');
    assert.match(leave, /dispatchEdit\(\{ type: 'revert' \}\);\s*\/\/[^\n]*\n\s*await editing\.backup\.queue;/);
    // Closing a window still asks.
    assert.match(fn('syncCloseGuard'), /onCloseRequested\(async \(event\) => \{\s*if \(!\(await leaveEditor\(\)\)\) event\.preventDefault\(\);/);
});

test('the web still asks before the tab closes, and keeps the backup when it does', () => {
    assert.match(app, /window\.addEventListener\('beforeunload', \(e\) => \{\s*if \(!hasUnsavedChanges\(\)\) return;/);
    assert.match(app, /window\.addEventListener\('pagehide', flushBackup\);/);
    assert.match(app, /if \(document\.hidden\) flushBackup\(\);/);
});

test('every IndexedDB access is wrapped, so a browser without storage carries on', () => {
    const store = fn('webBackupStore');
    assert.match(store, /try \{\s*db = window\.indexedDB;\s*\} catch \(_\) \{\s*db = null;/);
    assert.match(store, /if \(!db\) return null;/);
    assert.match(store, /err\.name !== 'DataCloneError'/);
    const offer = fn('refreshRestoreOffer');
    assert.match(offer, /catch \(err\) \{\s*console\.error\(/);
    // Backups another tab is editing aren't offered.
    assert.match(offer, /navigator\.locks\.query\(\)/);
});

test('the drop zone offers to restore, after New file, hidden until there is something to restore', () => {
    const zone = html.match(/<div class="drop-actions">([\s\S]*?)<\/div>/)[1];
    assert.ok(zone.indexOf('id="newFileButton"') < zone.indexOf('id="restoreButton"'));
    assert.match(zone, /<button class="btn btn-ghost restore-button" id="restoreButton" type="button"[^>]* hidden>/);
    assert.match(html, /\.restore-button\[hidden\]\s*\{\s*display: none;/);
    assert.match(fn('showDropZone'), /refreshRestoreOffer\(\);/);
    // In Chromium, reopening the file asks the browser for permission again.
    const restore = fn('reopenWebBackup');
    assert.match(restore, /queryPermission\(mode\)/);
    assert.match(restore, /requestPermission\(mode\)/);
    assert.match(restore, /err\.name === 'NotFoundError'/);
});

test('a web restore claims the backup and checks it is still kept before reopening it', () => {
    const restore = fn('restoreWebBackup');
    const claim = restore.indexOf('await claimBackupLock(offered.id)');
    const get = restore.indexOf('await backupStore.get(offered.id)');
    assert.ok(claim > 0 && claim < get, 'claimed, then read again');
    assert.ok(get < restore.indexOf('reopenWebBackup('));
    assert.match(restore, /if \(!backup\) \{\s*if \(release\) release\(\);\s*await refreshRestoreOffer\(\);/);
    // Not reopened: let go of it, so it's offered again.
    assert.match(restore, /if \(!lock\.taken\) release\(\);/);
    assert.match(fn('claimBackupLock'), /navigator\.locks\.request\(BACKUP_LOCK \+ id, \{ ifAvailable: true \}/);
    assert.match(fn('startEditing'), /editing = session;\s*if \(restore && restore\.lock\) restore\.lock\.taken = true;/);
});

test('the desktop app reopens backups at launch and keeps them on Quit without asking', () => {
    for (const command of ['write_backup', 'remove_backup', 'backups_flushed']) {
        assert.match(lib, new RegExp(`generate_handler!\\[[\\s\\S]*?\\b${command},`), command);
    }
    assert.match(lib, /route_paths\(handle, paths, Some\(MAIN_WINDOW\.to_string\(\)\)\);[\s\S]*?restore_backups\(handle\);/);
    assert.match(app, /if \(pending\.restore\) \{[\s\S]*?await restoreDesktopBackup\(pending\.restore\);/);
    // Quit asks every window to write its backup, then quits.
    assert.match(app, /listen\('flush-backups', async \(\) => \{\s*if \(editing\) await writeBackup\(editing\);\s*invoke\('backups_flushed'\)/);
    assert.match(lib, /QUIT_MENU_ID[\s\S]*?\.accelerator\("CmdOrCtrl\+Q"\)/);
    assert.match(lib, /app\.emit\(FLUSH_EVENT, \(\)\)/);
    // Quitting from the Dock or logging out waits for the backups too.
    assert.match(lib, /sel!\(applicationShouldTerminate:\)/);
    assert.match(lib, /flush_backups\(&handle, \|handle\| \{\s*let _ = handle\.run_on_main_thread\(app_terminate::reply\);/);
    assert.match(lib, /tabs::native::add_window_menu_items\(\);\s*install_terminate_handler\(handle\);/);
});

test('a restored file is checked against the file after live reload caught up with it', () => {
    const restore = fn('restoreDesktopBackup');
    assert.ok(restore.indexOf('await showDesktopDocument(doc)') < restore.indexOf('core.backupStatus(backup, currentSource.markdown)'));
    // Caught up means rendered: the watch waits for the catch-up's render.
    assert.match(fn('watchDesktopDocument'), /await onDocumentChanged\(now\);/);
    const changed = fn('onDocumentChanged');
    assert.equal((changed.match(/await renderMarkdown\(/g) || []).length, 2);
    // Saving waits for the banner's answer, as it would after any change on disk.
    assert.match(fn('saveDocument'), /if \(session\.state\.conflict !== null\) return;/);
});
