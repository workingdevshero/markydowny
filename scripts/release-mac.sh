#!/usr/bin/env bash
# Builds a release of the Mac app, signs it with a Developer ID, notarizes it and packages it as
# a .dmg that opens without Gatekeeper warnings. Prints the .dmg's path as the last line; its
# SHA-256 is written next to it.
#
#   scripts/release-mac.sh             build, sign, notarize, staple, package
#   scripts/release-mac.sh --dry-run   print every step instead of running it (no credentials)
#
# Options (or the same names as environment variables):
#   --arch universal|arm64|x86_64   ARCH, default universal (Apple silicon and Intel in one app)
#   --identity "<name>"             SIGNING_IDENTITY, default the keychain's only
#                                   "Developer ID Application" identity
#   --notary-profile <name>         NOTARY_PROFILE, default markydowny-notary: a keychain profile
#                                   made once with `xcrun notarytool store-credentials`
#   --no-notarize                   stop after packaging. With --identity - (ad-hoc), this tests
#                                   the build, signing and packaging without a Developer ID
#
# Nothing secret is read from or written to the repository: the signing key stays in the
# keychain, and notarytool reads its credentials from the keychain profile.
#
# Set BUGSPLAT_DATABASE to build with crash reporting on.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dry_run=false
arch=${ARCH:-universal}
identity=${SIGNING_IDENTITY:-}
notary_profile=${NOTARY_PROFILE:-markydowny-notary}
notarize=true

log() { printf '%s\n' "$*" >&2; }
fail() {
    log "release-mac: $*"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) dry_run=true ;;
        --arch) arch=${2:?--arch needs a value}; shift ;;
        --identity) identity=${2:?--identity needs a value}; shift ;;
        --notary-profile) notary_profile=${2:?--notary-profile needs a value}; shift ;;
        --no-notarize) notarize=false ;;
        *) fail "unknown argument: $1" ;;
    esac
    shift
done

case "$arch" in
    universal) target=universal-apple-darwin ;;
    arm64) target=aarch64-apple-darwin ;;
    x86_64) target=x86_64-apple-darwin ;;
    *) fail "unknown --arch: $arch (universal, arm64 or x86_64)" ;;
esac

# Runs a step, or with --dry-run prints it. Every step that changes something goes through here.
step() {
    if $dry_run; then
        printf 'step:'
        printf ' %q' "$@"
        printf '\n'
    else
        log "+ $*"
        "$@" >&2
    fi
}

[[ "$(uname -s)" == "Darwin" ]] || fail "this builds the Mac app; run it on a Mac"
[[ "$identity" != "-" ]] || ! $notarize || fail "an ad-hoc signature (--identity -) can't be notarized; add --no-notarize"
cd "$root"

version=$(node -p "require('$root/src-tauri/tauri.conf.json').version")
product=$(node -p "require('$root/src-tauri/tauri.conf.json').productName")
app="$root/src-tauri/target/$target/release/bundle/macos/$product.app"
dist="$root/dist-release"
dmg="$dist/$product-$version-$arch.dmg"

if [[ -z "$identity" ]]; then
    if $dry_run; then
        identity="Developer ID Application: Example (TEAMID)"
    else
        identities=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | tr -d '"' || true)
        count=$(grep -c . <<< "$identities" || true)
        [[ "$count" -eq 1 ]] || fail "found $count Developer ID Application identities; pass --identity"
        identity=$identities
    fi
fi
log "Releasing $product $version ($arch), signed as \"$identity\""

# --- Build ----------------------------------------------------------------------------------

# Unset so Tauri doesn't sign on its own: the helpers have to be signed before the app.
unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_ID APPLE_PASSWORD APPLE_API_KEY
if [[ "$target" == "universal-apple-darwin" ]]; then
    step rustup target add aarch64-apple-darwin x86_64-apple-darwin
else
    step rustup target add "$target"
fi
step npm ci --no-audit --no-fund
step npx tauri build --bundles app --target "$target"

# --- Universal helpers ----------------------------------------------------------------------

