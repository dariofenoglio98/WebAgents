#!/bin/bash
# Check the macOS installer without installing it (T17): build (or take) the .pkg, expand it, and
# compare its payload with the dry-run's list; check the choices, the host manifest, the helper
# binary (universal, the smoke test), ownership and modes; run ollama-origins.sh against stubs
# (add, keep, wildcard, remove, restart, start) and the uninstaller in dry-run mode.
# Usage: installer/macos/test-installer.sh [path/to/WebAgents-<version>.pkg]. Prints JSON with "passed".
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
. "$here/paths.sh"
pkg="${1:-}"
if [ -z "$pkg" ]; then pkg="$("$here/build-pkg.sh" 2>/dev/null | /usr/bin/tail -n 1)"; fi
work="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf "$work"' EXIT
failed=()
total=0
check() { # name, then a command that must succeed
  local name="$1"
  shift
  total=$((total + 1))
  if "$@" >/dev/null 2>&1; then echo "ok   $name" >&2; else echo "FAIL $name" >&2; failed+=("$name"); fi
}
same() { [ "$1" = "$2" ]; }
ids="$(wa_extension_ids "$here/extension-ids.json")"
first="$(echo "$ids" | /usr/bin/head -n 1)"

# -- the package ---------------------------------------------------------------------------
check "the .pkg exists" test -s "$pkg"
/usr/sbin/pkgutil --expand-full "$pkg" "$work/x" >/dev/null 2>&1
check "the .pkg expands" test -d "$work/x/helper.pkg/Payload"
payload() { (cd "$work/x/$1/Payload" && /usr/bin/find . -type f | /usr/bin/sed 's#^\.##' | LC_ALL=C /usr/bin/sort); }
listed() { "$here/dry-run.sh" | /usr/bin/sed -n "/^install · $1/,/^\$/p" | /usr/bin/sed -n 's/^  file //p' | LC_ALL=C /usr/bin/sort; }
check "the helper payload is exactly the dry-run's list" same "$(payload helper.pkg)" "$(listed "native helper")"
check "the Ollama payload is exactly the dry-run's list" same "$(payload ollama-setup.pkg)" "$(listed "Ollama")"
dist="$work/x/Distribution"
check "two choices, the helper required" /usr/bin/grep -q '<choice id="helper"[^>]*enabled="false" start_selected="true"' "$dist"
check "the Ollama choice is optional and on by default" /usr/bin/grep -q '<choice id="ollama"[^>]*start_selected="true"' "$dist"
check "the Ollama choice can be unticked" bash -c "! /usr/bin/grep -q '<choice id=\"ollama\"[^>]*enabled=\"false\"' '$dist'"
check "macOS 12 or later" /usr/bin/grep -q '<os-version min="12.0"/>' "$dist"
check "both postinstall scripts are in the .pkg" test -x "$work/x/helper.pkg/Scripts/postinstall" -a -x "$work/x/ollama-setup.pkg/Scripts/postinstall"
check "the pinned Ollama checksum travels with the Ollama script" /usr/bin/grep -q "^OLLAMA_PIN_SHA256=\"[0-9a-f]\{64\}\"" "$work/x/ollama-setup.pkg/Scripts/ollama-pin.env"

manifest="$work/x/helper.pkg/Payload$WA_HOST_MANIFEST"
expected_origins="$(for id in $ids; do echo "chrome-extension://$id/"; done)"
read_json() { /usr/bin/plutil -extract "$1" raw -o - "$manifest" 2>/dev/null; }
origins_in() { local index=0 value; while value="$(read_json "allowed_origins.$index")"; do echo "$value"; index=$((index + 1)); done; }
check "the host manifest names the host" same "$(read_json name)" "$WA_HOST_NAME"
check "the host manifest points at the installed helper" same "$(read_json path)" "$WA_HELPER"
check "the host manifest is stdio" same "$(read_json type)" "stdio"
check "the host manifest allows exactly the listed extension ids" same "$(origins_in)" "$expected_origins"
binary="$work/x/helper.pkg/Payload$WA_HELPER"
check "the helper is universal (arm64 and x86_64)" bash -c "/usr/bin/lipo -archs '$binary' | /usr/bin/grep -q arm64 && /usr/bin/lipo -archs '$binary' | /usr/bin/grep -q x86_64"
check "the helper's signature verifies" /usr/bin/codesign --verify --strict "$binary"
check "the helper links only system libraries" bash -c "/usr/bin/otool -L '$binary' | /usr/bin/grep -qE '^\s+/usr/lib/swift/' && ! /usr/bin/otool -L '$binary' | /usr/bin/grep -E '^\s' | /usr/bin/grep -v -E '^\s+(/usr/lib/|/System/Library/)'"
check "the helper's smoke test passes" node "$repo/native-helper/scripts/smoke.mjs" "$binary"
bom() { /usr/bin/lsbom -p MUGf "$work/x/$1/Bom" | /usr/bin/grep -F "$2"; }
check "the helper is root-owned and 0755" bash -c "/usr/bin/lsbom -p MUGf '$work/x/helper.pkg/Bom' | /usr/bin/grep -E '^-?rwxr-xr-x\s+root\s+wheel\s+\./Library/Application Support/WebAgents/webagents-helper$'"
check "the host manifest is root-owned and 0644" bash -c "/usr/bin/lsbom -p MUGf '$work/x/helper.pkg/Bom' | /usr/bin/grep -E '^-?rw-r--r--\s+root\s+wheel\s+\./Library/Google/Chrome/NativeMessagingHosts/org.webagents.helper.json$'"
check "the LaunchAgent is a valid plist running the installed script" bash -c "/usr/bin/plutil -lint '$work/x/ollama-setup.pkg/Payload$WA_AGENT_PLIST' && /usr/bin/plutil -extract ProgramArguments.1 raw -o - '$work/x/ollama-setup.pkg/Payload$WA_AGENT_PLIST' | /usr/bin/grep -qx '$WA_ORIGINS_SCRIPT'"
check "the welcome page names the extension id" /usr/bin/grep -q "$first" "$work/x/helper.pkg/Payload$WA_WELCOME"

