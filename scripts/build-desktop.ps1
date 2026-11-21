# Builds the desktop app on Windows and prints the built markydowny.exe's path as the last line
# of output. The Windows counterpart of build-desktop.sh, for Windows PowerShell 5.1 and later.
#
#   Windows x64: the debug markydowny.exe, with the web UI embedded. It needs the WebView2
#   runtime at run time (Windows 11 has it).
#
# It's meant for a fresh machine or VM, so it installs what it can:
#   - Rust, through rustup-init.exe, at the version rust-toolchain.toml names;
#   - Node 22, into %USERPROFILE%\.cache\markydowny, when there's no Node 20 or newer;
#   - CMake and Ninja, which BugSplat's native code needs, from their official releases into
#     %USERPROFILE%\.cache\markydowny when they aren't on PATH (or CMake is older than 3.24).
# The MSVC C++ Build Tools (the VCTools workload, with a Windows SDK) must already be installed.
# When cl.exe isn't on PATH, the script finds them with vswhere and loads their environment, as
# a Developer PowerShell would: bugsplat-sys needs MSVC's compiler, linker and lib.exe on PATH.
#
# Crash reporting is off unless BUGSPLAT_DATABASE is set. Building downloads Crashpad, so it
# needs network access either way.
#
#   scripts\build-desktop.ps1               build, then print the artifact's path
#   scripts\build-desktop.ps1 -PrintPath    print the path the build would produce, and stop
#
# Keep this file ASCII: Windows PowerShell 5.1 reads a .ps1 without a byte-order mark as the
# ANSI code page.
param([switch]$PrintPath)

# Cmdlets that should end the build say -ErrorAction Stop. The default stays Continue, inherited
# or not, because with Stop a native program's stderr (cargo's progress) can become a
# terminating error when the output is redirected. Native programs are checked with Assert-Exit.
$ErrorActionPreference = "Continue"
# Invoke-WebRequest is many times slower with its progress bar.
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$NODE_VERSION = "22.21.1"
$CMAKE_VERSION = "4.5.0"
$NINJA_VERSION = "1.13.2"
# bugsplat-native's cmake_minimum_required.
$MIN_CMAKE = [version]"3.24"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$artifact = Join-Path $root "src-tauri\target\debug\markydowny.exe"

function Log($message) { [Console]::Error.WriteLine($message) }
function Fail($message) {
    Log "build-desktop: $message"
    exit 1
}
# Stops the build when the native program that just ran failed.
function Assert-Exit($what) {
    if ($LASTEXITCODE) { Fail "$what failed (exit code $LASTEXITCODE)" }
}
function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Add-Path($dir) { $env:PATH = "$dir;$env:PATH" }
function Get-File($url, $file) {
    Log "Downloading $url..."
    Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing -ErrorAction Stop
}
# Unpacks a .zip with Windows' bsdtar, much faster than Expand-Archive on Node's thousands of files.
function Expand-Zip($zip, $dest) {
    New-Item -ItemType Directory -Force -Path $dest -ErrorAction Stop | Out-Null
    & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $dest
    Assert-Exit "unpacking $zip"
    Remove-Item $zip -ErrorAction Stop
}

if ($PrintPath) {
    Write-Output $artifact
    exit 0
}

# BugSplat's Crashpad and the Node and CMake downloads here are x64 builds.
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { Fail "unsupported architecture: $env:PROCESSOR_ARCHITECTURE (Windows x64 only)" }

# --- System dependencies --------------------------------------------------------------------

$cache = Join-Path $env:USERPROFILE ".cache\markydowny"
New-Item -ItemType Directory -Force -Path $cache -ErrorAction Stop | Out-Null

