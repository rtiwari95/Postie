# Postie — Windows installer (x64)
#
# Usage (from PowerShell, in the project root):
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Installer path\to\Postie-Setup.exe
#
# What it does:
#   1. Locates the NSIS installer in dist\ (or accepts an explicit path)
#   2. Unblocks the .exe so SmartScreen doesn't refuse to launch it
#   3. Runs the installer (interactive — choose install location, etc.)

[CmdletBinding()]
param(
    [string]$Installer = ""
)

$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
    Write-Error "This script is for Windows only."
    exit 1
}

if ([System.Environment]::Is64BitOperatingSystem -eq $false) {
    Write-Error "Postie ships only for x64 Windows."
    exit 1
}

# Locate the installer
if (-not $Installer) {
    $candidate = Get-ChildItem -Path "dist" -Filter "Postie Setup *.exe" -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending |
                 Select-Object -First 1
    if ($candidate) {
        $Installer = $candidate.FullName
    }
}

if (-not $Installer -or -not (Test-Path $Installer)) {
    Write-Error "No installer found in dist\. Pass -Installer <path> or build first (see setup.md)."
    exit 1
}

Write-Host "==> Installing from: $Installer"

# Strip MOTW (mark-of-the-web) so SmartScreen doesn't block the unsigned exe
Write-Host "==> Unblocking installer"
Unblock-File -Path $Installer

Write-Host "==> Launching installer (follow the on-screen prompts)"
Start-Process -FilePath $Installer -Wait

Write-Host ""
Write-Host "Done. Launch Postie from the Start Menu or Desktop shortcut."