# -- ollama-origins.sh against stubs -------------------------------------------------------
stubs="$work/stubs"
/bin/mkdir -p "$stubs"
/bin/cp "$here/paths.sh" "$here/extension-ids.json" "$here/support/ollama-origins.sh" "$stubs/"
/bin/cat >"$stubs/launchctl" <<'STUB'
#!/bin/bash
state="$(dirname "$0")/env"
case "$1" in
  getenv) [ -f "$state" ] && cat "$state" ;;
  setenv) printf '%s' "$3" >"$state" ;;
  unsetenv) rm -f "$state" ;;
esac
STUB
/bin/cat >"$stubs/curl" <<'STUB'
#!/bin/bash
cat "$(dirname "$0")/http" 2>/dev/null || printf '000'
STUB
/bin/cat >"$stubs/record" <<'STUB'
#!/bin/bash
echo "$(basename "$0") $*" >>"$(dirname "$0")/calls"
[ "$(basename "$0")" = "osascript" ] && printf '000' >"$(dirname "$0")/http"
exit 0
STUB
/bin/chmod +x "$stubs/launchctl" "$stubs/curl" "$stubs/record"
/bin/ln -s record "$stubs/open"
/bin/ln -s record "$stubs/osascript"
origins() { # mode, starting value ("" = unset), HTTP status Ollama answers
  /bin/rm -f "$stubs/env" "$stubs/calls" "$stubs/http"
  [ -n "$2" ] && printf '%s' "$2" >"$stubs/env"
  printf '%s' "$3" >"$stubs/http"
  HOME="$work" WA_TEST_LAUNCHCTL="$stubs/launchctl" WA_TEST_CURL="$stubs/curl" WA_TEST_OPEN="$stubs/open" WA_TEST_OSASCRIPT="$stubs/osascript" WA_TEST_SLEEP=true /bin/bash "$stubs/ollama-origins.sh" "$1" >/dev/null 2>&1
  /bin/cat "$stubs/env" 2>/dev/null || printf '<unset>'
}
calls() { /bin/cat "$stubs/calls" 2>/dev/null; }
ext="chrome-extension://$first"
check "an unset OLLAMA_ORIGINS gets the extension's origin" same "$(origins login "" 200)" "$ext"
check "an existing value is kept and the origin appended" same "$(origins login "http://example.test" 200)" "http://example.test,$ext"
check "the origin is never added twice (a trailing slash counts)" same "$(origins login "$ext/" 200)" "$ext"
check "a wildcard is kept as found" same "$(origins login "chrome-extension://*" 200)" "chrome-extension://*"
check "--remove takes only the installer's origin out" same "$(origins --remove "http://example.test,$ext" 200)" "http://example.test"
check "--remove of the last origin unsets the variable" same "$(origins --remove "$ext" 200)" "<unset>"
if [ -d "$OLLAMA_APP" ]; then
  origins login "" 403 >/dev/null
  check "a running Ollama that rejects the origin is restarted" bash -c "/usr/bin/grep -q '^osascript ' '$stubs/calls' && /usr/bin/grep -q '^open -g -a $OLLAMA_APP' '$stubs/calls'"
  origins --start "" 000 >/dev/null
  check "--start starts Ollama when it is not running" /usr/bin/grep -q "^open -g -a $OLLAMA_APP" "$stubs/calls"
  origins login "" 200 >/dev/null
  check "an Ollama that admits the origin is left alone" bash -c "[ ! -s '$stubs/calls' ]"
fi

# -- the uninstaller, dry run --------------------------------------------------------------
/bin/cp "$here/support/uninstall.sh" "$stubs/"
removal="$(DRY_RUN=1 /bin/bash "$stubs/uninstall.sh" --dry-run 2>&1)"
for target in "$WA_HOST_MANIFEST" "$WA_AGENT_PLIST" "$WA_LOG_DIR" "$WA_SUPPORT"; do
  check "the uninstaller removes $target" bash -c "echo \"\$0\" | /usr/bin/grep -qF 'rm -' && echo \"\$0\" | /usr/bin/grep -qF '$target'" "$removal"
done
check "the uninstaller forgets both receipts" bash -c "echo \"\$0\" | /usr/bin/grep -q 'forget $WA_PKG_HELPER' && echo \"\$0\" | /usr/bin/grep -q 'forget $WA_PKG_OLLAMA'" "$removal"
check "the uninstaller never removes Ollama" bash -c "! echo \"\$0\" | /usr/bin/grep -E 'rm .*(/Applications/Ollama\.app|/\.ollama|Caskroom|ollama-app)'" "$removal"
check "the uninstaller refuses without sudo" bash -c "! /bin/bash '$stubs/uninstall.sh'"

printf '{"pkg": "%s", "sha256": "%s", "checks": %d, "failed": [' "$pkg" "$(/usr/bin/shasum -a 256 "$pkg" | /usr/bin/awk '{print $1}')" "$total"
separator=""
for name in "${failed[@]:-}"; do [ -n "$name" ] && printf '%s"%s"' "$separator" "$name" && separator=", "; done
printf '], "passed": %s}\n' "$([ ${#failed[@]} -eq 0 ] && echo true || echo false)"
[ ${#failed[@]} -eq 0 ]
