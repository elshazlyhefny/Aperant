#!/usr/bin/env bash
#
# Build the zeenha branch and install it as the running Aperant.
#
#   scripts/zeenha-release.sh                       test, build, push, install zeenha.N+1
#   scripts/zeenha-release.sh --no-install          same, but stop before replacing the app
#   scripts/zeenha-release.sh --install <AppImage>  install a build that already exists
#   scripts/zeenha-release.sh --rollback            swap back to the previous install
#
# APERANT_INSTALL_DIR overrides ~/Applications/aperant-zeenha. The AppArmor
# profile is tied to that default path, so a real install must keep it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
PACKAGE_JSON="$DESKTOP_DIR/package.json"
BRANCH=zeenha
INSTALL_DIR="${APERANT_INSTALL_DIR:-$HOME/Applications/aperant-zeenha}"
PREVIOUS_DIR="$INSTALL_DIR.previous"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

current_version() { node -p "require('$PACKAGE_JSON').version"; }

installed_version() {
  sed -n 's/^X-AppImage-Version=//p' "$1/aperant.desktop" 2>/dev/null || true
}

# Replacing the folder under a running app breaks its lazily loaded files.
assert_app_stopped() {
  local exe
  for exe in /proc/[0-9]*/exe; do
    if [[ "$(readlink "$exe" 2>/dev/null || true)" == "$INSTALL_DIR/"* ]]; then
      die "Aperant is running from $INSTALL_DIR. Close it and run this again."
    fi
  done
}

assert_clean_trunk() {
  cd "$REPO_ROOT"
  [[ "$(git branch --show-current)" == "$BRANCH" ]] || die "not on the $BRANCH branch"
  [[ -z "$(git status --porcelain)" ]] || die "the working tree has uncommitted changes"
  git fetch --quiet origin "$BRANCH"
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse "origin/$BRANCH")" ]] \
    || die "local $BRANCH differs from origin/$BRANCH; pull or push first"
}

# Task worktrees link to these folders, so an agent's stray `npm install` can
# change them without touching the lockfile. Only a clean install is trustworthy.
install_dependencies() {
  log "Installing dependencies from package-lock.json"
  (cd "$REPO_ROOT" && npm ci --no-audit --no-fund)
}

next_version() {
  local version="$1"
  [[ "$version" =~ ^(.*\.zeenha\.)([0-9]+)$ ]] || die "version '$version' has no zeenha.N suffix"
  printf '%s%d' "${BASH_REMATCH[1]}" "$((BASH_REMATCH[2] + 1))"
}

set_version() {
  VERSION_FROM="$1" VERSION_TO="$2" PACKAGE_JSON="$PACKAGE_JSON" node -e '
    const fs = require("fs");
    const { VERSION_FROM: from, VERSION_TO: to, PACKAGE_JSON: file } = process.env;
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(`"version": "${from}"`, `"version": "${to}"`);
    if (after === before) throw new Error("version line not found");
    fs.writeFileSync(file, after);
  '
}

install_appimage() {
  local appimage expected extracted
  appimage="$(realpath "$1")"
  expected="$2"
  [[ -x "$appimage" ]] || die "not an executable AppImage: $appimage"
  assert_app_stopped

  log "Extracting $(basename "$appimage")"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  # On the install filesystem, so the final moves are atomic renames.
  stage="$(mktemp -d "$INSTALL_DIR.stage.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  (cd "$stage" && "$appimage" --appimage-extract >/dev/null)
  extracted="$stage/squashfs-root"

  [[ -x "$extracted/aperant" ]] || die "the AppImage has no aperant binary"
  if [[ -n "$expected" && "$(installed_version "$extracted")" != "$expected" ]]; then
    die "the AppImage is $(installed_version "$extracted"), expected $expected"
  fi

  log "Installing to $INSTALL_DIR"
  if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$PREVIOUS_DIR"
    mv "$INSTALL_DIR" "$PREVIOUS_DIR"
  fi
  if ! mv "$extracted" "$INSTALL_DIR"; then
    [[ -d "$PREVIOUS_DIR" ]] && mv "$PREVIOUS_DIR" "$INSTALL_DIR"
    die "could not move the new build into place; the old install was restored"
  fi

  rm -rf "$stage"
  trap - EXIT
  log "Installed $(installed_version "$INSTALL_DIR")"
}

rollback() {
  [[ -d "$PREVIOUS_DIR" ]] || die "there is no previous install at $PREVIOUS_DIR"
  assert_app_stopped
  local swap="$INSTALL_DIR.swap.$$"
  mv "$INSTALL_DIR" "$swap"
  mv "$PREVIOUS_DIR" "$INSTALL_DIR"
  mv "$swap" "$PREVIOUS_DIR"
  log "Now running $(installed_version "$INSTALL_DIR"); $(installed_version "$PREVIOUS_DIR") is kept as previous"
}

release() {
  local install="$1" from to build_log appimage
  assert_clean_trunk
  [[ "$install" == no ]] || assert_app_stopped
  install_dependencies

  from="$(current_version)"
  to="$(next_version "$from")"
  build_log="$HOME/aperant-build-z${to##*.}.log"

  # Restores the version line if anything below fails before the commit.
  trap 'git -C "$REPO_ROOT" checkout -- apps/desktop/package.json' EXIT
  set_version "$from" "$to"

  log "Checking $to (log: $build_log)"
  cd "$DESKTOP_DIR"
  {
    npm run -s typecheck
    npm run -s test:unit
  } 2>&1 | tee "$build_log" | tail -n 5

  log "Building $to"
  {
    npm run -s build
    npx electron-builder --linux AppImage --publish never
  } 2>&1 | tee -a "$build_log" | tail -n 3

  appimage="$DESKTOP_DIR/dist/Aperant-$to-linux-x86_64.AppImage"
  [[ -f "$appimage" ]] || die "the build did not produce $appimage"

  log "Committing and pushing $to"
  git -C "$REPO_ROOT" commit --quiet -m "chore: zeenha.${to##*.}" -- apps/desktop/package.json
  trap - EXIT
  git -C "$REPO_ROOT" push --quiet origin "$BRANCH"

  if [[ "$install" == no ]]; then
    log "Built $appimage (not installed)"
    return
  fi
  install_appimage "$appimage" "$to"
}

case "${1:-}" in
  "") release yes ;;
  --no-install) release no ;;
  --install)
    [[ -n "${2:-}" ]] || die "--install needs an AppImage path"
    install_appimage "$2" ""
    ;;
  --rollback) rollback ;;
  *) die "unknown option: $1 (see the top of this script)" ;;
esac
