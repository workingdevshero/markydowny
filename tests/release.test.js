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

test('only the release job can write, and it runs only for a tag, after every build', () => {
    // Read-only by default.
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    const all = jobs();
    for (const [id, text] of Object.entries(all)) {
        if (id === 'release') continue;
        assert.doesNotMatch(text, /permissions:|: write/, `${id} asks for no permissions`);
    }
    const release = all.release;
    assert.match(release, /^ {4}permissions:\n {6}contents: write\n(?! {6})/m);
    // A tag pushed by hand, or one tag-release.yml made and dispatched this workflow on. Pull
    // requests and dispatches on a branch have a branch ref, so they never get here.
    assert.match(release, /^ {4}if: github\.ref_type == 'tag'$/m);
    assert.match(release, /^ {4}needs: \[version, mac, linux\]$/m);
});

test('the release job attaches everything to a draft, with checksums, and re-runs replace its files', () => {
    const release = jobs().release;
    assert.match(release, /gh release create "\$TAG" artifacts\/\* --draft /);
    assert.match(release, /sha256sum -- \* > SHA256SUMS\.txt/);
    assert.match(release, /gh release upload "\$TAG" artifacts\/\* --clobber/);
    // A re-run's notes follow its build (notarized or not), not the first run's.
    assert.match(release, /gh release edit "\$TAG" --notes-file full-notes\.md/);
    assert.match(release, /glibc 2\.38/);
});

test('the release job publishes the release once every file is attached', () => {
    const release = jobs().release;
    const create = release.indexOf('name: Create or update the draft release');
    const publish = release.indexOf('name: Publish the release');
    assert.ok(create > 0 && publish > create, 'publishing is its own step, after the files are attached');
    const step = release.slice(publish);
    assert.match(step, /gh release edit "\$TAG" --draft=false "\$\{latest\[@\]\}"/);
    // A prerelease isn't marked latest; a release is.
    assert.match(step, /latest=\(--latest\)/);
    assert.match(step, /\[\[ "\$PRERELEASE" == "true" \]\] && latest=\(--latest=false\)/);
    // Only a tag publishes, pushed or dispatched on: a dry run (a pull request, or a dispatch on a
    // branch) never reaches the release job. The event isn't part of the condition because
    // tag-release.yml starts the release with workflow_dispatch on the tag, not a push.
    assert.match(release, /^ {4}if: github\.ref_type == 'tag'$/m);
});

