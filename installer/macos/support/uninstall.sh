#!/bin/bash
# Remove what the WebAgents installer added (T17, D-203; T41, D-457):
#   sudo "/Library/Application Support/WebAgents/uninstall.sh"            # remove
#   "/Library/Application Support/WebAgents/uninstall.sh" --dry-run        # list, change nothing
# The helper, its id list, the host manifest, the helper's keychain item for the person at the
# console, the installer's log and the receipt. What an earlier (0.1.0) install's Ollama choice
# left goes too: the extension's origins in OLLAMA_ORIGINS (through that install's own script,
# the rest of the variable kept), its LaunchAgent, its pin and its receipt. Never Ollama, never a
# model; the extension, its encrypted store and its in-browser model cache are untouched
# (uninstalling the extension in Chrome removes the cache).
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
  echo "the helper's keychain item, and an earlier 0.1.0 install's Ollama choice when present (this version installs none):"
  # An earlier install's Ollama choice: its own script takes the extension's origins out of OLLAMA_ORIGINS.
  if [ -f "$WA_LEGACY_ORIGINS_SCRIPT" ] || [ "${DRY_RUN:-0}" = "1" ]; then
    wa_run /bin/launchctl asuser "$uid" /usr/bin/sudo -u "$user" -H /bin/bash "$WA_LEGACY_ORIGINS_SCRIPT" --remove
  fi
  wa_run /bin/launchctl bootout "gui/$uid/$WA_LEGACY_AGENT_LABEL"
  wa_run /bin/launchctl asuser "$uid" /usr/bin/sudo -u "$user" -H /usr/bin/security delete-generic-password -s "$WA_KEYCHAIN_SERVICE" -a "$WA_KEYCHAIN_ACCOUNT"
else
  echo "no one at the console: keychain items (and an earlier install's OLLAMA_ORIGINS entry) are left for each user to remove"
fi
# An earlier install's system files: its LaunchAgent and its receipt, whoever is at the console.
echo "files and receipts:"
if [ -e "$WA_LEGACY_AGENT_PLIST" ] || [ "${DRY_RUN:-0}" = "1" ]; then wa_run /bin/rm -f "$WA_LEGACY_AGENT_PLIST"; fi
if /usr/sbin/pkgutil --pkg-info "$WA_LEGACY_PKG_OLLAMA" >/dev/null 2>&1 || [ "${DRY_RUN:-0}" = "1" ]; then wa_run /usr/sbin/pkgutil --forget "$WA_LEGACY_PKG_OLLAMA"; fi
for path in "$WA_HOST_MANIFEST"; do
  if [ -e "$path" ] || [ "${DRY_RUN:-0}" = "1" ]; then wa_run /bin/rm -f "$path"; fi
done
wa_run /bin/rm -rf "$WA_LOG_DIR"
for receipt in "$WA_PKG_HELPER"; do
  if /usr/sbin/pkgutil --pkg-info "$receipt" >/dev/null 2>&1 || [ "${DRY_RUN:-0}" = "1" ]; then wa_run /usr/sbin/pkgutil --forget "$receipt"; fi
done
wa_run /bin/rm -rf "$WA_SUPPORT"
echo "kept: Ollama and its models if you installed them, and the extension with its store and its model cache"
exit 0
