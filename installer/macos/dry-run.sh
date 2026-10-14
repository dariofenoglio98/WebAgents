#!/bin/bash
# List every path and setting the WebAgents installer and its uninstaller would touch on this Mac,
# changing nothing (T17, D-203). Run as yourself: installer/macos/dry-run.sh
# Lines starting with "file " are the payload, which test-installer.sh compares with the built .pkg.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/paths.sh"
. "$here/ollama-pin.env"
user="$(wa_console_user)"
[ -n "$user" ] || user="$(/usr/bin/id -un)"
uid="$(/usr/bin/id -u "$user")"
ids="$(wa_extension_ids "$here/extension-ids.json")"

echo "WebAgents installer $WA_VERSION, dry run on $(/usr/bin/sw_vers -productName) $(/usr/bin/sw_vers -productVersion) for $user (nothing is changed)"
echo
echo "install · native helper (required, receipt $WA_PKG_HELPER):"
echo "$WA_HELPER_PAYLOAD" | /usr/bin/sed 's/^/  file /'
for id in $ids; do echo "  allow chrome-extension://$id/ in $WA_HOST_MANIFEST"; done
echo "  log  $WA_LOG"
echo "  open ${WA_STORE_URL:-file://$WA_WELCOME} for $user"
echo
echo "install · Ollama for local models (optional, receipt $WA_PKG_OLLAMA):"
echo "$WA_OLLAMA_PAYLOAD" | /usr/bin/sed 's/^/  file /'
plan="$(wa_ollama_plan "$user")"
case "$plan" in
  present*) echo "  ollama: found ${plan#present }; configure only, never reinstalled" ;;
  brew*) echo "  ollama: not found; would run as $user: ${plan#brew } install --cask ollama-app" ;;
  download) echo "  ollama: not found, no Homebrew; would download $OLLAMA_PIN_URL, check sha256 $OLLAMA_PIN_SHA256 and team $OLLAMA_TEAM_ID, install $OLLAMA_APP" ;;
esac
# The real origins script, against stubs that read the real state and print every change.
stubs="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf "$stubs"' EXIT
/bin/cp "$here/paths.sh" "$here/extension-ids.json" "$here/support/ollama-origins.sh" "$stubs/"
/bin/cat >"$stubs/launchctl" <<'STUB'
#!/bin/bash
if [ "$1" = "getenv" ]; then exec /bin/launchctl "$@"; fi
echo "  would run: launchctl $*"
STUB
/bin/cat >"$stubs/print" <<'STUB'
#!/bin/bash
echo "  would run: $(basename "$0") $*"
STUB
/bin/chmod +x "$stubs/launchctl" "$stubs/print"
/bin/ln -s print "$stubs/open"
/bin/ln -s print "$stubs/osascript"
WA_TEST_LAUNCHCTL="$stubs/launchctl" WA_TEST_OPEN="$stubs/open" WA_TEST_OSASCRIPT="$stubs/osascript" WA_TEST_SLEEP=true \
  /bin/bash "$stubs/ollama-origins.sh" --start | /usr/bin/sed 's/^ollama-origins: /  /'
echo "  would run: launchctl bootstrap gui/$uid $WA_AGENT_PLIST"
echo
echo "keychain (only when the person turns keychain unlock on in Settings → Security):"
echo "  item service=$WA_KEYCHAIN_SERVICE account=$WA_KEYCHAIN_ACCOUNT in $user's login keychain, created by the helper"
echo
echo "uninstall (sudo \"$WA_UNINSTALL\"):"
/bin/cp "$here/support/uninstall.sh" "$stubs/"
DRY_RUN=1 SUDO_USER="$user" /bin/bash "$stubs/uninstall.sh" --dry-run | /usr/bin/sed '1d; s/^/  /'