test('the builds are the ones the release promises', () => {
    const { mac, linux, version } = jobs();
    assert.match(version, /node scripts\/check-release-version\.mjs "\$GITHUB_REF_NAME"/);
    assert.match(mac, /runs-on: macos-latest/);
    assert.match(mac, /scripts\/release-mac\.sh --arch universal --identity "\$SIGNING_IDENTITY" --notary-profile markydowny-notary\n/);
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

/** The run script of the step named `name` in `job`'s text. */
function step(job, name) {
    const text = job.split(`- name: ${name}\n`)[1];
    assert.ok(text, `no step named ${name}`);
    return text.split(/^ {6}- /m)[0];
}

test('the Mac build is signed with the Developer ID and notarized when the Apple secrets are set', () => {
    const { mac } = jobs();
    const setUp = step(mac, 'Set up signing');
    for (const name of ['APPLE_CERTIFICATE_P12', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER_ID']) {
        assert.match(setUp, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`), name);
    }
    // Without any of them (a fork's PR) the build is ad hoc, and the summary says so.
    assert.match(setUp, /echo "notarized=false"/);
    assert.match(setUp, /\*\*not notarized\*\*/);
    // A temporary keychain with a random, masked password, which codesign can use unprompted.
    assert.match(setUp, /password=\$\(openssl rand -base64 32\)\n\s*echo "::add-mask::\$password"/);
    assert.match(setUp, /security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "\$password" "\$keychain"/);
    assert.match(setUp, /security list-keychains -d user -s "\$keychain"/);
    // The identity is the certificate's SHA-1, masked before anything can print it.
    assert.match(setUp, /security find-identity -v -p codesigning "\$keychain"/);
    assert.ok(setUp.indexOf('echo "::add-mask::$ids"') < setUp.indexOf('echo "identity=$ids"'));
    assert.match(setUp, /xcrun notarytool store-credentials markydowny-notary --key "\$p8" .*\n.* --keychain "\$keychain"/);
    assert.match(step(mac, 'Build, sign and package'), /NOTARY_KEYCHAIN: \$\{\{ steps\.signing\.outputs\.keychain \}\}/);
    const check = step(mac, 'Check the signature and notarization');
    assert.match(check, /^ {8}if: steps\.signing\.outputs\.notarized == 'true'$/m);
    assert.match(check, /spctl --assess --type open --context context:primary-signature -v "\$dmg"/);
    assert.match(check, /xcrun stapler validate "\$dmg"/);
    assert.match(check, /spctl --assess -v "\$mount"\/\*\.app/);
    assert.match(check, /signed and notarized/);
    // The keychain and the key files are deleted even when a step before fails.
    const cleanUp = step(mac, 'Clean up signing');
    assert.match(cleanUp, /^ {8}if: always\(\)$/m);
    assert.match(cleanUp, /security delete-keychain "\$RUNNER_TEMP\/markydowny-signing\.keychain-db"/);
    assert.match(cleanUp, /rm -f "\$RUNNER_TEMP\/developer-id\.p12" "\$RUNNER_TEMP\/notary-key\.p8"/);
    assert.match(mac, /^ {6}notarized: \$\{\{ steps\.signing\.outputs\.notarized \}\}$/m);
});

test('the Apple secrets are never printed, only written to the files the clean-up deletes', () => {
    for (const line of workflow.split('\n')) {
        if (!/\$\{?APPLE_/.test(line)) continue;
        assert.doesNotMatch(line, /\becho\b[^|]*\$\{?APPLE_/, line);
        if (/\b(printf|cat)\b/.test(line)) assert.match(line, /> "\$p8"$/, line);
    }
});

test('the release notes keep the quarantine workaround only for a build that isn\'t notarized', () => {
    const notes = step(jobs().release, 'Release notes');
    assert.match(notes, /NOTARIZED: \$\{\{ needs\.mac\.outputs\.notarized \}\}/);
    const [notarized, rest] = notes.split(/^ {10}else$/m);
    const [unnotarized] = rest.split(/^ {10}fi$/m);
    assert.match(notarized, /if \[\[ "\$NOTARIZED" == "true" \]\]/);
    assert.match(notarized, /signed and notarized by Apple/);
    assert.doesNotMatch(notarized, /xattr|quarantine/);
    assert.match(unnotarized, /xattr -dr com\.apple\.quarantine \/Applications\/Markydowny\.app/);
});

test('a prerelease .deb is versioned to sort before the release, as dpkg reads it', () => {
    const repack = step(jobs().linux, 'Give a prerelease .deb a version that sorts before the release');
    assert.match(repack, /if: needs\.version\.outputs\.prerelease == 'true'/);
    assert.match(repack, /sed -i "s\/\^Version: \.\*\/Version: \$deb_version\/" "\$tree\/DEBIAN\/control"/);
    const convert = /deb_version=\$\((.*)\)$/m.exec(repack)[1];
    for (const [version, expected] of [['1.2.0-beta.1', '1.2.0~beta.1'], ['1.2.0-rc-1', '1.2.0~rc.1'], ['1.2.0-beta.1+abc', '1.2.0~beta.1+abc']]) {
        const run = spawnSync('bash', ['-c', convert], { env: { ...process.env, VERSION: version }, encoding: 'utf8' });
        assert.equal(run.stdout.trim(), expected, version);
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

test('the release job gathers the Linux packages out of their folders before the checksums', () => {
    const release = jobs().release;
    const gather = release.indexOf('name: Gather the files');
    assert.ok(gather > 0 && gather < release.indexOf('name: Checksums'), 'gathering comes before the checksums');
    // Run the step's own script against what the download produces.
    const script = release.slice(gather).match(/run: \|\n((?: {10}.*\n)+)/)[1].replace(/^ {10}/gm, '');
    const run = dir => spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8' });
    const fresh = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-artifacts-'));
        fs.mkdirSync(path.join(dir, 'deb')); fs.mkdirSync(path.join(dir, 'appimage'));
        fs.writeFileSync(path.join(dir, 'Markydowny-1.0.0-universal.dmg'), 'dmg');
        for (const arch of ['amd64', 'arm64']) fs.writeFileSync(path.join(dir, 'deb', `Markydowny_1.0.0_${arch}.deb`), arch);
        for (const arch of ['amd64', 'aarch64']) fs.writeFileSync(path.join(dir, 'appimage', `Markydowny_1.0.0_${arch}.AppImage`), arch);
        return dir;
    };
    const dir = fresh();
    const ok = run(dir);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.deepEqual(fs.readdirSync(dir).sort(), [
        'Markydowny-1.0.0-universal.dmg', 'Markydowny_1.0.0_aarch64.AppImage', 'Markydowny_1.0.0_amd64.AppImage',
        'Markydowny_1.0.0_amd64.deb', 'Markydowny_1.0.0_arm64.deb',
    ]);
    // Two files with one name: the step fails instead of silently dropping one.
    const clash = fresh();
    fs.writeFileSync(path.join(clash, 'Markydowny_1.0.0_amd64.deb'), 'other');
    const bad = run(clash);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /same name/);
});
