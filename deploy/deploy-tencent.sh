#!/usr/bin/env bash
#
# Deploy quant-engine + attestation merchant to the Tencent box behind
# ww.storyard.ai:8443.
#
# Prereq: SSH access as ubuntu@124.221.94.180. The box accepts publickey only
# (password auth is disabled), so you need the right private key.
#   SSH_KEY=~/.ssh/id_rsa_newspaper bash deploy/deploy-tencent.sh
#
# Secrets are passed through the environment and written to a 600 .env on the
# remote — they are never baked into the bundle or committed.

set -euo pipefail

HOST="${HOST:-ubuntu@124.221.94.180}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa_newspaper}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/quant-engine}"
ENGINE_PORT="${ENGINE_PORT:-8770}"
ATTEST_PORT="${ATTEST_PORT:-8771}"

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $HOST"
here="$(cd "$(dirname "$0")/.." && pwd)"

for v in ZG_API_KEY KITE_BUYER_KEY; do
  if [ -z "${!v:-}" ]; then
    echo "!! $v is not set. Export it before running (it is written to the remote .env, not committed)."
    exit 1
  fi
done

echo "==> building"
cd "$here"
npx tsc -p tsconfig.json 2>/dev/null || \
  /Users/kengorgor/BigAppleRoot/signal-duel/node_modules/.bin/tsc -p tsconfig.json

echo "==> packing"
rm -f /tmp/quant-engine.tar.gz
tar czf /tmp/quant-engine.tar.gz \
  dist public attestation package.json README.md

echo "==> uploading"
$SSH "mkdir -p $REMOTE_DIR"
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  /tmp/quant-engine.tar.gz "$HOST:$REMOTE_DIR/"

echo "==> installing"
$SSH bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"
tar xzf quant-engine.tar.gz && rm quant-engine.tar.gz

# ethers is the only runtime dep, and only the merchant/buyer need it.
if [ ! -d node_modules/ethers ]; then
  npm install ethers@6 --no-audit --no-fund --loglevel=error
fi

cat > .env <<ENVEOF
ZG_API_KEY=${ZG_API_KEY}
KITE_BUYER_KEY=${KITE_BUYER_KEY}
ZG_MODEL=${ZG_MODEL:-deepseek-v4-pro}
ATTEST_URL=http://127.0.0.1:${ATTEST_PORT}/attest
ATTEST_PORT=${ATTEST_PORT}
PORT=${ENGINE_PORT}
TOP_N=${TOP_N:-5}
CACHE_TTL_MS=${CACHE_TTL_MS:-45000}
MIN_CONVICTION=${MIN_CONVICTION:-0.15}
ENVEOF
chmod 600 .env

pkill -f 'quant-engine.*server' 2>/dev/null || true
sleep 1

set -a; . ./.env; set +a
nohup node attestation/server.mjs > attest.log 2>&1 &
sleep 2
nohup node dist/server.js > engine.log 2>&1 &
sleep 4

echo "--- attest.log ---"; tail -4 attest.log
echo "--- engine.log ---"; tail -6 engine.log
echo "--- local health ---"
curl -sS --max-time 20 "http://127.0.0.1:${ENGINE_PORT}/api/health" || echo "engine health FAILED"
echo
curl -sS --max-time 10 "http://127.0.0.1:${ATTEST_PORT}/health" || echo "merchant health FAILED"
echo
REMOTE

echo
echo "==> deployed. Reverse-proxy these behind ww.storyard.ai:8443 if not already:"
echo "    /quant-engine/      -> 127.0.0.1:${ENGINE_PORT}"
echo "    (keep ${ATTEST_PORT} internal — it holds the signing key)"
