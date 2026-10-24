#!/usr/bin/env bash
# install.sh — installs searchd's five skills (searchd-setup, searchd-find, searchd-track,
# searchd-audit, searchd-dashboard).
#
# searchd's skills share code, so all five folders are always installed side by side.
# This script only copies files: it doesn't download anything, and it never touches the
# keyword data searchd saves in your projects (their .searchd/ folders).
#
# Usage:
#   ./install.sh                 Claude Code, for your user  (~/.claude/skills)
#   ./install.sh --codex         Codex, for your user         (~/.agents/skills)
#   ./install.sh --claude --codex   both
#   ./install.sh --project       Claude Code, this project only (./.claude/skills)
#   ./install.sh --dir <path>    any skills folder
#   ./install.sh --link          symlink instead of copy (for searchd development:
#                                edits in this repo show up immediately)
#   ./install.sh --uninstall     remove the five skill folders from the chosen place(s)
#
# Written for the bash that ships with macOS (3.2), so no newer bash features.

set -euo pipefail

SKILLS="searchd-setup searchd-find searchd-track searchd-audit searchd-dashboard"
# The folder this script is in (the repo root), even if run from somewhere else.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

targets=""
mode="copy"

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

# --- Read the options -----------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --claude)    targets="$targets $HOME/.claude/skills" ;;
    --codex)     targets="$targets $HOME/.agents/skills" ;;
    --project)   targets="$targets $(pwd)/.claude/skills" ;;
    --dir)
      [ $# -ge 2 ] || { echo "install.sh: --dir needs a path" >&2; exit 1; }
      targets="$targets $2"; shift ;;
    --link)      mode="link" ;;
    --uninstall) mode="uninstall" ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "install.sh: unknown option '$1' (try --help)" >&2; exit 1 ;;
  esac
  shift
done
# Default: Claude Code, user-level.
[ -n "$targets" ] || targets="$HOME/.claude/skills"

# --- Uninstall -----------------------------------------------------------------
if [ "$mode" = "uninstall" ]; then
  for target in $targets; do
    for name in $SKILLS; do
      # -L catches symlinks (from --link), -d catches copied folders.
      if [ -L "$target/$name" ] || [ -d "$target/$name" ]; then
        rm -rf "${target:?}/$name"
        echo "Removed $target/$name"
      fi
    done
  done
  echo "Your projects' .searchd/ data folders were left in place. Delete them yourself if you want them gone."
  exit 0
fi

# --- Checks before installing --------------------------------------------------
for name in $SKILLS; do
  if [ ! -f "$REPO/skills/$name/SKILL.md" ]; then
    echo "install.sh: $REPO/skills/$name is missing. Run this script from the searchd repo." >&2
    exit 1
  fi
done

# searchd needs Node.js 18+ (for the built-in fetch). Warn, but still install.
if command -v node >/dev/null 2>&1; then
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
    echo "Warning: searchd needs Node.js 18 or newer (you have $(node --version)). Please update Node." >&2
  fi
else
  echo "Warning: Node.js not found. searchd needs Node.js 18 or newer: https://nodejs.org" >&2
fi

# --- Install -------------------------------------------------------------------
for target in $targets; do
  mkdir -p "$target"
  for name in $SKILLS; do
    dest="$target/$name"
    # Replace an older searchd install of this folder (only these five names, ever).
    if [ -L "$dest" ] || [ -e "$dest" ]; then rm -rf "${dest:?}"; fi
    if [ "$mode" = "link" ]; then
      ln -s "$REPO/skills/$name" "$dest"
    else
      cp -R "$REPO/skills/$name" "$dest"
      # macOS Finder litter has no place in an installed skill.
      find "$dest" -name .DS_Store -delete 2>/dev/null || true
    fi
  done
  # Check all five made it, side by side (the shared code depends on it).
  for name in $SKILLS; do
    [ -f "$target/$name/SKILL.md" ] || { echo "install.sh: $target/$name didn't install correctly." >&2; exit 1; }
  done
  verb="Installed"; [ "$mode" = "link" ] && verb="Linked"
  echo "✓ $verb searchd into $target (searchd-setup, searchd-find, searchd-track, searchd-audit, searchd-dashboard)"
done

cat <<'EOF'

Next:
  1. Start a new Claude Code or Codex session (so it sees the new skills).
  2. In your app's project folder, run /searchd-setup   (Codex: $searchd-setup)
Then /searchd-find to research keywords, /searchd-audit for a better listing,
/searchd-track daily for rank history, and /searchd-dashboard to see it all.
EOF
