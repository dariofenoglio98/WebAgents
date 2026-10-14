#!/bin/bash
# Remove what the WebAgents installer added (T17, D-203):
#   sudo "/Library/Application Support/WebAgents/uninstall.sh"            # remove
#   "/Library/Application Support/WebAgents/uninstall.sh" --dry-run        # list, change nothing
# The helper, its id list, the host manifest, the LaunchAgent, the extension's origins in
# OLLAMA_ORIGINS (the rest of the variable is kept), the helper's keychain item for the person at
# the console, the installer's log and the pkgutil receipts. Never Ollama, never a model; the
# extension and its encrypted store are untouched (the passphrase keeps working).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/paths.sh"
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
if [ "${DRY_RUN:-0}" != "1" ] && [ "$(/usr/bin/id -u)" != "0" ]; then
  echo "run with sudo (or --dry-run to list what would be removed)" >&2
  exit 1
fi
user="${SUDO_USER:-}"
[ -z "$user" ] || [ "$user" = "root" ] && user="$(wa_console_user)"
echo "WebAgents uninstall${DRY_RUN:+ (dry run)}"
if [ -n "$user" ]; then
  uid="$(/usr/bin/id -u "$user")"
  echo "user: $user"
  wa_run /bin/launchctl asuser "$uid" /usr/bin/sudo -u "$user" -H /bin/bash "$WA_ORIGINS_SCRIPT" --remove
  wa_run /bin/launchctl bootout "gui/$uid/$WA_AGENT_LABEL"
  wa_run /bin/launchctl asuser "$uid" /usr/bin/sudo -u "$user" -H /usr/bin/security delete-generic-password -s "$WA_KEYCHAIN_SERVICE" -a "$WA_KEYCHAIN_ACCOUNT"
else
  echo "no one at the console: OLLAMA_ORIGINS and keychain items are left for each user to remove"
fi
for path in "$WA_HOST_MANIFEST" "$WA_AGENT_PLIST"; do
  if [ -e "$path" ] || [ "${DRY_RUN:-0}" = "1" ]; then wa_run /bin/rm -f "$path"; fi
done
wa_run /bin/rm -rf "$WA_LOG_DIR"
for receipt in "$WA_PKG_HELPER" "$WA_PKG_OLLAMA"; do
  if /usr/sbin/pkgutil --pkg-info "$receipt" >/dev/null 2>&1 || [ "${DRY_RUN:-0}" = "1" ]; then wa_run /usr/sbin/pkgutil --forget "$receipt"; fi
done
wa_run /bin/rm -rf "$WA_SUPPORT"
echo "kept: Ollama ($OLLAMA_APP or Homebrew), its models, and the extension with its store"
exit 0
