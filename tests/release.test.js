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
    assert.deepEqual(Object.keys(jobs()), ['version', 'mac', 'linux', 'windows', 'release']);
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
    assert.match(release, /^ {4}needs: \[version, mac, linux, windows\]$/m);
});

test('the release job attaches everything to a draft, with checksums, and re-runs replace its files', () => {
    const release = jobs().release;
    assert.match(release, /gh release create "\$TAG" artifacts\/\* --draft /);
    assert.match(release, /sha256sum -- \* > SHA256SUMS\.txt/);
    assert.match(release, /gh release upload "\$TAG" artifacts\/\* --clobber/);
    // A re-run's notes follow its build (notarized or not), not the first run's.
    assert.match(release, /gh release edit "\$TAG" --notes-file full-notes\.md/);
    assert.match(release, /need glibc 2\.35 or newer: Ubuntu 22\.04, Debian 12, Fedora 36 and later\./);
    assert.match(release, /SmartScreen warns the first time\. Windows: click \*\*More info\*\*, then \*\*Run anyway\*\*\./);
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
    const { mac, linux, windows, version } = jobs();
    assert.match(version, /node scripts\/check-release-version\.mjs "\$GITHUB_REF_NAME"/);
    assert.match(mac, /runs-on: macos-latest/);
    assert.match(mac, /scripts\/release-mac\.sh --arch universal --identity "\$SIGNING_IDENTITY" --notary-profile markydowny-notary\n/);
    assert.match(mac, /scripts\/release-mac\.sh --arch universal --identity - --no-notarize/);
    // 22.04, not 24.04: the runner's glibc sets the packages' floor.
    assert.match(linux, /runner: ubuntu-22\.04\n/);
    assert.match(linux, /runner: ubuntu-22\.04-arm\n/);
    assert.doesNotMatch(linux, /ubuntu-24/);
    assert.match(linux, /npx tauri build --bundles deb,appimage/);
    assert.match(windows, /runs-on: windows-latest/);
    assert.match(windows, /\$bundles = if \(\$env:PRERELEASE -eq 'true'\) \{ 'nsis' \} else \{ 'nsis,msi' \}\n\s+npx tauri build --bundles \$bundles\n/);
    for (const [id, text] of Object.entries({ mac, linux, windows })) {
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

test("the Linux build compiles with Ubuntu 22.04's own Clang, as scripts/build-desktop.sh does", () => {
    const linux = jobs().linux;
    // Clang 14 compiles bugsplat-sys's Crashpad code (C++20); no newer Clang is fetched.
    assert.match(step(linux, 'Install build dependencies'), /\sclang\s/);
    assert.doesNotMatch(linux, /llvm\.sh|clang-18/);
    assert.match(linux, /^ {6}CC: clang\n {6}CXX: clang\+\+$/m);
});

test('the Linux build fails when a packaged executable needs a glibc newer than 2.35', () => {
    const linux = jobs().linux;
    const check = linux.indexOf('name: Check the glibc floor');
    assert.ok(check > linux.indexOf('name: Build .deb and .AppImage'), 'the check runs after the build');
    assert.ok(check < linux.indexOf('- uses: actions/upload-artifact'), 'the check runs before the upload');
    const floor = step(linux, 'Check the glibc floor');
    assert.match(floor, /MAX_GLIBC: "2\.35"/);
    const script = floor.match(/run: \|\n((?: {10}.*\n)+)/)[1].replace(/^ {10}/gm, '').replace(/\$\{\{ matrix\.arch \}\}/g, 'x86_64');
    // A build tree with one .deb and one .AppImage, and stand-ins for dpkg-deb, the AppImage's
    // extractor and objdump: each executable's "binary" is the objdump -T output it gives.
    const build = (versions, { missing } = {}) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glibc-floor-'));
        const bin = path.join(dir, 'stub-bin');
        const bundle = path.join(dir, 'src-tauri/target/release/bundle');
        fs.mkdirSync(bin);
        fs.mkdirSync(path.join(bundle, 'deb'), { recursive: true });
        fs.mkdirSync(path.join(bundle, 'appimage'));
        const files = Object.entries(versions).filter(([name]) => name !== missing)
            .map(([name, v]) => `printf '%s\\n' '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.2.5) memcpy' '0000000000000000      DF *UND*  0000000000000000 (GLIBC_${v}) f' > "$out/usr/bin/${name}"`)
            .join('\n');
        const unpack = `mkdir -p "$out/usr/bin"\n${files}\n`;
        fs.writeFileSync(path.join(bundle, 'deb', 'Markydowny_1.0.0_amd64.deb'), 'deb');
        fs.writeFileSync(path.join(bin, 'dpkg-deb'), `#!/bin/bash\n[[ "$1" == -x ]] || exit 2\nout=$3\n${unpack}`, { mode: 0o755 });
        fs.writeFileSync(path.join(bundle, 'appimage', 'Markydowny_1.0.0_amd64.AppImage'), `#!/bin/bash\n[[ "$1" == --appimage-extract ]] || exit 2\nout=squashfs-root\n${unpack}`, { mode: 0o755 });
        fs.writeFileSync(path.join(bin, 'objdump'), '#!/bin/bash\n[[ "$1" == -T ]] || exit 2\ncat "$2"\n', { mode: 0o755 });
        return { dir, bin };
    };
    const run = ({ dir, bin }) => {
        const summary = path.join(dir, 'summary');
        const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
            cwd: dir, encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAX_GLIBC: '2.35', GITHUB_STEP_SUMMARY: summary },
        });
        return { ...r, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
    };
    const helpers = { markydowny: '2.34', BugSplatMonitor: '2.35', BugSplatReporter: '2.17' };
    const ok = run(build(helpers));
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    for (const where of ['deb', 'squashfs-root']) assert.match(ok.stdout, new RegExp(`^${where}/usr/bin/BugSplatMonitor needs glibc 2\\.35$`, 'm'));
    assert.equal(ok.summary, 'Linux x86_64: the packages need glibc 2.35 (floor: 2.35).\n');
    // 2.38 is what an Ubuntu 24.04 build's Crashpad needed; 2.39 what its own binary picked up.
    for (const [name, v] of [['BugSplatReporter', '2.38'], ['markydowny', '2.39'], ['BugSplatMonitor', '2.35.1']]) {
        const bad = run(build({ ...helpers, [name]: v }));
        assert.equal(bad.status, 1, `${name} needing ${v} passed`);
        assert.match(bad.stdout, new RegExp(`::error::deb/usr/bin/${name} needs glibc ${v.replace(/\./g, '\\.')}, newer than the 2\\.35 floor`));
        assert.match(bad.summary, new RegExp(`need glibc ${v.replace(/\./g, '\\.')} `));
    }
    const missing = run(build(helpers, { missing: 'BugSplatMonitor' }));
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /::error::squashfs-root\/usr\/bin\/BugSplatMonitor is missing/);
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

test('the release job gathers the Linux and Windows packages out of their folders before the checksums', () => {
    const release = jobs().release;
    const gather = release.indexOf('name: Gather the files');
    assert.ok(gather > 0 && gather < release.indexOf('name: Checksums'), 'gathering comes before the checksums');
    // Run the step's own script against what the download produces.
    const script = release.slice(gather).match(/run: \|\n((?: {10}.*\n)+)/)[1].replace(/^ {10}/gm, '');
    const run = dir => spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8' });
    const fresh = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-artifacts-'));
        for (const sub of ['deb', 'appimage', 'nsis', 'msi']) fs.mkdirSync(path.join(dir, sub));
        fs.writeFileSync(path.join(dir, 'Markydowny-1.0.0-universal.dmg'), 'dmg');
        for (const arch of ['amd64', 'arm64']) fs.writeFileSync(path.join(dir, 'deb', `Markydowny_1.0.0_${arch}.deb`), arch);
        for (const arch of ['amd64', 'aarch64']) fs.writeFileSync(path.join(dir, 'appimage', `Markydowny_1.0.0_${arch}.AppImage`), arch);
        fs.writeFileSync(path.join(dir, 'nsis', 'Markydowny_1.0.0_x64-setup.exe'), 'exe');
        fs.writeFileSync(path.join(dir, 'msi', 'Markydowny_1.0.0_x64_en-US.msi'), 'msi');
        return dir;
    };
    const dir = fresh();
    const ok = run(dir);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.deepEqual(fs.readdirSync(dir).sort(), [
        'Markydowny-1.0.0-universal.dmg', 'Markydowny_1.0.0_aarch64.AppImage', 'Markydowny_1.0.0_amd64.AppImage',
        'Markydowny_1.0.0_amd64.deb', 'Markydowny_1.0.0_arm64.deb', 'Markydowny_1.0.0_x64-setup.exe',
        'Markydowny_1.0.0_x64_en-US.msi',
    ]);
    // Two files with one name: the step fails instead of silently dropping one.
    const clash = fresh();
    fs.writeFileSync(path.join(clash, 'Markydowny_1.0.0_amd64.deb'), 'other');
    const bad = run(clash);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /same name/);
});

