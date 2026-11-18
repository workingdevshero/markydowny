// Checks that a release tag matches the version in package.json, src-tauri/Cargo.toml and
// src-tauri/tauri.conf.json, and prints that version. The release workflow runs it before
// building anything, so a tag pushed without bumping all three fails fast and names the file.
//
//   node scripts/check-release-version.mjs v1.2.0   the tag must match all three files
//   node scripts/check-release-version.mjs           the three files must agree with each other
//
// Exits 1 with a message on stderr when they don't. Under GitHub Actions it also writes
// `version=` and `prerelease=` to $GITHUB_OUTPUT. A tag with a hyphen (v1.1.0-beta.1) is a
// prerelease.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION_FILES = ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json'];

// SemVer: major.minor.patch, an optional -prerelease and an optional +build.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The version a `v<semver>` tag names, or null when the tag isn't one. */
export function parseTag(tag) {
    const m = /^v(.+)$/.exec(tag ?? '');
    return m && SEMVER.test(m[1]) ? m[1] : null;
}

export function isPrerelease(version) {
    return SEMVER.exec(version)?.[4] !== undefined;
}

/** The `version` in Cargo.toml's [package] table, or null. */
export function cargoVersion(toml) {
    let inPackage = false;
    for (const line of toml.split(/\r?\n/)) {
        const table = /^\s*\[([^\]]+)\]/.exec(line);
        if (table) {
            inPackage = table[1].trim() === 'package';
            continue;
        }
        const m = inPackage && /^\s*version\s*=\s*"([^"]*)"/.exec(line);
        if (m) return m[1];
    }
    return null;
}

/** The version each of VERSION_FILES declares, keyed by its path, or null where it has none. */
export function readVersions(root = ROOT) {
    const read = file => readFileSync(join(root, file), 'utf8');
    return {
        'package.json': JSON.parse(read('package.json')).version ?? null,
        'src-tauri/Cargo.toml': cargoVersion(read('src-tauri/Cargo.toml')),
        'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version ?? null,
    };
}

/**
 * Checks `versions` (from readVersions) against `tag`, or against each other with no tag.
 * Returns { version, prerelease } or { errors }, one message per problem.
 */
export function checkReleaseVersion(tag, versions) {
    let expected;
    let source;
    if (tag !== undefined) {
        expected = parseTag(tag);
        if (!expected) return { errors: [`"${tag}" isn't a version tag: expected v<major>.<minor>.<patch>, like v1.2.0 or v1.2.0-beta.1`] };
        source = `the tag ${tag}`;
    } else {
        expected = versions['package.json'];
        source = 'package.json';
    }
    const errors = [];
    for (const file of VERSION_FILES) {
        const found = versions[file];
        if (found == null) errors.push(`${file} has no version`);
        else if (found !== expected) errors.push(`${file} has version ${found}, but ${source} says ${expected}`);
    }
    if (errors.length) return { errors };
    if (!SEMVER.test(expected)) return { errors: [`${expected} isn't a version: expected <major>.<minor>.<patch>`] };
    return { version: expected, prerelease: isPrerelease(expected) };
}

export function main(args = process.argv.slice(2), { root = ROOT, env = process.env } = {}) {
    if (args.length > 1) {
        console.error('usage: node scripts/check-release-version.mjs [v<version>]');
        return 1;
    }
    const result = checkReleaseVersion(args[0], readVersions(root));
    if (result.errors) {
        for (const e of result.errors) console.error(`check-release-version: ${e}`);
        if (args[0] !== undefined) console.error(`Bump the version in ${VERSION_FILES.join(', ')} to match, then tag again.`);
        return 1;
    }
    if (env.GITHUB_OUTPUT) {
        appendFileSync(env.GITHUB_OUTPUT, `version=${result.version}\nprerelease=${result.prerelease}\n`);
    }
    console.log(result.version);
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exitCode = main();
}
