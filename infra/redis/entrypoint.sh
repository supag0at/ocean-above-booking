#!/bin/sh
# Build an aclfile on tmpfs and start Redis. Passwords are never written or logged; only their sha256.
# gateway commands are copied from services/gateway/src/redis-acl.ts gatewayAclRule (do not edit that file).
# harness line is the one scripts/integration/run.ts already runs (A-01 §7.2 categories plus +info).
set -eu

umask 077
acl_dir="${REDIS_ACL_DIR:-/tmp/acl}"
acl_file="$acl_dir/users.acl"
mkdir -p "$acl_dir"

hash_file() {
  # Single-line secret. Drop CR/LF so the digest matches FileSecretProvider's trailing-newline strip.
  data="$(tr -d '\r\n' < "$1")"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$data" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$data" | openssl dgst -sha256 | awk '{print $NF}'
  fi
  unset data
}

gw_file=/run/secrets/redis_gateway_password
hn_file=/run/secrets/redis_harness_password
[ -r "$gw_file" ] && [ -r "$hn_file" ] || { echo "redis: missing password file" >&2; exit 1; }

gw="$(hash_file "$gw_file")"
hn="$(hash_file "$hn_file")"
[ -n "$gw" ] && [ -n "$hn" ] || { echo "redis: empty password" >&2; exit 1; }

cat > "$acl_file" <<EOF
user default off
user gateway on #${gw} resetkeys ~auth:* ~bull:harness-wake:* ~lease:fence:* ~sweeper:lock resetchannels &sse:* -@all +ping +info +client|setname +hset +hgetall +expire +del +multi +exec +eval +evalsha +get +set +exists +hget +hmget +hmset +incr +lpush +xadd +zadd +publish +psubscribe +punsubscribe
user harness on #${hn} ~bull:harness-wake:* ~lease:* &sse:* +@read +@write +@pubsub +@scripting +@transaction +@connection +@blocking -@dangerous +info
EOF
chmod 600 "$acl_file"
unset gw hn

# The container only sits on the internal app network. protected-mode would refuse that
# interface when the default user has no password; ACL still rejects unauthenticated clients.
exec redis-server \
  --aclfile "$acl_file" \
  --appendonly yes \
  --appendfsync everysec \
  --dir /data \
  --bind 0.0.0.0 \
  --protected-mode no
