#!/bin/bash
# Build the macOS installer (T17, D-201…D-204): installer/macos/dist/WebAgents-<version>.pkg,
# a product archive with two component packages and a choice for the second:
#   org.webagents.helper        required: the helper, its id list, the uninstaller, the welcome
#                               page and Chrome's native-messaging host manifest
#   org.webagents.ollama-setup  optional, on by default: find or obtain Ollama, allow the
#                               extension in OLLAMA_ORIGINS now and at every login (LaunchAgent)
# Unsigned and un-notarized until U8 (installer/README.md says what Gatekeeper shows).
# Usage: installer/macos/build-pkg.sh [--helper path/to/webagents-helper] [--out DIR]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
. "$here/paths.sh"
helper=""
out="$here/dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --helper) helper="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$helper" ] || helper="$("$repo/native-helper/scripts/build.sh" | /usr/bin/tail -n 1)"
[ -x "$helper" ] || { echo "no helper binary at $helper" >&2; exit 1; }

ids="$(wa_extension_ids "$here/extension-ids.json")"
[ -n "$ids" ] || { echo "installer/macos/extension-ids.json lists no extension id" >&2; exit 1; }
first="$(echo "$ids" | /usr/bin/head -n 1)"
work="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf "$work"' EXIT

# -- the helper component ------------------------------------------------------------------
root="$work/root-helper"
/usr/bin/install -d -m 755 "$root$WA_SUPPORT" "$root$(dirname "$WA_HOST_MANIFEST")"
/usr/bin/install -m 755 "$helper" "$root$WA_HELPER"
/usr/bin/install -m 644 "$here/extension-ids.json" "$root$WA_IDS"
/usr/bin/install -m 644 "$here/paths.sh" "$root$WA_PATHS"
/usr/bin/install -m 755 "$here/support/uninstall.sh" "$root$WA_UNINSTALL"
/usr/bin/sed "s/@EXTENSION_ID@/$first/g" "$here/support/welcome.html" >"$root$WA_WELCOME"
/bin/chmod 644 "$root$WA_WELCOME"
{
  printf '{\n  "name": "%s",\n  "description": "WebAgents native helper: keychain unlock and Ollama status",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": [' "$WA_HOST_NAME" "$WA_HELPER"
  separator=""
  for id in $ids; do printf '%s"chrome-extension://%s/"' "$separator" "$id"; separator=", "; done
  printf ']\n}\n'
} >"$root$WA_HOST_MANIFEST"
/bin/chmod 644 "$root$WA_HOST_MANIFEST"
/usr/bin/plutil -convert xml1 -o /dev/null "$root$WA_HOST_MANIFEST" # well-formed JSON
/bin/mkdir -p "$work/scripts-helper"
/usr/bin/install -m 755 "$here/scripts/helper/postinstall" "$work/scripts-helper/postinstall"
/usr/bin/install -m 644 "$here/paths.sh" "$work/scripts-helper/paths.sh"

# -- the Ollama component ------------------------------------------------------------------
root="$work/root-ollama"
/usr/bin/install -d -m 755 "$root$WA_SUPPORT" "$root$(dirname "$WA_AGENT_PLIST")"
/usr/bin/install -m 755 "$here/support/ollama-origins.sh" "$root$WA_ORIGINS_SCRIPT"
/usr/bin/install -m 644 "$here/ollama-pin.env" "$root$WA_PIN"
/usr/bin/install -m 644 "$here/support/$WA_AGENT_LABEL.plist" "$root$WA_AGENT_PLIST"
/bin/mkdir -p "$work/scripts-ollama"
/usr/bin/install -m 755 "$here/scripts/ollama/postinstall" "$work/scripts-ollama/postinstall"
/usr/bin/install -m 644 "$here/paths.sh" "$work/scripts-ollama/paths.sh"
/usr/bin/install -m 644 "$here/ollama-pin.env" "$work/scripts-ollama/ollama-pin.env"

# Nothing but the listed payload (paths.sh's WA_*_PAYLOAD) may be staged.
for component in helper ollama; do
  expected="$WA_HELPER_PAYLOAD"
  [ "$component" = "ollama" ] && expected="$WA_OLLAMA_PAYLOAD"
  staged="$(cd "$work/root-$component" && /usr/bin/find . -type f | /usr/bin/sed 's#^\.##' | LC_ALL=C /usr/bin/sort)"
  if [ "$staged" != "$(echo "$expected" | LC_ALL=C /usr/bin/sort)" ]; then
    echo "the $component payload differs from paths.sh:" >&2
    diff <(echo "$staged") <(echo "$expected" | LC_ALL=C /usr/bin/sort) >&2 || true
    exit 1
  fi
done

/usr/bin/pkgbuild --quiet --root "$work/root-helper" --scripts "$work/scripts-helper" --identifier "$WA_PKG_HELPER" --version "$WA_VERSION" --install-location / --ownership recommended "$work/helper.pkg"
/usr/bin/pkgbuild --quiet --root "$work/root-ollama" --scripts "$work/scripts-ollama" --identifier "$WA_PKG_OLLAMA" --version "$WA_VERSION" --install-location / --ownership recommended "$work/ollama-setup.pkg"

/bin/mkdir -p "$work/resources"
/bin/cp "$here/support/intro.html" "$work/resources/intro.html"
/bin/cat >"$work/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>WebAgents</title>
  <welcome file="intro.html" mime-type="text/html"/>
  <options customize="always" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <allowed-os-versions><os-version min="12.0"/></allowed-os-versions>
  <choices-outline>
    <line choice="helper"/>
    <line choice="ollama"/>
  </choices-outline>
  <choice id="helper" title="WebAgents native helper" description="Lets the WebAgents extension unlock your keys and records from the macOS keychain, and report Ollama's state. Required." enabled="false" start_selected="true">
    <pkg-ref id="$WA_PKG_HELPER"/>
  </choice>
  <choice id="ollama" title="Ollama for local models" description="Uses Ollama if it is already installed, otherwise installs it (Homebrew, or the pinned and checked release); then allows the extension to call it, now and at every login." start_selected="true">
    <pkg-ref id="$WA_PKG_OLLAMA"/>
  </choice>
  <pkg-ref id="$WA_PKG_HELPER" version="$WA_VERSION" onConclusion="none">helper.pkg</pkg-ref>
  <pkg-ref id="$WA_PKG_OLLAMA" version="$WA_VERSION" onConclusion="none">ollama-setup.pkg</pkg-ref>
</installer-gui-script>
XML
/bin/mkdir -p "$out"
target="$out/WebAgents-$WA_VERSION.pkg"
/bin/rm -f "$target"
/usr/bin/productbuild --quiet --distribution "$work/distribution.xml" --package-path "$work" --resources "$work/resources" "$target"
/usr/bin/shasum -a 256 "$target" | /usr/bin/awk '{print $1}' >"$target.sha256"
echo "$target"
