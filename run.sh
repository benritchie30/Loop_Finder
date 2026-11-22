#!/usr/bin/env bash
# Set up the environment, install dependencies and run the checks.
#
#   bash run.sh                 set up (once), then: frontend tests, lint, build, backend tests
#   bash run.sh --e2e           also the browser check (backend/tools/check_frontend.py, ~4 min;
#                               downloads Playwright's Chromium the first time)
#   bash run.sh --all           also the public-server checks (check_limits.py, check_load.py, ~4 min)
#   bash run.sh --skip-install  do not install anything (venv/ and node_modules/ already there)
#   bash run.sh --e2e-only ARGS only the browser check; ARGS go to check_frontend.py
#                               (e.g. --only sets,all_favorites --area rural)
#
# Everything goes into the project folder: venv/ (Python) and route-loop-finder/node_modules/.
# Nothing is installed system-wide. Exit code 0 only when every check passed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

E2E=0
ALL=0
INSTALL=1
E2E_ONLY=0
E2E_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --e2e) E2E=1 ;;
        --all) E2E=1; ALL=1 ;;
        --skip-install) INSTALL=0 ;;
        --e2e-only) E2E=1; E2E_ONLY=1; shift; E2E_ARGS=("$@"); break ;;
        -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1 (see: bash run.sh --help)"; exit 2 ;;
    esac
    shift
done

if [ -t 1 ]; then
    BOLD=$'\e[1m'; GREEN=$'\e[32m'; RED=$'\e[31m'; DIM=$'\e[2m'; RESET=$'\e[0m'
else
    BOLD=''; GREEN=''; RED=''; DIM=''; RESET=''
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
die() { printf '%sError:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# ------------------------------------------------------------------ requirements
step "Checking Python and Node.js"
PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1; then PYTHON="$candidate"; break; fi
    done
fi
[ -n "$PYTHON" ] || die "Python 3.9+ is needed (Debian/Ubuntu: sudo apt install python3 python3-venv)."
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
    || die "Python 3.9+ is needed; $PYTHON is $("$PYTHON" --version 2>&1)."
command -v node >/dev/null 2>&1 || die "Node.js 18+ is needed (https://nodejs.org, or your package manager)."
command -v npm >/dev/null 2>&1 || die "npm is needed (it comes with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ is needed; this is $(node --version)."
echo "$("$PYTHON" --version 2>&1), Node.js $(node --version), npm $(npm --version)"

VENV="$ROOT/venv"
VPY="$VENV/bin/python"

# ------------------------------------------------------------------ install
if [ "$INSTALL" = 1 ]; then
    step "Python virtual environment (venv/)"
    if [ ! -x "$VPY" ]; then
        "$PYTHON" -m venv "$VENV" \
            || die "Could not make the virtual environment (Debian/Ubuntu: sudo apt install python3-venv)."
    fi
    "$VPY" -m pip install --quiet --upgrade pip || die "pip upgrade failed."
    "$VPY" -m pip install --quiet -r backend/requirements.txt || die "pip install -r backend/requirements.txt failed."
    if [ "$E2E" = 1 ]; then
        "$VPY" -m pip install --quiet -r backend/requirements-dev.txt || die "pip install -r backend/requirements-dev.txt failed."
    fi
    echo "Python packages installed."

    step "Node packages (route-loop-finder/node_modules)"
    (
        cd route-loop-finder
        if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error
        else npm install --no-audit --no-fund --loglevel=error; fi
    ) || die "npm install failed."

    if [ "$E2E" = 1 ]; then
        step "A browser for the browser check"
        # (no pipe into grep -q: with pipefail, grep stopping early fails the pipe)
        BROWSERS="$("$VPY" backend/tools/check_frontend.py --list-browsers 2>/dev/null || true)"
        if [[ "$BROWSERS" == *" starts ("* ]]; then
            echo "A browser is already available."
        else
            "$VPY" -m playwright install chromium || die "Could not download Chromium (python -m playwright install chromium)."
            echo "${DIM}If Chromium then fails to start with a missing library (libnss3...), run:"
            echo "  sudo $VPY -m playwright install-deps chromium${RESET}"
        fi
    fi
else
    [ -x "$VPY" ] || die "No venv/ yet: run without --skip-install once."
    [ -d route-loop-finder/node_modules ] || die "No route-loop-finder/node_modules yet: run without --skip-install once."
fi

# ------------------------------------------------------------------ checks
RESULTS=()
FAILED=0
run_check() { # name, dir, command...
    local name="$1" dir="$2"
    shift 2
    step "$name"
    local start=$SECONDS
    if (cd "$dir" && "$@"); then
        RESULTS+=("${GREEN}PASS${RESET}  $name ($((SECONDS - start)) s)")
    else
        RESULTS+=("${RED}FAIL${RESET}  $name ($((SECONDS - start)) s)")
        FAILED=1
    fi
}

if [ "$E2E_ONLY" = 0 ]; then
    run_check "Frontend logic tests (vitest)" route-loop-finder npx vitest run
    run_check "Frontend lint (eslint)" route-loop-finder npx eslint src
    run_check "Frontend build (vite)" route-loop-finder npx vite build --logLevel warn
    run_check "Backend tests (unittest)" backend "$VPY" -m unittest discover -s tests
fi
if [ "$E2E" = 1 ]; then
    run_check "Browser check (check_frontend.py)" backend "$VPY" tools/check_frontend.py "${E2E_ARGS[@]}"
fi
if [ "$ALL" = 1 ]; then
    run_check "Public server limits (check_limits.py)" backend "$VPY" tools/check_limits.py
    run_check "Several visitors (check_load.py)" backend "$VPY" tools/check_load.py
fi

step "Summary"
for row in "${RESULTS[@]}"; do printf '  %s\n' "$row"; done
if [ "$FAILED" = 0 ]; then
    printf '\n%sAll checks passed.%s\n' "$GREEN" "$RESET"
else
    printf '\n%sSome checks failed%s (browser check screenshots and logs: backend/check_frontend_out/).\n' "$RED" "$RESET"
fi
exit "$FAILED"