if (-not (Test-Command cl.exe)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { Fail "the MSVC C++ Build Tools are missing: install the Visual Studio Build Tools with the C++ workload" }
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { Fail "the MSVC C++ Build Tools are missing: install the Visual Studio Build Tools with the C++ workload" }
    $vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
    Log "Loading the MSVC environment from $vcvars..."
    # Run vcvars64.bat in cmd and copy the environment it leaves into this process.
    $vars = & cmd.exe /d /c "`"$vcvars`" >nul && set"
    Assert-Exit "vcvars64.bat"
    foreach ($line in $vars) {
        if ($line -match "^([^=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process") }
    }
    if (-not (Test-Command cl.exe)) { Fail "cl.exe is still not on PATH after $vcvars" }
}

$cmakeVersion = $null
if (Test-Command cmake) {
    $line = (& cmake --version | Select-Object -First 1)
    if ($line -match "(\d+\.\d+\.\d+)") { $cmakeVersion = [version]$Matches[1] }
}
if (-not $cmakeVersion -or $cmakeVersion -lt $MIN_CMAKE) {
    $cmakeDir = Join-Path $cache "cmake-$CMAKE_VERSION-windows-x86_64"
    if (-not (Test-Path (Join-Path $cmakeDir "bin\cmake.exe"))) {
        Log "Installing CMake $CMAKE_VERSION..."
        $zip = Join-Path $cache "cmake.zip"
        Get-File "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-windows-x86_64.zip" $zip
        Expand-Zip $zip $cache
    }
    Add-Path (Join-Path $cmakeDir "bin")
}

if (-not (Test-Command ninja)) {
    $ninjaDir = Join-Path $cache "ninja-$NINJA_VERSION"
    if (-not (Test-Path (Join-Path $ninjaDir "ninja.exe"))) {
        Log "Installing Ninja $NINJA_VERSION..."
        $zip = Join-Path $cache "ninja-win.zip"
        Get-File "https://github.com/ninja-build/ninja/releases/download/v$NINJA_VERSION/ninja-win.zip" $zip
        Expand-Zip $zip $ninjaDir
    }
    Add-Path $ninjaDir
}

# --- Rust -----------------------------------------------------------------------------------

if (-not (Test-Command cargo)) {
    $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }
    $cargoBin = Join-Path $cargoHome "bin"
    if (-not (Test-Path (Join-Path $cargoBin "cargo.exe"))) {
        Log "Installing Rust with rustup..."
        $rustupInit = Join-Path $cache "rustup-init.exe"
        Get-File "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" $rustupInit
        & $rustupInit -y --profile minimal --default-toolchain none
        Assert-Exit "rustup-init"
    }
    Add-Path $cargoBin
}
# rust-toolchain.toml picks the version. `rustup toolchain install` with no name installs it
# (rustup 1.28+); with an older rustup, or a Rust without rustup, cargo's first run does.
Push-Location $root
if (Test-Command rustup) { & rustup toolchain install }
& cargo --version
Assert-Exit "cargo --version"
Pop-Location

# --- Node -----------------------------------------------------------------------------------

$nodeMajor = 0
if (Test-Command node) { $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]") }
if ($nodeMajor -lt 20) {
    $nodeDir = Join-Path $cache "node-v$NODE_VERSION-win-x64"
    if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
        Log "Installing Node $NODE_VERSION..."
        $zip = Join-Path $cache "node.zip"
        Get-File "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip" $zip
        Expand-Zip $zip $cache
    }
    Add-Path $nodeDir
}

# --- Build ----------------------------------------------------------------------------------

Set-Location $root
Log "Installing npm dependencies..."
# --include=dev: the Tauri CLI is a devDependency, which NODE_ENV=production would otherwise omit.
& npm ci --include=dev --no-audit --no-fund
Assert-Exit "npm ci"
# No bundle: the .exe is the app, and the installers need more tools. Without the installer, the
# BugSplat helpers aren't next to the .exe, which is fine with crash reporting off.
& npx tauri build --debug --no-bundle
Assert-Exit "tauri build"

if (-not (Test-Path $artifact)) { Fail "the build finished but $artifact is missing" }
Write-Output $artifact
exit 0
