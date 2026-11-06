# Every path and name the macOS installer and its uninstaller touch (T17, D-203; T41, D-457).
# Sourced by build-pkg.sh, the helper's postinstall script, uninstall.sh and dry-run.sh, so the
# dry-run lists exactly what the scripts use. Since 0.2.0 the installer installs the native helper
# only (D-446): the extension runs open-weight models itself, in the browser, and Ollama is a route
# a person may still choose and set up by hand (Settings → Models shows the commands).
WA_VERSION="0.2.0"
WA_SUPPORT="/Library/Application Support/WebAgents"
WA_HELPER="$WA_SUPPORT/webagents-helper"
WA_IDS="$WA_SUPPORT/extension-ids.json"
WA_PATHS="$WA_SUPPORT/paths.sh"
WA_UNINSTALL="$WA_SUPPORT/uninstall.sh"
WA_WELCOME="$WA_SUPPORT/welcome.html"
WA_HOST_NAME="org.webagents.helper"
WA_HOST_MANIFEST="/Library/Google/Chrome/NativeMessagingHosts/$WA_HOST_NAME.json"
WA_LOG_DIR="/Library/Logs/WebAgents"
WA_LOG="$WA_LOG_DIR/installer.log"
# The pkgutil receipt of the component package.
WA_PKG_HELPER="org.webagents.helper"
# What an earlier (0.1.0) install's Ollama choice left, which the uninstaller still removes (D-457):
# its script (run with --remove first, to take the extension's origins out of OLLAMA_ORIGINS and
# keep the rest), its pin, its LaunchAgent and its receipt. Nothing installs these any more.
WA_LEGACY_ORIGINS_SCRIPT="$WA_SUPPORT/ollama-origins.sh"
WA_LEGACY_PIN="$WA_SUPPORT/ollama-pin.env"
WA_LEGACY_AGENT_LABEL="org.webagents.ollama-origins"
WA_LEGACY_AGENT_PLIST="/Library/LaunchAgents/$WA_LEGACY_AGENT_LABEL.plist"
WA_LEGACY_PKG_OLLAMA="org.webagents.ollama-setup"
# The helper's login-keychain item (D-204), per user.
WA_KEYCHAIN_SERVICE="org.webagents.helper"
WA_KEYCHAIN_ACCOUNT="store-wrapping-key"
# The extension's Chrome Web Store page; empty until U7 (the welcome page explains "load unpacked").
WA_STORE_URL=""

# What the component package installs (its payload), one path per line: the build stages
# exactly these, the dry-run lists them, test-installer.sh compares them with the built .pkg.
WA_HELPER_PAYLOAD="$WA_HELPER
$WA_IDS
$WA_PATHS
$WA_UNINSTALL
$WA_WELCOME
$WA_HOST_MANIFEST"

# The person at the console (the postinstall scripts run as root).
wa_console_user() {
  local user
  user="$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || true)"
  case "$user" in "" | root | loginwindow | _mbsetupuser) echo "" ;; *) echo "$user" ;; esac
}

# The extension ids, one per line, from an extension-ids.json (`{"extension_ids": [...]}`).
wa_extension_ids() {
  local file="$1" index=0 id
  while id="$(/usr/bin/plutil -extract "extension_ids.$index" raw -o - "$file" 2>/dev/null)"; do
    echo "$id"
    index=$((index + 1))
  done
}

wa_log() {
  /bin/mkdir -p "$WA_LOG_DIR" 2>/dev/null || true
  echo "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) $*" | /usr/bin/tee -a "$WA_LOG" 2>/dev/null || echo "$*"
}

# The person's home directory as Directory Services records it (not always /Users/<name>).
wa_user_home() {
  local home
  home="$(/usr/bin/dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}')"
  echo "${home:-/Users/$1}"
}


# Run a command, or print it under DRY_RUN=1.
wa_run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "would run: $*"
  else
    "$@"
  fi
}