test('the Windows installers are built, checked for the crash reporting helpers, and attached', () => {
    const { windows } = jobs();
    // MSVC on PATH for bugsplat-sys, and the build in PowerShell, where Git Bash's link.exe can't
    // shadow MSVC's.
    assert.match(windows, /- uses: ilammy\/msvc-dev-cmd@v1\n\s+with:\n\s+arch: x64\n/);
    assert.doesNotMatch(step(windows, 'Build the installers'), /shell: bash/);
    const check = step(windows, 'Check the crash reporting helpers are installed');
    assert.doesNotMatch(check, /shell: bash/);
    assert.match(check, /'markydowny\.exe', 'BugSplatMonitor\.exe', 'BugSplatReporter\.exe', 'theme\\theme\.json'/);
    assert.match(check, /-ArgumentList '\/S', "\/D=\$nsis"/);
    assert.match(check, /msiexec\.exe -ArgumentList '\/a'/);
    // Unsigned for now, said so in the summary, with the spot for signing marked.
    assert.match(windows, /# TODO\(windows-signing\)/);
    assert.match(step(windows, 'Code signing'), /\*\*not code-signed\*\*/);
    // The .pdb goes up as it is: no dump_syms.
    const symbols = step(windows, 'Upload symbols');
    assert.match(symbols, /npx symbol-upload -a Markydowny -v "\$VERSION" -d src-tauri\/target\/release -f "markydowny\.\{exe,pdb\}"\n/);
    assert.doesNotMatch(symbols, / -m\b/);
    assert.match(windows, /name: windows-x64\n\s+path: \|\n\s+src-tauri\/target\/release\/bundle\/nsis\/\*-setup\.exe\n\s+src-tauri\/target\/release\/bundle\/msi\/\*\.msi\n/);
});

test('the Windows packages carry the crash reporting helpers next to the executable', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.windows.conf.json'), 'utf8'));
    assert.deepEqual(conf.bundle.targets, ['nsis', 'msi']);
    assert.deepEqual(conf.bundle.resources, {
        'bugsplat-helpers/BugSplatMonitor.exe': 'BugSplatMonitor.exe',
        'bugsplat-helpers/BugSplatReporter.exe': 'BugSplatReporter.exe',
        'bugsplat-helpers/theme': 'theme',
    });
    // Explorer opens the same files with Markydowny as Finder does: Tauri's Windows bundlers
    // register the base config's file associations.
    const base = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    assert.equal(conf.bundle.fileAssociations, undefined);
    assert.deepEqual(base.bundle.fileAssociations[0].ext, ['md', 'markdown', 'mdown', 'mkd', 'mkdn']);
});

test('a pull request that changes the Windows bundle runs the release dry run', () => {
    const on = workflow.split(/^on:\n/m)[1].split(/^\S/m)[0];
    assert.match(on, /^ {6}- src-tauri\/tauri\.windows\.conf\.json$/m);
    assert.match(on, /^ {6}- src-tauri\/src\/bundled_helpers\.rs$/m);
});
