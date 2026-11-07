#!/bin/sh
# QA only (team-signed QA copies, ARCHITECTURE §5.3: only a team-signed copy gets the Computer Use app group).
# Imports an Apple Development identity (.p12) into a dedicated keychain of the QA user, so codesign over ssh never shows a dialog:
# the keychain has an empty password, never auto-locks, and its key partition list allows codesign. The user's login keychain is not
# touched; the new keychain is only added to the user's search list. Run as the QA user, with a terminal for the password:
#   ssh -t <qa-host> 'sh "<checkout>/scripts/qa/signing-keychain.sh" "<path to identity.p12>"'
set -eu
P12="${1:?usage: signing-keychain.sh <identity.p12>}"
KC="$HOME/Library/Keychains/qa-signing.keychain-db"
[ -f "$KC" ] || security create-keychain -p "" "$KC"
security set-keychain-settings "$KC"
security unlock-keychain -p "" "$KC"
printf 'Password of %s: ' "$P12"
stty -echo; read -r PW; stty echo; echo
security import "$P12" -k "$KC" -P "$PW" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KC" >/dev/null
case "$(security list-keychains -d user)" in
  *qa-signing.keychain-db*) ;;
  *) eval "security list-keychains -d user -s \"$KC\" $(security list-keychains -d user | tr '\n' ' ')" ;;
esac
security find-identity -v -p codesigning "$KC"
# Keychain Access exports only the key when the key row is selected; the identity also needs its certificate (export the certificate
# row under My Certificates, or add the DER certificates with `security add-certificates -k "$KC" <cert>...`).
if ! security find-identity -v -p codesigning "$KC" | grep -q '1)'; then
  echo "No signing identity: the .p12 holds no certificate for its key. Export the certificate row under My Certificates." >&2
  exit 1
fi
