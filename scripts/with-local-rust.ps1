$ErrorActionPreference = "Stop"

$scriptArguments = @($args)
if ($scriptArguments.Count -eq 0) {
    throw "Usage: with-local-rust.ps1 <command> [arguments]"
}

$Command = [string]$scriptArguments[0]
[string[]]$CommandArgs = @()
if ($scriptArguments.Count -gt 1) {
    $CommandArgs = @($scriptArguments[1..($scriptArguments.Count - 1)])
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolchainFile = Join-Path $repositoryRoot "rust-toolchain.toml"
$localRoot = Join-Path $repositoryRoot ".local"
$toolchainsRoot = Join-Path $localRoot "rustup\toolchains"

if (-not (Test-Path -LiteralPath $toolchainFile -PathType Leaf)) {
    throw "Missing Rust toolchain contract: $toolchainFile"
}

$toolchainContents = Get-Content -LiteralPath $toolchainFile -Raw
$channelMatches = [regex]::Matches(
    $toolchainContents,
    '(?m)^\s*channel\s*=\s*"([^"]+)"\s*$'
)

if ($channelMatches.Count -ne 1) {
    throw "Expected exactly one Rust channel in $toolchainFile"
}

$requiredVersion = $channelMatches[0].Groups[1].Value
if ($requiredVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "The portable Rust launcher requires an exact version, found: $requiredVersion"
}

if (-not (Test-Path -LiteralPath $toolchainsRoot -PathType Container)) {
    throw "Portable Rust toolchains were not found under $toolchainsRoot"
}

$matchingToolchains = @()
foreach ($toolchainDirectory in Get-ChildItem -LiteralPath $toolchainsRoot -Directory) {
    $rustcPath = Join-Path $toolchainDirectory.FullName "bin\rustc.exe"
    if (-not (Test-Path -LiteralPath $rustcPath -PathType Leaf)) {
        continue
    }

    $rustcDetails = & $rustcPath -Vv 2>&1
    if ($LASTEXITCODE -ne 0) {
        continue
    }

    $releaseMatches = [regex]::Matches(
        ($rustcDetails -join "`n"),
        '(?m)^release:\s*(\S+)\s*$'
    )
    $hostMatches = [regex]::Matches(
        ($rustcDetails -join "`n"),
        '(?m)^host:\s*(\S+)\s*$'
    )
    if (
        $releaseMatches.Count -eq 1 -and
        $releaseMatches[0].Groups[1].Value -eq $requiredVersion -and
        $hostMatches.Count -eq 1 -and
        $hostMatches[0].Groups[1].Value -match '-pc-windows-msvc$'
    ) {
        $matchingToolchains += [PSCustomObject]@{
            Root = $toolchainDirectory.FullName
            Name = $toolchainDirectory.Name
            Host = $hostMatches[0].Groups[1].Value
        }
    }
}

if ($matchingToolchains.Count -eq 0) {
    throw "No portable Rust $requiredVersion MSVC toolchain was found under $toolchainsRoot"
}

$matchingByHost = @{}
foreach ($matchingToolchain in $matchingToolchains) {
    $toolchainHost = $matchingToolchain.Host
    if (-not $matchingByHost.ContainsKey($toolchainHost)) {
        $matchingByHost[$toolchainHost] = @()
    }
    $matchingByHost[$toolchainHost] += $matchingToolchain
}

$canonicalToolchains = @()
foreach ($toolchainHost in $matchingByHost.Keys) {
    $canonicalName = "$requiredVersion-$toolchainHost"
    $canonicalPath = Join-Path $toolchainsRoot $canonicalName
    if (-not (Test-Path -LiteralPath $canonicalPath -PathType Container)) {
        continue
    }

    $canonicalMatches = @(
        $matchingByHost[$toolchainHost] | Where-Object {
            $_.Name -eq $canonicalName -and $_.Root -eq $canonicalPath
        }
    )
    if ($canonicalMatches.Count -ne 1) {
        throw "Canonical portable Rust $requiredVersion toolchain is not a verified $toolchainHost toolchain: $canonicalPath"
    }
    $canonicalToolchains += $canonicalMatches[0]
}

if ($canonicalToolchains.Count -gt 1) {
    throw "Multiple verified canonical portable Rust $requiredVersion MSVC toolchains were found under $toolchainsRoot"
}

if ($canonicalToolchains.Count -eq 1) {
    $selectedToolchain = $canonicalToolchains[0]
} elseif ($matchingToolchains.Count -eq 1) {
    # Legacy aliases remain usable only when the canonical directory is absent.
    $selectedToolchain = $matchingToolchains[0]
} else {
    throw "Multiple portable Rust $requiredVersion MSVC toolchains were found under $toolchainsRoot"
}

$toolchainRoot = $selectedToolchain.Root
$toolchainBin = Join-Path $toolchainRoot "bin"
$requiredExecutables = @(
    "cargo.exe",
    "cargo-clippy.exe",
    "cargo-fmt.exe",
    "clippy-driver.exe",
    "rustc.exe",
    "rustdoc.exe",
    "rustfmt.exe"
)

foreach ($executable in $requiredExecutables) {
    $executablePath = Join-Path $toolchainBin $executable
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "Portable Rust $requiredVersion is missing $executablePath"
    }
}

$env:CARGO_HOME = Join-Path $localRoot "cargo"
$env:RUSTUP_HOME = Join-Path $localRoot "rustup"
$env:CARGO_TARGET_DIR = Join-Path $localRoot "target"
$env:RUSTC = Join-Path $toolchainBin "rustc.exe"
$env:RUSTDOC = Join-Path $toolchainBin "rustdoc.exe"
$env:PATH = "$toolchainBin;$($env:CARGO_HOME)\bin;$($env:PATH)"

if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Command)) {
    throw "Command names cannot contain wildcard characters: $Command"
}

$resolvedCommands = @(Get-Command $Command -CommandType Application, ExternalScript -ErrorAction Stop)
$resolvedCommand = $resolvedCommands[0]
$global:LASTEXITCODE = 0
& $resolvedCommand.Path @CommandArgs
$commandExitCode = $LASTEXITCODE
exit $commandExitCode
