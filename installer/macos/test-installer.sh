#!/bin/bash
# Check the macOS installer without installing it (T17; T41, D-457): build (or take) the .pkg,
# expand it, and compare its payload with the dry-run's list; check the one choice, the host
# manifest, the helper binary (universal, the smoke test), ownership and modes; that nothing in the
# package installs, configures or downloads Ollama; and the uninstaller in dry-run mode, which also
# cleans what an earlier 0.1.0 install's Ollama choice left.
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
dist="$work/x/Distribution"
check "one choice, the helper, required" bash -c "/usr/bin/grep -q '<choice id=\"helper\"[^>]*enabled=\"false\" start_selected=\"true\"' '$dist' && [ \"\$(/usr/bin/grep -c '<choice ' '$dist')\" = 1 ]"
check "the product holds one component package" bash -c "[ \"\$(cd '$work/x' && /bin/ls -d *.pkg)\" = helper.pkg ]"
check "macOS 12 or later" /usr/bin/grep -q '<os-version min="12.0"/>' "$dist"
check "the helper's postinstall script is in the .pkg" test -x "$work/x/helper.pkg/Scripts/postinstall"
check "no Ollama component: no choice, no receipt, no LaunchAgent, no script or pin in the package" bash -c "! /usr/bin/grep -qiE 'choice id=\"ollama|ollama-setup|ollama-origins' '$dist' && ! (cd '$work/x' && /usr/bin/find . -iname '*ollama*' | /usr/bin/grep -q .)"
check "the postinstall script obtains and configures nothing for Ollama" bash -c "! /usr/bin/grep -qiE 'ollama|brew|OLLAMA_ORIGINS' '$work/x/helper.pkg/Scripts/postinstall'"

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
check "the welcome page names the extension id" /usr/bin/grep -q "$first" "$work/x/helper.pkg/Payload$WA_WELCOME"


# -- the uninstaller, dry run --------------------------------------------------------------
stubs="$work/stubs"
/bin/mkdir -p "$stubs"
/bin/cp "$here/paths.sh" "$here/support/uninstall.sh" "$stubs/"
removal="$(DRY_RUN=1 /bin/bash "$stubs/uninstall.sh" --dry-run 2>&1)"
for target in "$WA_HOST_MANIFEST" "$WA_LOG_DIR" "$WA_SUPPORT"; do
  check "the uninstaller removes $target" bash -c "echo \"\$0\" | /usr/bin/grep -qF 'rm -' && echo \"\$0\" | /usr/bin/grep -qF '$target'" "$removal"
done
check "the uninstaller forgets the helper's receipt" bash -c "echo \"\$0\" | /usr/bin/grep -q 'forget $WA_PKG_HELPER'" "$removal"
check "the uninstaller removes an earlier install's LaunchAgent and forgets its receipt" bash -c "echo \"\$0\" | /usr/bin/grep -qF 'rm -f $WA_LEGACY_AGENT_PLIST' && echo \"\$0\" | /usr/bin/grep -q 'bootout gui/[0-9]*/$WA_LEGACY_AGENT_LABEL' && echo \"\$0\" | /usr/bin/grep -q 'forget $WA_LEGACY_PKG_OLLAMA'" "$removal"
check "the uninstaller takes an earlier install's origins out of OLLAMA_ORIGINS with that install's own script" bash -c "echo \"\$0\" | /usr/bin/grep -qF '$WA_LEGACY_ORIGINS_SCRIPT --remove'" "$removal"
check "the uninstaller never removes Ollama" bash -c "! echo \"\$0\" | /usr/bin/grep -E 'rm .*(/Applications/Ollama\.app|/\.ollama|Caskroom|ollama-app)'" "$removal"
check "the uninstaller refuses without sudo" bash -c "! /bin/bash '$stubs/uninstall.sh'"

printf '{"pkg": "%s", "sha256": "%s", "checks": %d, "failed": [' "$pkg" "$(/usr/bin/shasum -a 256 "$pkg" | /usr/bin/awk '{print $1}')" "$total"
separator=""
for name in "${failed[@]:-}"; do [ -n "$name" ] && printf '%s"%s"' "$separator" "$name" && separator=", "; done
printf '], "passed": %s}\n' "$([ ${#failed[@]} -eq 0 ] && echo true || echo false)"
[ ${#failed[@]} -eq 0 ]
