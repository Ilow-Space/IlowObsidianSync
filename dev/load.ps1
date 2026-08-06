# Stop on first error
$ErrorActionPreference = "Stop"

# Get script root directory so relative paths work reliably
$scriptDir = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
$projectRoot = Resolve-Path "$scriptDir\.."
Set-Location $projectRoot

# 1. Check if Obsidian is running and holding file locks
$obsidianProcesses = Get-Process -Name "Obsidian" -ErrorAction SilentlyContinue
if ($obsidianProcesses) {
    Write-Host "[!] Warning: Obsidian is currently running." -ForegroundColor Yellow
    Write-Host "    If file copying fails, please close Obsidian to release file locks.`n" -ForegroundColor Yellow
}

Write-Host "Building Obsidian CRDT Sync plugin..." -ForegroundColor Cyan
npm run build

# Target Obsidian vault plugin paths
$vaultTargets = @(
    "C:\Users\User\Projects\glowbyte\Obsidian\GBC Workplace\.obsidian\plugins\obsidian-ilow-crdp",
    "C:\Users\User\Obsidian\.obsidian\plugins\obsidian-ilow-crdt"
)

# Helper function to safely copy files with lock handling
function Copy-PluginFile {
    param (
        [string]$SourcePath,
        [string]$TargetFolder
    )

    if (Test-Path $SourcePath) {
        $fileName = Split-Path $SourcePath -Leaf
        $targetFilePath = Join-Path $TargetFolder $fileName

        try {
            # Remove read-only flag if it exists
            if (Test-Path $targetFilePath) {
                Set-ItemProperty -Path $targetFilePath -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
            }

            Copy-Item -Path $SourcePath -Destination $targetFilePath -Force
            Write-Host "  [+] Copied $fileName" -ForegroundColor Green
        }
        catch {
            Write-Host "  [-] Failed to copy $fileName to $TargetFolder" -ForegroundColor Red
            Write-Host "      Reason: File is locked by Obsidian or OneDrive. Close Obsidian and try again." -ForegroundColor Red
        }
    }
}

# Deploy to each target
foreach ($targetDir in $vaultTargets) {
    Write-Host "`nDeploying to: $targetDir" -ForegroundColor Yellow

    # Ensure target directory exists
    if (-not (Test-Path $targetDir)) {
        New-Item -Path $targetDir -ItemType Directory -Force | Out-Null
    }

    Copy-PluginFile -SourcePath "dist\main.js" -TargetFolder $targetDir
    Copy-PluginFile -SourcePath "dist\manifest.json" -TargetFolder $targetDir
    if (Test-Path "dist\styles.css") {
        Copy-PluginFile -SourcePath "dist\styles.css" -TargetFolder $targetDir
    }
}

Write-Host "`nDeployment completed!" -ForegroundColor Cyan