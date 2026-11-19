const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'build-desktop.sh');

function run(...args) {
    return spawnSync('bash', [script, ...args], { encoding: 'utf8' });
}

const expectedArtifact = {
    darwin: 'src-tauri/target/debug/bundle/macos/Markydowny.app',
    linux: 'src-tauri/target/debug/markydowny',
}[process.platform];

test('build-desktop.sh --print-path names the artifact for this OS without building', {
    skip: !expectedArtifact && 'Windows is not a desktop target',
}, () => {
    const result = run('--print-path');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), path.join(root, expectedArtifact));
});

test('build-desktop.sh refuses arguments it does not know', () => {
    const result = run('--release');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown argument: --release/);
});

test("the artifact paths match the app's names in the Tauri config", () => {
    // A rename in tauri.conf.json or Cargo.toml must be made in the script too.
    const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, new RegExp(`bundle/macos/${conf.productName}\\.app`));
    const crate = cargo.match(/^name = "([^"]+)"/m)[1];
    assert.match(source, new RegExp(`target/debug/${crate}"`));
});

test('the Linux packages the script installs include WebKitGTK 4.1 (Tauri 2) and CMake and Ninja (BugSplat)', () => {
    const source = fs.readFileSync(script, 'utf8');
    const packages = source.match(/LINUX_PACKAGES=\(([^)]*)\)/)[1].split(/\s+/);
    for (const pkg of ['libwebkit2gtk-4.1-dev', 'libgtk-3-dev', 'pkg-config', 'build-essential', 'clang', 'cmake', 'ninja-build']) {
        assert.ok(packages.includes(pkg), `${pkg} is missing`);
    }
});

test('the script stops on a glibc older than 2.35, the floor the release packages promise', () => {
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, /^MIN_GLIBC=2\.35$/m);
    assert.match(source, /needs \$MIN_GLIBC or newer \(Ubuntu 22\.04, Debian 12\)/);
    const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(release, /MAX_GLIBC: "2\.35"/);
});

test("on Linux the script fetches CMake when the one on PATH is older than bugsplat-native's 3.24", () => {
    // Ubuntu 22.04's cmake is 3.22.
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, /^MIN_CMAKE=3\.24$/m);
    assert.match(source, /cmake-\$\{CMAKE_VERSION\}-linux-\$cmake_arch\.tar\.gz/);
});

test('build-desktop.sh is plain ASCII, which macOS bash 3.2 needs', () => {
    // Bash 3.2 read "$NODE_VERSION…" as one long variable name and failed on it.
    const source = fs.readFileSync(script, 'utf8');
    const offending = [...source].findIndex(ch => ch.charCodeAt(0) > 127);
    assert.equal(offending, -1, `non-ASCII character at offset ${offending}`);
});

test("supermog's Linux desktop round runs this script in an image that has the script's packages", () => {
    const config = fs.readFileSync(path.join(root, '.supermog.yml'), 'utf8');
    const linux = config.slice(config.indexOf('    linux:'));
    assert.match(linux, /^\s+build: scripts\/build-desktop\.sh$/m);
    const dockerfile = linux.match(/^\s+dockerfile: (\S+)$/m)[1];
    const image = fs.readFileSync(path.join(root, dockerfile), 'utf8');
    // Debian 13 (glibc 2.41), above the 2.35 floor (MIN_GLIBC in the script), with a Clang new
    // enough for Crashpad's headers.
    assert.match(image, /^FROM rust:1-trixie$/m);
    const packages = fs.readFileSync(script, 'utf8').match(/^LINUX_PACKAGES=\(([^)]*)\)/m)[1].split(/\s+/).filter(Boolean);
    assert.ok(packages.length > 5);
    for (const name of packages) assert.match(image, new RegExp(`\\s${name.replace(/[.+]/g, '\\$&')}\\s`), `${name} is missing from ${dockerfile}`);
});

test('a pull request that changes the desktop app is one a round verifies', () => {
    const config = fs.readFileSync(path.join(root, '.supermog.yml'), 'utf8');
    const lists = [...config.matchAll(/^\s+paths: (\[.*\])$/gm)].map((m) => JSON.parse(m[1]));
    // verify.paths, then verify.desktop.macos.paths and verify.desktop.linux.paths. Without
    // src-tauri in the first, no round runs at all; without it in the last, no desktop is driven.
    assert.equal(lists.length, 3);
    const [verify, , linux] = lists;
    for (const list of [verify, linux]) assert.ok(list.includes('src-tauri/**'));
});

test("supermog's macOS desktop round builds with this script and launches the app Tauri names", () => {
    const config = fs.readFileSync(path.join(root, '.supermog.yml'), 'utf8');
    const macos = config.slice(config.indexOf('    macos:'), config.indexOf('    linux:'));
    assert.match(macos, /^\s+build: scripts\/build-desktop\.sh$/m);
    // The round refuses a built .app whose bundle id is not the one declared.
    const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    assert.equal(macos.match(/^\s+bundleId: (\S+)$/m)[1], conf.identifier);
    // macOS is for what only a Mac shows. Each file named has to exist, and has to be one a round
    // runs for at all (verify.paths covers src-tauri/**).
    const paths = JSON.parse(macos.match(/^\s+paths: (\[.*\])$/m)[1]);
    assert.ok(paths.length > 0);
    for (const file of paths) {
        assert.ok(file.startsWith('src-tauri/'), `${file} is outside src-tauri/, which verify.paths does not cover`);
        assert.ok(fs.existsSync(path.join(root, file)), `${file} does not exist`);
    }
});
