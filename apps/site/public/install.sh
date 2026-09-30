#!/usr/bin/env bash
# OpenMimir installer: curl -fsSL https://openmimir.com/install.sh | bash
#
# Installs the `mimir` binary and its web UI into ~/.openmimir/bin and adds that
# folder to your PATH. Re-run it to update. Set MIMIR_VERSION=v0.2.0 to pin a version.
set -euo pipefail

REPO="openmimir/openmimir"
INSTALL_DIR="${MIMIR_INSTALL_DIR:-$HOME/.openmimir/bin}"

bold=$'\033[1m'; dim=$'\033[2m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
info() { printf '%s\n' "$*"; }
fail() { printf '%serror:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "OpenMimir supports macOS for now. Linux and Windows are coming."

case "$(uname -m)" in
  arm64) target="darwin-arm64" ;;
  x86_64) target="darwin-x64" ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac

if [ -n "${MIMIR_DOWNLOAD_BASE:-}" ]; then
  base="$MIMIR_DOWNLOAD_BASE"
elif [ -n "${MIMIR_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$MIMIR_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi
archive="mimir-$target.tar.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "${bold}Installing OpenMimir${reset} ${dim}($target)${reset}"
curl -fsSL "$base/$archive" -o "$tmp/$archive" || fail "could not download $base/$archive"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || fail "could not download checksums"

expected="$(grep " $archive\$" "$tmp/checksums.txt" | awk '{print $1}')"
actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $archive"

mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/web"
tar -xzf "$tmp/$archive" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/mimir"
version="$("$INSTALL_DIR/mimir" version 2>/dev/null || echo "unknown")"

# Put ~/.openmimir/bin on PATH for future shells, once.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac
if [ "$on_path" = 0 ]; then
  case "$(basename "${SHELL:-zsh}")" in
    bash) rc="$HOME/.bash_profile" ;;
    fish) rc="" ;;
    *) rc="$HOME/.zshrc" ;;
  esac
  line="export PATH=\"$INSTALL_DIR:\$PATH\""
  if [ -n "$rc" ] && ! grep -qsF "$line" "$rc"; then
    printf '\n# OpenMimir\n%s\n' "$line" >> "$rc"
    info "${dim}Added $INSTALL_DIR to PATH in $rc${reset}"
  elif [ -z "$rc" ]; then
    info "Add $INSTALL_DIR to your PATH: fish_add_path $INSTALL_DIR"
  fi
fi

info ""
info "${green}✓${reset} OpenMimir $version installed to $INSTALL_DIR"
info ""
info "Next:"
[ "$on_path" = 0 ] && info "  ${dim}# open a new terminal first, or run: export PATH=\"$INSTALL_DIR:\$PATH\"${reset}"
info "  mimir init     ${dim}# API keys and project folders${reset}"
info "  mimir          ${dim}# start, then open http://localhost:4747${reset}"
