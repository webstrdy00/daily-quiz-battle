$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$StatusPath = Join-Path $Root '.secrets/backup-status.json'
$BackupRoot = Join-Path $Root '.secrets/backups'
$ExitCode = 1
try {
    $Result = & node (Join-Path $PSScriptRoot 'backup-production.mjs') backup `
        --url-file (Join-Path $Root 'secrets/supabase-backup-url.txt') `
        --key-file (Join-Path $Root 'secrets/backup-encryption.key') `
        --output-dir $BackupRoot `
        --ca-file (Join-Path $Root 'apps/api/ssl/supabase-prod-ca-2021.crt')
    if ($LASTEXITCODE -ne 0) { throw 'Backup failed' }
    $Manifest = ($Result -join "`n") | ConvertFrom-Json
    if ($Manifest.format -ne 'DQB-AES256GCM-v1') { throw 'Unexpected backup receipt' }
    # Remove only recognized archives created by this application, after success.
    $Cutoff = [DateTimeOffset]::UtcNow.AddDays(-30)
    foreach ($Directory in Get-ChildItem -LiteralPath $BackupRoot -Directory) {
        if ($Directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($Directory.Name -notmatch '^daily-quiz-backup-[0-9TZ-]+-[0-9a-f]{32}$') { continue }
        $MetadataPath = Join-Path $Directory.FullName 'manifest.json'
        if (-not (Test-Path -LiteralPath $MetadataPath)) { continue }
        $Old = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
        if ($Old.format -ne 'DQB-AES256GCM-v1' -or $Old.archive -ne 'archive.dqb') { continue }
        if ([DateTimeOffset]::Parse($Old.createdAt) -lt $Cutoff) {
            Remove-Item -LiteralPath $Directory.FullName -Recurse -Force
        }
    }
    @{ success = $true; checkedAt = [DateTimeOffset]::UtcNow.ToString('o'); backup = $Manifest.backup; retentionDays = 30 } |
        ConvertTo-Json | Set-Content -LiteralPath $StatusPath -Encoding UTF8
    $ExitCode = 0
} catch {
    New-Item -ItemType Directory -Path (Split-Path $StatusPath -Parent) -Force | Out-Null
    @{ success = $false; checkedAt = [DateTimeOffset]::UtcNow.ToString('o'); error = 'backup_failed'; errorType = $_.Exception.GetType().Name; scriptLine = $_.InvocationInfo.ScriptLineNumber } |
        ConvertTo-Json | Set-Content -LiteralPath $StatusPath -Encoding UTF8
    Write-Error 'Scheduled backup failed. Inspect local task status; secret diagnostics are not emitted.' -ErrorAction Continue
}
exit $ExitCode
