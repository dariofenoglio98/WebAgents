#!/bin/bash
# List every path and setting the WebAgents installer and its uninstaller would touch on this Mac,
# changing nothing (T17, D-203; T41, D-457). Run as yourself: installer/macos/dry-run.sh
# Lines starting with "file " are the payload, which test-installer.sh compares with the built .pkg.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/paths.sh"
user="$(wa_console_user)"
[ -n "$user" ] || user="$(/usr/bin/id -un)"
ids="$(wa_extension_ids "$here/extension-ids.json")"

echo "WebAgents installer $WA_VERSION, dry run on $(/usr/bin/sw_vers -productName) $(/usr/bin/sw_vers -productVersion) for $user (nothing is changed)"
echo
echo "install · native helper (receipt $WA_PKG_HELPER):"
echo "$WA_HELPER_PAYLOAD" | /usr/bin/sed 's/^/  file /'
for id in $ids; do echo "  allow chrome-extension://$id/ in $WA_HOST_MANIFEST"; done
echo "  log  $WA_LOG"
echo "  open ${WA_STORE_URL:-file://$WA_WELCOME} for $user"
echo
echo "keychain (only when the person turns keychain unlock on in Settings → Security):"
echo "  item service=$WA_KEYCHAIN_SERVICE account=$WA_KEYCHAIN_ACCOUNT in $user's login keychain, created by the helper"
echo
echo "uninstall (sudo \"$WA_UNINSTALL\"):"
stubs="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf "$stubs"' EXIT
/bin/cp "$here/paths.sh" "$here/support/uninstall.sh" "$stubs/"
DRY_RUN=1 SUDO_USER="$user" /bin/bash "$stubs/uninstall.sh" --dry-run | /usr/bin/sed '1d; s/^/  /'
