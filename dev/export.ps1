# Output filename
$outputFile = "project_context.txt"
$rootPath = (Get-Location).Path

# Clear existing output file
if (Test-Path $outputFile) {
    Remove-Item $outputFile
}

# Define exclusion and inclusion lists without regex
$allowedExtensions = @('.ts', '.tsx', '.js', '.jsx', '.json', '.go')
$ignoredFolders    = @('node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage', '.obsidian-cache')
$ignoredFiles      = @('package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb')

# Find files recursively using exact array and string methods
$files = Get-ChildItem -Path $rootPath -File -Recurse -Force | Where-Object {
    # 1. Extension check
    if ($allowedExtensions -notcontains $_.Extension) { return $false }

    # 2. Lockfile check
    if ($ignoredFiles -contains $_.Name) { return $false }

    # 3. Minified file check
    if ($_.Name.Contains('.min.')) { return $false }

    # 4. Directory segment check (splits the entire path into distinct folder names)
    $pathSegments = $_.FullName.Split([char[]]@('\', '/'))
    foreach ($segment in $pathSegments) {
        if ($ignoredFolders -contains $segment) { return $false }
    }

    return $true
}

Write-Host "Found $($files.Count) project files. Merging..." -ForegroundColor Cyan

foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($rootPath.Length).TrimStart('\', '/')
    $header = "`n--- FILE: $relativePath ---`n"

    $header | Out-File -FilePath $outputFile -Append -Encoding UTF8
    Get-Content -Path $file.FullName -Raw | Out-File -FilePath $outputFile -Append -Encoding UTF8
}

Write-Host "Done! Context saved to: $outputFile" -ForegroundColor Green