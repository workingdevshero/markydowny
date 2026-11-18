const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'check-release-version.mjs');
const load = () => import('../scripts/check-release-version.mjs');

/** A checkout in a temporary directory whose three version files say `versions` (by file). */
function checkout(versions = {}) {
    const v = { 'package.json': '1.2.0', 'src-tauri/Cargo.toml': '1.2.0', 'src-tauri/tauri.conf.json': '1.2.0', ...versions };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markydowny-release-'));
    fs.mkdirSync(path.join(dir, 'src-tauri'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'markydowny', version: v['package.json'] }));
    fs.writeFileSync(path.join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'Markydowny', version: v['src-tauri/tauri.conf.json'] }));
    // A dependency table with its own version comes after [package], which must not be read.
    fs.writeFileSync(path.join(dir, 'src-tauri/Cargo.toml'),
        `[package]\nname = "markydowny"\nversion = "${v['src-tauri/Cargo.toml']}"\n\n[dependencies.serde]\nversion = "9.9.9"\n`);
    return dir;
}

/** Runs the script by hand, as the workflow does, in `dir`'s checkout. */
async function run(dir, ...args) {
    const { main } = await load();
    const output = path.join(dir, 'github-output');
    const errors = [];
    const logs = [];
    const { error, log } = console;
    console.error = m => errors.push(m);
    console.log = m => logs.push(m);
    try {
        const status = main(args, { root: dir, env: { GITHUB_OUTPUT: output } });
        const githubOutput = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
        return { status, stderr: errors.join('\n'), stdout: logs.join('\n'), githubOutput };
    } finally {
        Object.assign(console, { error, log });
    }
}

test('a tag matching all three files passes and outputs its version', async () => {
    const r = await run(checkout(), 'v1.2.0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '1.2.0');
    assert.equal(r.githubOutput, 'version=1.2.0\nprerelease=false\n');
});

for (const file of ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']) {
    test(`a tag fails, naming ${file}, when only ${file} differs`, async () => {
        const r = await run(checkout({ [file]: '1.1.0' }), 'v1.2.0');
        assert.equal(r.status, 1);
        assert.match(r.stderr, new RegExp(`${file.replace(/\./g, '\\.')} has version 1\\.1\\.0, but the tag v1\\.2\\.0 says 1\\.2\\.0`));
        for (const other of ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json'].filter(f => f !== file)) {
            assert.doesNotMatch(r.stderr, new RegExp(`${other.replace(/\./g, '\\.')} has version`));
        }
        assert.equal(r.githubOutput, '', 'nothing is output for the build jobs');
    });
}

test('a malformed tag fails before reading any version', async () => {
    for (const tag of ['1.2.0', 'v1.2', 'v1.2.0.0', 'version-1', 'v01.2.0', 'v1.2.0-']) {
        const r = await run(checkout(), tag);
        assert.equal(r.status, 1, tag);
        assert.match(r.stderr, /isn't a version tag/, tag);
    }
});

test('a prerelease tag matches a prerelease version and is output as a prerelease', async () => {
    const r = await run(checkout({ 'package.json': '1.2.0-beta.1', 'src-tauri/Cargo.toml': '1.2.0-beta.1', 'src-tauri/tauri.conf.json': '1.2.0-beta.1' }), 'v1.2.0-beta.1');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.githubOutput, 'version=1.2.0-beta.1\nprerelease=true\n');
    // The prerelease part is part of the version: v1.2.0-beta.1 isn't 1.2.0.
    const plain = await run(checkout(), 'v1.2.0-beta.1');
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /package\.json has version 1\.2\.0, but the tag v1\.2\.0-beta\.1 says 1\.2\.0-beta\.1/);
});

