# Every path and name the macOS installer and its uninstaller touch (T17, D-203). Sourced by
# build-pkg.sh, both postinstall scripts, uninstall.sh, ollama-origins.sh and dry-run.sh, so the
# dry-run lists exactly what the scripts use.
WA_VERSION="0.1.0"
WA_SUPPORT="/Library/Application Support/WebAgents"
WA_HELPER="$WA_SUPPORT/webagents-helper"
WA_IDS="$WA_SUPPORT/extension-ids.json"
WA_PATHS="$WA_SUPPORT/paths.sh"
WA_UNINSTALL="$WA_SUPPORT/uninstall.sh"
WA_WELCOME="$WA_SUPPORT/welcome.html"
WA_ORIGINS_SCRIPT="$WA_SUPPORT/ollama-origins.sh"
WA_PIN="$WA_SUPPORT/ollama-pin.env"
WA_HOST_NAME="org.webagents.helper"
WA_HOST_MANIFEST="/Library/Google/Chrome/NativeMessagingHosts/$WA_HOST_NAME.json"
WA_AGENT_LABEL="org.webagents.ollama-origins"
WA_AGENT_PLIST="/Library/LaunchAgents/$WA_AGENT_LABEL.plist"
WA_LOG_DIR="/Library/Logs/WebAgents"
WA_LOG="$WA_LOG_DIR/installer.log"
# pkgutil receipts of the two component packages.
WA_PKG_HELPER="org.webagents.helper"
WA_PKG_OLLAMA="org.webagents.ollama-setup"
# The helper's login-keychain item (D-204), per user.
WA_KEYCHAIN_SERVICE="org.webagents.helper"
WA_KEYCHAIN_ACCOUNT="store-wrapping-key"
# Where Ollama is looked for (D-202); the installer never removes it.
OLLAMA_APP="/Applications/Ollama.app"
OLLAMA_CLIS="/opt/homebrew/bin/ollama /usr/local/bin/ollama"
BREWS="/opt/homebrew/bin/brew /usr/local/bin/brew"
OLLAMA_URL="http://127.0.0.1:11434"
# The extension's Chrome Web Store page; empty until U7 (the welcome page explains "load unpacked").
WA_STORE_URL=""

# What each component package installs (its payload), one path per line: the build stages
# exactly these, the dry-run lists them, test-installer.sh compares them with the built .pkg.
WA_HELPER_PAYLOAD="$WA_HELPER
$WA_IDS
$WA_PATHS
$WA_UNINSTALL
$WA_WELCOME
$WA_HOST_MANIFEST"
WA_OLLAMA_PAYLOAD="$WA_ORIGINS_SCRIPT
$WA_PIN
$WA_AGENT_PLIST"

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

# How the Ollama choice would obtain Ollama on this Mac (D-202): `present <where>`, `brew <brew>`
# or `download`. Shared by the postinstall script and the dry-run.
wa_ollama_plan() {
  local user="$1" candidate
  if [ -d "$OLLAMA_APP" ]; then echo "present $OLLAMA_APP"; return; fi
  if [ -n "$user" ] && [ -d "/Users/$user/Applications/Ollama.app" ]; then echo "present /Users/$user/Applications/Ollama.app"; return; fi
  for candidate in $OLLAMA_CLIS; do
    if [ -x "$candidate" ]; then echo "present $candidate"; return; fi
  done
  for candidate in $BREWS; do
    if [ -x "$candidate" ]; then echo "brew $candidate"; return; fi
  done
  echo "download"
}

# Run a command, or print it under DRY_RUN=1.
wa_run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "would run: $*"
  else
    "$@"
  fi
}
