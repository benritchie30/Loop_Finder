#!/usr/bin/env bash
# Put the newest version from GitHub live (see DEPLOY.md). Run as root on the server:
#
#   bash /opt/loop-finder/deploy/update.sh
#
# Pulls, installs changed packages, rebuilds the UI, restarts the backend. Visitors
# connected at that moment see "Server Disconnected" for a few seconds and then
# reconnect by themselves; their routes are in their browsers.
# (A change to deploy/Caddyfile or deploy/loop-finder.service: run setup.sh again.)
set -euo pipefail

APP="${LOOP_SETUP_APP:-/opt/loop-finder}"   # override only for testing (deploy/test_setup.sh)

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'fail "update stopped at line $LINENO (the step above). Before the UI swap, the site keeps running the previous version."' ERR

[ "$(id -u)" -eq 0 ] || fail "run as root (or with sudo)"
cd "$APP"

step "Pull from GitHub"
before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
    echo "already up to date ($after); rebuilding anyway"
else
    git log --oneline "$before..$after"
fi

step "Python packages"
"$APP/venv/bin/pip" install -q -r backend/requirements.txt

step "Build the UI"
# Built into dist.new and swapped in only when complete: visitors keep getting the
# previous UI during the build, and a failed build leaves it in place.
cd "$APP/route-loop-finder"
npm ci --no-audit --no-fund
rm -rf dist.new dist.old
npm run build -- --outDir dist.new --emptyOutDir
[ -f dist.new/index.html ] || fail "the UI build made no dist.new/index.html; the previous UI stays live"
chmod -R a+rX "$APP"
if [ -d dist ]; then mv dist dist.old; fi
mv dist.new dist
rm -rf dist.old

step "Restart the backend"
systemctl restart loop-finder
ok=""
for _ in $(seq 1 30); do
    if curl -fsS http://localhost:8765/healthz >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
done
[ -n "$ok" ] || fail "the backend does not answer after the restart (see: journalctl -u loop-finder -n 50)"
journalctl -u loop-finder -n 20 --no-pager | grep -E 'Limits|WARNING|Ready' || true
echo
echo "Updated to $(git -C "$APP" log -1 --format='%h %s')"
