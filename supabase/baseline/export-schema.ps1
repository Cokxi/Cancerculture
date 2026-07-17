param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("DEV", "LIVE")]
  [string]$Environment,

  [Parameter(Mandatory = $true)]
  [string]$ConnectionVariable,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedProjectRef,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

function Read-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $line = Get-Content -LiteralPath $Path |
    Where-Object { $_ -match ("^\s*" + [regex]::Escape($Name) + "\s*=") } |
    Select-Object -First 1

  if (-not $line) {
    return ""
  }

  $value = ($line -replace (
    "^\s*" + [regex]::Escape($Name) + "\s*=\s*"
  ), "").Trim()

  if (
    $value.Length -ge 2 -and
    (
      ($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or
      ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'")
    )
  ) {
    return $value.Substring(1, $value.Length - 2)
  }

  return $value
}

function Get-ProjectRef {
  param(
    [Parameter(Mandatory = $true)]
    [uri]$DatabaseUri
  )

  $directMatch = [regex]::Match(
    $DatabaseUri.Host,
    "^db\.([^.]+)\."
  )
  if ($directMatch.Success) {
    return $directMatch.Groups[1].Value
  }

  $username = ($DatabaseUri.UserInfo -split ":", 2)[0]
  $poolerMatch = [regex]::Match(
    $username,
    "^postgres\.([a-z0-9]{20})$",
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if ($poolerMatch.Success) {
    return $poolerMatch.Groups[1].Value
  }

  return ""
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$connectionValue = [Environment]::GetEnvironmentVariable(
  $ConnectionVariable,
  "Process"
)

if (-not $connectionValue) {
  $connectionValue = Read-DotEnvValue `
    -Path (Join-Path $repoRoot ".env.codex.local") `
    -Name $ConnectionVariable
}

if (-not $connectionValue) {
  throw "Required database connection variable is unavailable."
}

$databaseUri = [uri]$connectionValue
$projectRef = Get-ProjectRef -DatabaseUri $databaseUri

if (
  $databaseUri.Scheme -notin @("postgres", "postgresql") -or
  -not $projectRef -or
  $projectRef -ne $ExpectedProjectRef
) {
  throw "Database target does not match the explicitly approved project."
}

$pgDumpName = [Environment]::GetEnvironmentVariable(
  "PG_DUMP_BIN",
  "Process"
)
if (-not $pgDumpName) {
  $pgDumpName = "pg_dump.exe"
}

$pgDumpCommand = Get-Command $pgDumpName -ErrorAction SilentlyContinue
if (-not $pgDumpCommand) {
  throw "PostgreSQL pg_dump was not found on PATH or in PG_DUMP_BIN."
}
$pgDump = $pgDumpCommand.Source

$resolvedOutput = [System.IO.Path]::GetFullPath(
  (Join-Path $repoRoot $OutputPath)
)
$baselineRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)

if (-not $resolvedOutput.StartsWith(
  $baselineRoot,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw "Output path must remain inside supabase/baseline."
}

$temporaryOutput = Join-Path (
  [System.IO.Path]::GetTempPath()
) ("cancerculture-schema-" + [guid]::NewGuid().ToString("N") + ".sql")

$previousOptions = [Environment]::GetEnvironmentVariable(
  "PGOPTIONS",
  "Process"
)
$previousConnectTimeout = [Environment]::GetEnvironmentVariable(
  "PGCONNECT_TIMEOUT",
  "Process"
)

try {
  [Environment]::SetEnvironmentVariable(
    "PGOPTIONS",
    "-c default_transaction_read_only=on",
    "Process"
  )
  [Environment]::SetEnvironmentVariable(
    "PGCONNECT_TIMEOUT",
    "10",
    "Process"
  )

  & $pgDump `
    --dbname=$connectionValue `
    --schema-only `
    --schema=public `
    --no-owner `
    --no-tablespaces `
    --lock-wait-timeout=10s `
    --encoding=UTF8 `
    --file=$temporaryOutput

  if ($LASTEXITCODE -ne 0) {
    throw "Schema-only pg_dump failed."
  }

  $normalizedLines = Get-Content -LiteralPath $temporaryOutput |
    Where-Object {
      $_ -notmatch "^\\(un)?restrict " -and
      $_ -notmatch "^-- Dumped from database version " -and
      $_ -notmatch "^-- Dumped by pg_dump version "
    }

  $normalizedText = ($normalizedLines -join "`n").TrimEnd() + "`n"

  if ($normalizedText -match "(?im)^-- Data for Name: ") {
    throw "Schema export unexpectedly contains table data statements."
  }

  [System.IO.Directory]::CreateDirectory(
    [System.IO.Path]::GetDirectoryName($resolvedOutput)
  ) | Out-Null
  [System.IO.File]::WriteAllText(
    $resolvedOutput,
    $normalizedText,
    [System.Text.UTF8Encoding]::new($false)
  )
}
finally {
  [Environment]::SetEnvironmentVariable(
    "PGOPTIONS",
    $previousOptions,
    "Process"
  )
  [Environment]::SetEnvironmentVariable(
    "PGCONNECT_TIMEOUT",
    $previousConnectTimeout,
    "Process"
  )

  if (Test-Path -LiteralPath $temporaryOutput) {
    Remove-Item -LiteralPath $temporaryOutput -Force
  }
}

Write-Output "Schema-only export completed for the approved $Environment target."
