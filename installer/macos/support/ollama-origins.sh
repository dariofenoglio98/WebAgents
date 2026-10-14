#!/bin/bash
# Add the WebAgents extension's origins to OLLAMA_ORIGINS in this login session, and make a running
# Ollama pick them up (T17, D-203). Runs as the user: at every login from the LaunchAgent, once from
# the installer with --start (start Ollama if it is not running), and from the uninstaller with
# --remove (take the installer's origins out, keep everything else). An existing wildcard
# (`*` or `chrome-extension://*`) is kept as found: it already admits the extension.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/paths.sh"
mode="${1:-login}"
# Test seams (test-installer.sh runs this script against stubs); unset in real use.
LAUNCHCTL="${WA_TEST_LAUNCHCTL:-/bin/launchctl}"
CURL="${WA_TEST_CURL:-/usr/bin/curl}"
OPEN="${WA_TEST_OPEN:-/usr/bin/open}"
OSASCRIPT="${WA_TEST_OSASCRIPT:-/usr/bin/osascript}"
SLEEP="${WA_TEST_SLEEP:-sleep}"

say() {
  echo "ollama-origins: $*"
  /usr/bin/logger -t "$WA_AGENT_LABEL" "$*" 2>/dev/null || true
}

ids="$(wa_extension_ids "$here/extension-ids.json")"
if [ -z "$ids" ]; then
  say "no extension id in $here/extension-ids.json; nothing to do"
  exit 0
fi
current="$($LAUNCHCTL getenv OLLAMA_ORIGINS 2>/dev/null || true)"
ours() {
  local entry="$1" id
  for id in $ids; do [ "$entry" = "chrome-extension://$id" ] && return 0; done
  return 1
}

kept=""
wildcard="no"
IFS=',' read -r -a entries <<<"$current"
for raw in "${entries[@]:-}"; do
  entry="$(echo "$raw" | /usr/bin/sed -e 's/^ *//' -e 's/ *$//' -e 's#/$##')"
  [ -z "$entry" ] && continue
  case "$entry" in "*" | "chrome-extension://*") wildcard="yes" ;; esac
  if [ "$mode" = "--remove" ] && ours "$entry"; then continue; fi
  case ",$kept," in *",$entry,"*) continue ;; esac
  kept="${kept:+$kept,}$entry"
done
if [ "$mode" != "--remove" ]; then
  if [ "$wildcard" = "yes" ]; then
    say "OLLAMA_ORIGINS already admits every extension ($current); kept as found"
  else
    for id in $ids; do
      case ",$kept," in *",chrome-extension://$id,"*) ;; *) kept="${kept:+$kept,}chrome-extension://$id" ;; esac
    done
  fi
fi

if [ "$kept" != "$current" ]; then
  if [ -z "$kept" ]; then
    "$LAUNCHCTL" unsetenv OLLAMA_ORIGINS
    say "OLLAMA_ORIGINS unset (was: $current)"
  else
    "$LAUNCHCTL" setenv OLLAMA_ORIGINS "$kept"
    say "OLLAMA_ORIGINS=$kept (was: ${current:-unset})"
  fi
else
  say "OLLAMA_ORIGINS unchanged (${current:-unset})"
fi
[ "$mode" = "--remove" ] && exit 0

# A running Ollama reads the variable when it starts: restart the app if it still rejects us.
first="$(echo "$ids" | /usr/bin/head -n 1)"
status() { "$CURL" -s -o /dev/null -m 3 -w '%{http_code}' -H "Origin: chrome-extension://$first" "$OLLAMA_URL/api/version" 2>/dev/null || true; }
app=""
[ -d "$OLLAMA_APP" ] && app="$OLLAMA_APP"
[ -z "$app" ] && [ -d "$HOME/Applications/Ollama.app" ] && app="$HOME/Applications/Ollama.app"
# At login Ollama may still be starting: wait for it a little.
tries=1
[ "$mode" = "login" ] && tries=20
code="$(status)"
while [ "$code" != "200" ] && [ "$code" != "403" ] && [ "$tries" -gt 1 ]; do
  "$SLEEP" 2
  tries=$((tries - 1))
  code="$(status)"
done
if [ "$code" = "200" ]; then
  say "Ollama is running and admits the extension"
elif [ "$code" = "403" ] && [ -n "$app" ]; then
  say "Ollama is running but rejects the extension's origin; restarting $app"
  "$OSASCRIPT" -e 'quit app "Ollama"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(status)" = "000" ] && break; "$SLEEP" 1; done
  "$OPEN" -g -a "$app"
elif [ "$code" = "403" ]; then
  say "Ollama is running but rejects the extension's origin; restart it (it reads OLLAMA_ORIGINS at start)"
elif [ "$mode" = "--start" ] && [ -n "$app" ]; then
  say "starting $app"
  "$OPEN" -g -a "$app"
else
  say "Ollama is not running"
fi
exit 0
