param (
    [string]$InputPath = "dev/input.txt"
)

if (-not (Test-Path $InputPath)) {
    Write-Error "Input file does not exist: $InputPath"
    exit 1
}

$raw = Get-Content -Path $InputPath -Raw -Encoding UTF8
$lines = $raw -split "\r?\n"

$currentFile = $null
$currentContent = [System.Collections.Generic.List[string]]::new()
$processedCount = 0

function Save-CurrentFile {
    if ($currentFile -and $currentContent) {
        $normalizedPath = $currentFile -replace '[/\\]', [System.IO.Path]::DirectorySeparatorChar
        $fullPath = [System.IO.Path]::GetFullPath($normalizedPath)
        $parentDir = [System.IO.Path]::GetDirectoryName($fullPath)

        if (-not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }

        [System.IO.File]::WriteAllLines($fullPath, $currentContent, [System.Text.Encoding]::UTF8)
        Write-Host "Wrote: $currentFile"
        $script:processedCount++
    }
}

foreach ($line in $lines) {
    if ($line -match '^---\s*(?:START OF FILE|FILE:?)\s+(.*?)\s*---$') {
        Save-CurrentFile
        $currentFile = $matches[1].Trim()
        $currentContent.Clear()
    }
    elseif ($line -match '^---\s*$') {
        Save-CurrentFile
        $currentFile = $null
        $currentContent.Clear()
    }
    elseif ($null -ne $currentFile) {
        $currentContent.Add($line)
    }
}

Save-CurrentFile

Write-Host "Import finished successfully. Processed $processedCount file(s)."