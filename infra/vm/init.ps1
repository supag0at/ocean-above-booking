# Windows equivalent of infra/vm/init.sh (A-01 §10). Node generates the passwords and the Ed25519 pair.
# Usage: powershell -File infra/vm/init.ps1 -EnvFile <path-to-.env> [-SecretsDir <dir>]
# Prints the destination only. Never prints secret values.
param(
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$SecretsDir
)

$ErrorActionPreference = 'Stop'
if (-not $SecretsDir) {
  $repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
  $SecretsDir = Join-Path $repo 'infra\secrets'
}
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Error 'init.ps1: env file not found'
  exit 1
}

$line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^\s*DEEPSEEK_API_KEY\s*=' } | Select-Object -First 1
if (-not $line) {
  Write-Error 'init.ps1: DEEPSEEK_API_KEY missing'
  exit 1
}
$eq = $line.IndexOf('=')
$key = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
if (-not $key) {
  Write-Error 'init.ps1: DEEPSEEK_API_KEY empty'
  exit 1
}

New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('fb-dk-' + [guid]::NewGuid().ToString('n'))
[System.IO.File]::WriteAllText($tmp, $key, $utf8)
Remove-Variable key
Remove-Variable line

$script = Join-Path ([System.IO.Path]::GetTempPath()) ('fb-init-' + [guid]::NewGuid().ToString('n') + '.cjs')
$gen = @'
const fs = require("node:fs");
const path = require("node:path");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const dest = process.argv[2];
const keyFile = process.argv[3];
if (!dest || !keyFile) process.exit(2);
const names = [
  "pg_superuser_password", "pg_owner_password", "pg_gateway_password", "pg_hands_password", "pg_booking_password",
  "redis_gateway_password", "redis_harness_password", "harness_service_token", "booking_service_token", "cookie_secret"
];
for (const name of names) {
  fs.writeFileSync(path.join(dest, name), randomBytes(32).toString("hex") + "\n");
}
const raw = fs.readFileSync(keyFile, "utf8").replace(/[\r\n]+$/, "");
if (!raw) process.exit(3);
fs.writeFileSync(path.join(dest, "deepseek_api_key"), raw + "\n");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
fs.writeFileSync(path.join(dest, "hands_token_signing_key"), privateKey.export({ type: "pkcs8", format: "pem" }));
fs.writeFileSync(path.join(dest, "hands_token_public_key.pem"), publicKey.export({ type: "spki", format: "pem" }));
'@
[System.IO.File]::WriteAllText($script, $gen, $utf8)

try {
  & node $script $SecretsDir $tmp
  if ($LASTEXITCODE -ne 0) {
    Write-Error "init.ps1: key generation failed ($LASTEXITCODE)"
    exit 1
  }
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  if (Test-Path -LiteralPath $script) { Remove-Item -LiteralPath $script -Force }
}

$me = "$env:USERDOMAIN\$env:USERNAME"
icacls $SecretsDir /inheritance:r /grant:r "${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
Get-ChildItem -LiteralPath $SecretsDir -File | ForEach-Object {
  icacls $_.FullName /inheritance:r /grant:r "${me}:R" '*S-1-5-32-545:R' '*S-1-5-18:R' '*S-1-5-32-544:R' | Out-Null
}

Write-Output "init.ps1: wrote secret files under $SecretsDir (values not shown)"
