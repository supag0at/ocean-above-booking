#!/bin/bash
# A-01 §10: passwords, tokens, Ed25519 pair, and the DeepSeek key from a caller-supplied .env.
# Usage: infra/vm/init.sh <path-to-.env> [secrets-dir]
# Prints paths only. Never prints secret values.
set -euo pipefail

env_file="${1:?usage: init.sh <path-to-.env> [secrets-dir]}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$script_dir/../.." && pwd)"
dest="${2:-$root/infra/secrets}"

[ -f "$env_file" ] || { echo "init.sh: env file not found" >&2; exit 1; }

key="$(
  awk -F= '
    $1 ~ /^[ \t]*DEEPSEEK_API_KEY[ \t]*$/ {
      sub(/^[ \t]*/, "", $2)
      sub(/[ \t\r]*$/, "", $2)
      if ($2 ~ /^".*"$/ || $2 ~ /^'\''.*'\''$/) $2 = substr($2, 2, length($2) - 2)
      print $2
      exit
    }
  ' "$env_file"
)"
[ -n "$key" ] || { echo "init.sh: DEEPSEEK_API_KEY missing or empty" >&2; exit 1; }

mkdir -p "$dest"
chmod 0700 "$dest"
if [ "$(id -u)" -eq 0 ]; then
  chown root:root "$dest"
fi

write_secret() {
  printf '%s\n' "$2" > "$dest/$1"
  chmod 0444 "$dest/$1"
  if [ "$(id -u)" -eq 0 ]; then
    chown root:root "$dest/$1"
  fi
}

rand() { openssl rand -hex 32; }

for name in \
  pg_superuser_password pg_owner_password pg_gateway_password pg_hands_password pg_booking_password \
  redis_gateway_password redis_harness_password harness_service_token booking_service_token cookie_secret
do
  write_secret "$name" "$(rand)"
done

write_secret deepseek_api_key "$key"
unset key

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
openssl genpkey -algorithm ed25519 -out "$tmp/priv.pem"
openssl pkey -in "$tmp/priv.pem" -pubout -out "$tmp/pub.pem"
cp "$tmp/priv.pem" "$dest/hands_token_signing_key"
cp "$tmp/pub.pem" "$dest/hands_token_public_key.pem"
chmod 0444 "$dest/hands_token_signing_key" "$dest/hands_token_public_key.pem"
if [ "$(id -u)" -eq 0 ]; then
  chown root:root "$dest/hands_token_signing_key" "$dest/hands_token_public_key.pem"
fi

echo "init.sh: wrote secret files under $dest (values not shown)"
