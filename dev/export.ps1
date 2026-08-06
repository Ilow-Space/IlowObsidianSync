# Output filename
$outputFile = "project_context.txt"

# Get current directory
$rootPath = Get-Location

# Clear existing output file
if (Test-Path $outputFile) {
    Remove-Item $outputFile
}

# Regex pattern for directories, lockfiles, and build outputs to ignore
$excludePattern = "node_modules|dist|build|\.git|\.next|out|coverage|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb"

# Find TypeScript, JavaScript, and JSON files recursively
$files = Get-ChildItem -Path $rootPath -Recurse -Include *.ts, *.tsx, *.js, *.jsx, *.json | 
         Where-Object { 
             $_.FullName -notmatch $excludePattern -and
             $_.Name -notmatch "\.min\."
         }

Write-Host "Found $($files.Count) TypeScript/project files. Merging..." -ForegroundColor Cyan

foreach ($file in $files) {
    # Get clean relative path
    $relativePath = $file.FullName.Substring($rootPath.Path.Length).TrimStart('\', '/')
    
    # Ultra-compact header to save token overhead (replaces 50-character ASCII border)
    $header = "`n--- FILE: $relativePath ---`n"

    # Append header and content
    $header | Out-File -FilePath $outputFile -Append -Encoding UTF8
    Get-Content -Path $file.FullName -Raw | Out-File -FilePath $outputFile -Append -Encoding UTF8
}

Write-Host "Done! Token-optimized context saved to: $outputFile" -ForegroundColor Green