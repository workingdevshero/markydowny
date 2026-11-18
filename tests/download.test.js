// The download links on markydowny.com use releases/latest/download/<name>, so they only work while
// the release workflow keeps attaching files under exactly those names.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const LATEST = 'https://github.com/workingdevshero/markydowny/releases/latest/download/';

// The fixed names the release job's "Add fixed-name copies" step creates, read from its script.
function fixedNameStep() {
    const workflow = read('.github/workflows/release.yml');
    const at = workflow.indexOf('name: Add fixed-name copies for the download page');
    assert.ok(at > 0, 'the release job has the fixed-name step');
    const script = workflow.slice(at).match(/run: \|\n((?: {10}.*\n)+)/)[1].replace(/^ {10}/gm, '');
    const names = [...script.matchAll(/^cp \S+ (\S+)$/gm)].map(m => m[1]);
    return { workflow, at, script, names };
}

test('the fixed-name copies come after gathering the files and before the checksums', () => {
    const { workflow, at } = fixedNameStep();
    assert.ok(workflow.indexOf('name: Gather the files') < at);
    assert.ok(at < workflow.indexOf('name: Checksums'), 'so SHA256SUMS.txt lists the copies too');
});

test('the fixed-name step makes one copy of each release file', () => {
    const { script, names } = fixedNameStep();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-names-'));
    for (const f of ['Markydowny-1.2.0-universal.dmg', 'Markydowny_1.2.0_amd64.deb', 'Markydowny_1.2.0_arm64.deb',
        'Markydowny_1.2.0_amd64.AppImage', 'Markydowny_1.2.0_aarch64.AppImage', 'Markydowny_1.2.0_x64-setup.exe',
        'Markydowny_1.2.0_x64_en-US.msi']) {
        fs.writeFileSync(path.join(dir, f), f);
    }
    const run = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(names.sort(), [
        'Markydowny-linux-arm64.AppImage', 'Markydowny-linux-x86_64.AppImage', 'Markydowny-mac.dmg',
        'Markydowny-windows-x64-setup.exe', 'markydowny-linux-arm64.deb', 'markydowny-linux-x86_64.deb',
    ]);
    // Each copy is the file it names: the dmg is the dmg, the arm64 AppImage is the aarch64 one.
    assert.equal(fs.readFileSync(path.join(dir, 'Markydowny-mac.dmg'), 'utf8'), 'Markydowny-1.2.0-universal.dmg');
    assert.equal(fs.readFileSync(path.join(dir, 'Markydowny-linux-arm64.AppImage'), 'utf8'), 'Markydowny_1.2.0_aarch64.AppImage');
    assert.equal(fs.readFileSync(path.join(dir, 'markydowny-linux-x86_64.deb'), 'utf8'), 'Markydowny_1.2.0_amd64.deb');
    assert.equal(fs.readFileSync(path.join(dir, 'Markydowny-windows-x64-setup.exe'), 'utf8'), 'Markydowny_1.2.0_x64-setup.exe');
});

test('every download link on the site points at a file the release attaches', () => {
    const { names } = fixedNameStep();
    const pages = ['docs/install.md', 'docs/markychecky.md', 'index.html'];
    const linked = new Set();
    for (const page of pages) {
        for (const m of read(page).matchAll(/releases\/latest\/download\/([\w.-]+)/g)) {
            assert.ok(names.includes(m[1]), `${page} links to ${m[1]}, which no release attaches`);
            linked.add(m[1]);
        }
    }
    // The Download page offers all six, and the homepage button is the Mac download.
    for (const name of names) assert.ok(read('docs/install.md').includes(LATEST + name), `the Download page links ${name}`);
    assert.match(read('index.html'), /<a class="btn btn-primary" href="https:\/\/github\.com\/workingdevshero\/markydowny\/releases\/latest\/download\/Markydowny-mac\.dmg">Download for Mac<\/a>/);
});

test('the markychecky page opens with the agent hint and links the Mac download', () => {
    const page = read('docs/markychecky.md');
    const body = page.split(/^---$/m)[2];
    const firstBlock = body.trim().split('\n\n')[1];
    assert.match(firstBlock, /^> \*\*Setting this up with your AI agent\?\*\*/, 'the hint comes right after the title');
    assert.ok(page.includes(LATEST + 'Markydowny-mac.dmg'));
});

test('the markychecky page shows the board as a video, and the files it plays are committed', () => {
    const page = read('docs/markychecky.md');
    const video = page.match(/<video class="docs-video" src="\/docs\/media\/([\w.-]+)" poster="\/docs\/media\/([\w.-]+)" autoplay muted loop playsinline aria-label="[^"]+">/);
    assert.ok(video, 'a muted, looping, inline video with a poster and a description');
    for (const file of [video[1], video[2]]) {
        assert.ok(fs.statSync(path.join(root, 'docs', 'media', file)).size > 0, `docs/media/${file} exists`);
    }
    // The video replaces the markdown sample: it comes before the feature list, and there's no
    // raw sample board left above it.
    const intro = page.slice(0, page.indexOf('- **Nothing to remember.**'));
    assert.ok(intro.includes('<video'), 'the video is in the introduction');
    assert.ok(!intro.includes('```markdown'), 'no raw markdown sample in the introduction');
});