test('without a tag (a dry run), the three files must agree with each other', async () => {
    assert.equal((await run(checkout())).status, 0);
    const r = await run(checkout({ 'src-tauri/Cargo.toml': '1.3.0' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /src-tauri\/Cargo\.toml has version 1\.3\.0, but package\.json says 1\.2\.0/);
});

test("the repository's own three versions agree, and the script runs by hand", () => {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const ok = spawnSync(process.execPath, [script, `v${version}`], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), version);
    const wrong = spawnSync(process.execPath, [script, 'v0.0.0-never'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /package\.json has version/);
});

// --- The workflow ---------------------------------------------------------------------------

const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

/** The text of each job, keyed by its id: the lines indented under `jobs:`. */
function jobs() {
    const body = workflow.split(/^jobs:\n/m)[1];
    const result = {};
    let current;
    for (const line of body.split('\n')) {
        const id = /^  ([\w-]+):\s*$/.exec(line);
        if (id) result[(current = id[1])] = '';
        else if (current && (line.startsWith('    ') || !line.trim())) result[current] += line + '\n';
        else if (/^\S/.test(line)) break;
    }
    return result;
}

test('the release workflow runs on v* tags, and dry-runs on PRs and workflow_dispatch', () => {
    const on = workflow.split(/^on:\n/m)[1].split(/^\S/m)[0];
    assert.match(on, /^ {2}push:\n {4}tags: \["v\*"\]\n/m);
    assert.doesNotMatch(on, /branches:/, 'pushing a branch never releases');
    assert.match(on, /^ {2}pull_request:\n {4}paths:\n(?: {6}- .*\n)*? {6}- \.github\/workflows\/release\.yml\n/m);
    assert.match(on, /^ {2}workflow_dispatch:/m);
    assert.deepEqual(Object.keys(jobs()), ['version', 'mac', 'linux', 'release']);
});

test('only the release job can write, and it runs only for a pushed tag, after every build', () => {
    // Read-only by default.
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    const all = jobs();
    for (const [id, text] of Object.entries(all)) {
        if (id === 'release') continue;
        assert.doesNotMatch(text, /permissions:|: write/, `${id} asks for no permissions`);
    }
    const release = all.release;
    assert.match(release, /^ {4}permissions:\n {6}contents: write\n(?! {6})/m);
    assert.match(release, /^ {4}if: github\.event_name == 'push' && github\.ref_type == 'tag'$/m);
    assert.match(release, /^ {4}needs: \[version, mac, linux\]$/m);
});

test('the release job creates a draft, with checksums, and re-runs replace its files', () => {
    const release = jobs().release;
    assert.match(release, /gh release create "\$TAG" artifacts\/\* --draft /);
    assert.match(release, /sha256sum -- \* > SHA256SUMS\.txt/);
    assert.match(release, /gh release upload "\$TAG" artifacts\/\* --clobber/);
    assert.match(release, /xattr -dr com\.apple\.quarantine \/Applications\/Markydowny\.app/);
    assert.match(release, /glibc 2\.38/);
    assert.ok(!/gh release (edit|create)[^\n]*--draft=false/.test(workflow), 'nothing publishes the release');
});

test('the builds are the ones the release promises', () => {
    const { mac, linux, version } = jobs();
    assert.match(version, /node scripts\/check-release-version\.mjs "\$GITHUB_REF_NAME"/);
    assert.match(mac, /runs-on: macos-latest/);
    assert.match(mac, /scripts\/release-mac\.sh --arch universal --identity - --no-notarize/);
    assert.match(linux, /runner: ubuntu-24\.04\n/);
    assert.match(linux, /runner: ubuntu-24\.04-arm\n/);
    assert.match(linux, /npx tauri build --bundles deb,appimage/);
    for (const [id, text] of Object.entries({ mac, linux })) {
        assert.match(text, /timeout-minutes: \d+/, `${id} has a timeout`);
        assert.match(text, /needs: version/, `${id} waits for the version check`);
        assert.match(text, /BUGSPLAT_DATABASE: \$\{\{ secrets\.BUGSPLAT_DATABASE \}\}/, `${id} reads the database from the secret`);
        // Symbols are uploaded only for a tag, and a missing secret is a note, not a failure.
        assert.match(text, /- name: Upload symbols\n\s+if: github\.ref_type == 'tag'\n/);
        assert.match(text, /crash reporting is \*\*off\*\*/);
    }
});

test('the database name is never echoed or written anywhere but the build environment', () => {
    for (const line of workflow.split('\n')) {
        if (!/BUGSPLAT_DATABASE/.test(line)) continue;
        assert.doesNotMatch(line, /\b(echo|printf|cat)\b[^|]*\$\{?BUGSPLAT_DATABASE/, line);
    }
});

test('the Linux packages carry the crash reporting helpers next to the executable', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    for (const bundle of ['deb', 'appimage']) {
        assert.deepEqual(conf.bundle.linux[bundle].files, {
            '/usr/bin/BugSplatMonitor': 'bugsplat-helpers/BugSplatMonitor',
            '/usr/bin/BugSplatReporter': 'bugsplat-helpers/BugSplatReporter',
        }, bundle);
    }
});
