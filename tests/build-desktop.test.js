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

test("supermog's jobs run in this repo's own image, which carries the Rust and Linux packages cargo test needs (#79)", () => {
    const config = fs.readFileSync(path.join(root, '.supermog.yml'), 'utf8');
    const dockerfile = config.match(/^image: (\S+)$/m)[1];
    const image = fs.readFileSync(path.join(root, dockerfile), 'utf8');
    // Layered on supermog's own job image, and back to its user at the end (supermog#1049).
    assert.match(image, /^ARG SUPERMOG_JOB_IMAGE\nFROM \$\{SUPERMOG_JOB_IMAGE\}$/m);
    assert.match(image.trimEnd(), /\nUSER supermog$/);
    // The repository is never copied in: any edit would then rebuild the image on every box.
    assert.doesNotMatch(image, /^\s*(COPY|ADD)\s/m);
    const packages = fs.readFileSync(script, 'utf8').match(/^LINUX_PACKAGES=\(([^)]*)\)/m)[1].split(/\s+/).filter(Boolean);
    for (const name of [...packages, 'libayatana-appindicator3-dev']) {
        assert.match(image, new RegExp(`\\s${name.replace(/[.+]/g, '\\$&')}\\s`), `${name} is missing from ${dockerfile}`);
    }
    // Rust where the job's PATH looks for it, a pinned and checksummed rustup, and a fixed toolchain
    // that overrides rust-toolchain.toml's `stable`, so jobs don't fetch a newer one each time.
    assert.match(image, /^ARG RUST_VERSION=\d+\.\d+\.\d+$/m);
    assert.match(image, /RUSTUP_TOOLCHAIN=\$\{RUST_VERSION\}/);
    assert.match(image, /RUSTUP_HOME=\/opt\/rust\/rustup/);
    assert.match(image, /export CARGO_HOME=\/opt\/rust\/cargo;/);
    assert.match(image, /sha256sum -c/);
    assert.match(image, /--profile minimal --component rustfmt,clippy/);
    assert.match(image, /rustup set auto-self-update disable/);
    // CARGO_HOME stays out of the image's environment: the fleet mounts the crate cache at
    // ~/.cargo/{registry,git}, and moving CARGO_HOME off it re-downloads every crate every job.
    const instructions = image.replace(/\\\n/g, ' ').split('\n').filter((line) => /^[A-Z]+\s/.test(line));
    const env = instructions.filter((line) => /^(ENV|ARG)\s/.test(line));
    assert.ok(env.length > 0);
    for (const line of env) assert.doesNotMatch(line, /CARGO_HOME/);
});

test('a pull request that changes the desktop app is one a round verifies', () => {
    const config = fs.readFileSync(path.join(root, '.supermog.yml'), 'utf8');
    const lists = [...config.matchAll(/^\s+paths: (\[.*\])$/gm)].map((m) => JSON.parse(m[1]));
    // verify.paths, then verify.desktop.macos.paths, .linux.paths and .windows.paths. Without
    // src-tauri in the first, no round runs at all; without it in Linux's, no desktop is driven.
    assert.equal(lists.length, 4);
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

const psScript = path.join(root, 'scripts', 'build-desktop.ps1');

test('build-desktop.ps1 is plain ASCII, which Windows PowerShell 5.1 needs', () => {
    // Without a byte-order mark, PowerShell 5.1 reads a .ps1 as the ANSI code page.
    const source = fs.readFileSync(psScript, 'utf8');
    const offending = [...source].findIndex(ch => ch.charCodeAt(0) > 127);
    assert.equal(offending, -1, `non-ASCII character at offset ${offending}`);
});

test("build-desktop.ps1 builds the .exe Tauri names and prints its path last", () => {
    const source = fs.readFileSync(psScript, 'utf8');
    const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    const crate = cargo.match(/^name = "([^"]+)"/m)[1];
    assert.match(source, new RegExp(`"src-tauri\\\\target\\\\debug\\\\${crate}\\.exe"`));
    assert.match(source, /npx tauri build --debug --no-bundle\n/);
    // Nothing is printed after the path: the round launches whatever the last line names.
    const tail = source.trimEnd().split('\n').slice(-2);
    assert.deepEqual(tail, ['Write-Output $artifact', 'exit 0']);
});

test('build-desktop.ps1 checks every native step, and installs the versions build-desktop.sh does', () => {
    const source = fs.readFileSync(psScript, 'utf8');
    // A failed step has to end the build: only the last program's exit code reaches the round.
    for (const step of ['& npm ci', '& npx tauri build', '& $rustupInit', '& cargo --version']) {
        const at = source.indexOf(step);
        assert.ok(at >= 0, `${step} is missing`);
        const next = source.slice(at).split('\n')[1];
        assert.match(next, /^\s*Assert-Exit /, `${step} is not followed by Assert-Exit`);
    }
    // A program that can't start, or a failed download, ends only its statement under Continue,
    // and Assert-Exit would then read the previous program's exit code.
    assert.match(source, /^trap \{ Fail /m);
    assert.match(source, /try \{ Invoke-WebRequest .*\}\n\s*catch \{ Fail /);
    // BugSplatReporter needs ATL, which a bare Build Tools install lacks: add it before the build
    // fails deep in bugsplat-sys, and wait for the installer, a GUI program & doesn't wait for.
    assert.match(source, /Microsoft\.VisualStudio\.Component\.VC\.ATL/);
    assert.match(source, /Start-Process -FilePath \$installer -Wait -PassThru/);
    assert.ok(source.indexOf('Test-Atl') < source.indexOf('& npx tauri build'));
    // Stop would turn cargo's stderr into a terminating error when the output is redirected.
    assert.match(source, /^\$ErrorActionPreference = "Continue"$/m);
    assert.match(source, /^\$ProgressPreference = "SilentlyContinue"$/m);
    const sh = fs.readFileSync(script, 'utf8');
    for (const name of ['NODE_VERSION', 'CMAKE_VERSION', 'NINJA_VERSION']) {
        const version = sh.match(new RegExp(`^${name}=(\\S+)$`, 'm'))[1];
        assert.match(source, new RegExp(`^\\$${name} = "${version.replace(/\./g, '\\.')}"$`, 'm'), `${name} differs from build-desktop.sh`);
    }
});

test("supermog's Windows desktop round builds with build-desktop.ps1 and runs for what only Windows shows", () => {
    const config = fs.readFileSync(path.join(root, '.supermog.yml'), 'utf8');
    const windows = config.slice(config.indexOf('    windows:'));
    assert.match(windows, /^\s+build: \.\\scripts\\build-desktop\.ps1$/m);
    const paths = JSON.parse(windows.match(/^\s+paths: (\[.*\])$/m)[1]);
    assert.ok(paths.includes('scripts/build-desktop.ps1'));
    for (const file of paths) assert.ok(fs.existsSync(path.join(root, file)), `${file} does not exist`);
    // verify.paths has to cover them too, or no round runs at all.
    const verify = JSON.parse(config.match(/^  paths: (\[.*\])$/m)[1]);
    assert.ok(verify.includes('scripts/build-desktop.ps1'));
    assert.ok(verify.includes('src-tauri/**'));
});

test("CI's windows job builds with build-desktop.ps1 in Windows PowerShell, as a round does", () => {
    const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('\n  windows:'));
    assert.match(job, /^\s+shell: powershell$/m);
    assert.match(job, /^\s+\.\\scripts\\build-desktop\.ps1$/m);
});
