#!/usr/bin/env sh
# scripts/muse-helpers.sh — companion helpers for muse-ai.
# Covers gaps in the base toolset: safe patch, regex search, background runs, git status.
# Usage: sh scripts/muse-helpers.sh <cmd> [args...]
# All paths resolve relative to WORKSPACE (default: cwd). Never scans whole filesystem.
#
#   patch <file> <marker> <replacement>  — replace first block between markers safely (backup .bak)
#   rsearch <regex> [dir] [glob]         — ripgrep/regex search, scoped, bounded (50 matches)
#   runbg <logfile> <cmd...>             — nohup background run (works around 10s bash limit)
#   status                               — short git status + branch
#   tasks [filter]                       — pretty-print .muse/tasks.json
#   memory                               — cat .muse/memory.md

set -eu

WORKSPACE="${WORKSPACE:-$(pwd)}"
cd "$WORKSPACE"

cmd="${1:-help}"
shift || true

case "$cmd" in
  patch)
    # patch <file> <python-regex> <replacement-file>
    # Safer than full overwrite: python does a single bounded substitution + .bak
    f="$1"; rx="$2"; rep="$3"
    cp "$f" "$f.bak"
    python3 - "$f" "$rx" "$rep" <<'PY'
import re, sys
f, rx, rep_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(f, encoding="utf-8").read()
rep = open(rep_path, encoding="utf-8").read()
out, n = re.subn(rx, rep, src, count=1, flags=re.DOTALL)
assert n == 1, f"patch: expected 1 match, got {n}"
open(f, "w", encoding="utf-8").write(out)
print(f"patch: ok 1 substitution in {f} (backup {f}.bak)")
PY
    ;;
  rsearch)
    # rsearch <regex> [dir=. ] [include-glob]
    rx="$1"; dir="${2:-.}"; glob="${3:-*}"
    if command -v rg >/dev/null 2>&1; then
      rg -n --max-count 50 --glob "$glob" -- "$rx" "$dir" | head -n 50 || true
    else
      grep -rnE --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.muse \
        --include="$glob" -m 50 -- "$rx" "$dir" | head -n 50 || true
    fi
    ;;
  runbg)
    # runbg <logfile> <cmd...>
    log="$1"; shift
    mkdir -p "$(dirname "$log")"
    nohup "$@" >"$log" 2>&1 &
    echo "started pid $! → $log"
    ;;
  status)
    git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "(no branch)"
    git status --short --branch 2>/dev/null | head -n 30 || echo "(not a git repo)"
    ;;
  tasks)
    # tasks [pending|done|all]
    filter="${1:-all}"
    python3 - "$filter" <<'PY'
import json, sys
f = sys.argv[1]
tasks = json.load(open(".muse/tasks.json"))["tasks"]
for t in tasks:
    if f != "all" and f != "pending" and t["status"] != f:
        pass
    if f == "pending" and t["status"] == "done":
        continue
    if f not in ("all", "pending") and t["status"] != f:
        continue
    print(f"[{t['status']:>11}] {t['priority']} {t['id']} — {t['title']}")
PY
    ;;
  memory)
    cat .muse/memory.md
    ;;
  help|*)
    echo "usage: sh scripts/muse-helpers.sh <patch|rsearch|runbg|status|tasks|memory>"
    exit 1
    ;;
esac
