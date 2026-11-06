#!/usr/bin/env bash
# Builds the signed Google Play bundle (.aab) for the TWA in this folder.
#
#   cd android && ./build-release.sh
#
# Reads the signing details from keystore-credentials.txt (gitignored, never
# printed) and passes them to Gradle as environment variables for this one
# command only. Afterwards it verifies the bundle is signed and prints the
# certificate's SHA-256, which must match assetlinks.json (upload key) — or,
# once Play App Signing is on, Google's own key must be added there too.
set -euo pipefail
cd "$(dirname "$0")"

CREDS="${CREDS_FILE:-keystore-credentials.txt}"
[ -f "$CREDS" ] || { echo "Missing $CREDS — it was generated with the keystore. Restore it from your backup."; exit 1; }

get() { grep -E "^$1=" "$CREDS" | head -1 | cut -d= -f2-; }
RM_KEYSTORE_PATH="$(get keystore_path)"
RM_KEY_ALIAS="$(get key_alias)"
RM_KEYSTORE_PASSWORD="$(get keystore_password)"
RM_KEY_PASSWORD="$(get key_password)"
# A relative keystore path in the credentials file is relative to this folder.
case "$RM_KEYSTORE_PATH" in /*) ;; *) RM_KEYSTORE_PATH="$PWD/$RM_KEYSTORE_PATH" ;; esac
for v in RM_KEYSTORE_PATH RM_KEY_ALIAS RM_KEYSTORE_PASSWORD RM_KEY_PASSWORD; do
  [ -n "${!v}" ] || { echo "$CREDS has no value for ${v#RM_} — check the file."; exit 1; }
done
[ -f "$RM_KEYSTORE_PATH" ] || { echo "Keystore file not found at: $RM_KEYSTORE_PATH"; exit 1; }
export RM_KEYSTORE_PATH RM_KEY_ALIAS RM_KEYSTORE_PASSWORD RM_KEY_PASSWORD

# Java 17+ is required (Android Gradle Plugin 8.9).
if ! /usr/libexec/java_home >/dev/null 2>&1; then
  for d in /opt/homebrew/opt/openjdk@17 /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk; do
    [ -x "$d/bin/java" ] && export JAVA_HOME="$d" && break
  done
  [ -n "${JAVA_HOME:-}" ] || { echo "No Java found. Install one: brew install openjdk@17"; exit 1; }
  export PATH="$JAVA_HOME/bin:$PATH"
fi
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"

./gradlew --no-daemon clean bundleRelease

AAB="app/build/outputs/bundle/release/app-release.aab"
echo
echo "Verifying signature…"
jarsigner -verify "$AAB" >/dev/null 2>&1 && echo "  signed: yes" || { echo "  signed: NO — the build ran without the keystore; do not upload this file."; exit 1; }
echo "  certificate:"
keytool -printcert -jarfile "$AAB" | grep -E "Owner:|SHA256:|Valid from"
echo
echo "Upload this file to Play Console:"
echo "  $PWD/$AAB"