# A universal build compiles the app once per architecture and lipos the main binary, but the
# BugSplat helpers reach the bundle through build.rs's single bugsplat-helpers/ folder, which the
# second architecture's build overwrites: they came out Intel-only. Merge each architecture's own
# build of them instead.
helper_build() { # <rust target> <path under bugsplat-native/>
    local found
    found=$(ls -td "src-tauri/target/$1/release/build"/bugsplat-sys-*/out/build/bugsplat-native/"$2" 2>/dev/null | head -1 || true)
    if [[ -z "$found" ]]; then
        $dry_run || fail "no $2 built for $1"
        found="src-tauri/target/$1/release/build/bugsplat-sys-<hash>/out/build/bugsplat-native/$2"
    fi
    printf '%s\n' "$found"
}
reporter_exe=BugSplatReporter.app/Contents/MacOS/BugSplatReporter
if [[ "$target" == "universal-apple-darwin" ]]; then
    step lipo -create \
        "$(helper_build aarch64-apple-darwin monitor/BugSplatMonitor)" \
        "$(helper_build x86_64-apple-darwin monitor/BugSplatMonitor)" \
        -output "$app/Contents/Helpers/BugSplatMonitor"
    step lipo -create \
        "$(helper_build aarch64-apple-darwin "reporter/$reporter_exe")" \
        "$(helper_build x86_64-apple-darwin "reporter/$reporter_exe")" \
        -output "$app/Contents/Helpers/$reporter_exe"
fi

# Every executable in the bundle must carry each architecture the release promises.
case "$arch" in
    universal) want="arm64 x86_64" ;;
    *) want=$arch ;;
esac
for exe in "$app/Contents/MacOS/markydowny" "$app/Contents/Helpers/BugSplatMonitor" "$app/Contents/Helpers/$reporter_exe"; do
    if $dry_run; then
        step lipo -archs "$exe"
        continue
    fi
    have=$(lipo -archs "$exe")
    for a in $want; do
        [[ " $have " == *" $a "* ]] || fail "${exe#"$app/"} is $have, missing $a"
    done
    log "${exe#"$app/"}: $have"
done

# --- Sign, inside out -----------------------------------------------------------------------

# Notarization needs every executable signed with the hardened runtime and a secure timestamp.
# The BugSplat helpers are signed first, because signing the app seals what's inside it.
sign() {
    if [[ "$identity" == "-" ]]; then
        # Ad-hoc, for testing: there's no timestamp server for it.
        step codesign --force --options runtime --sign - "$@"
    else
        step codesign --force --timestamp --options runtime --sign "$identity" "$@"
    fi
}
sign "$app/Contents/Helpers/BugSplatMonitor"
sign "$app/Contents/Helpers/BugSplatReporter.app"
sign "$app"
step codesign --verify --deep --strict --verbose=2 "$app"

# --- Package --------------------------------------------------------------------------------

# hdiutil, not Tauri's dmg bundler: that one drives Finder with AppleScript to lay out the
# window, which opens windows on the screen of whoever runs it.
staging="$dist/dmg-staging"
step rm -rf "$staging" "$dmg"
step mkdir -p "$staging"
step ditto "$app" "$staging/$product.app"
step ln -s /Applications "$staging/Applications"
step hdiutil create -volname "$product" -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$dmg"
step rm -rf "$staging"
sign "$dmg"

# --- Notarize -------------------------------------------------------------------------------

if $notarize; then
    step xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait
    # Stapling attaches the ticket, so Gatekeeper accepts the app offline too.
    step xcrun stapler staple "$dmg"
    step xcrun stapler validate "$dmg"
    step spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
else
    log "Not notarized (--no-notarize): Gatekeeper will block this .dmg on other Macs"
fi

if $dry_run; then
    step shasum -a 256 "$dmg"
else
    (cd "$dist" && shasum -a 256 "$(basename "$dmg")" > "$(basename "$dmg").sha256")
    log "SHA-256: $(cut -d' ' -f1 "$dmg.sha256")"
fi
printf '%s\n' "$dmg"
