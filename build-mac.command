#!/bin/bash
# PhoneDesk - build the macOS app. Run this on a Mac (see README-MAC.txt).
set -e
cd "$(dirname "$0")"
echo "==> PhoneDesk Mac builder"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is not installed."
  echo "Install the LTS version from https://nodejs.org , then run this again."
  echo ""
  read -p "Press Return to close. "
  exit 1
fi
echo "Node $(node -v), npm $(npm -v)"

# Make the bundled mac adb runnable and clear any download quarantine.
chmod +x resources/adb/mac/adb 2>/dev/null || true
xattr -dr com.apple.quarantine resources/adb/mac/adb 2>/dev/null || true

echo "==> Installing dependencies (first run can take a few minutes)..."
npm install

echo "==> Building the app (unsigned)..."
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --mac

echo ""
echo "==> Done. Your app:"
ls -1 dist-installers/*.dmg 2>/dev/null || echo "  (check the dist-installers folder)"
echo ""
echo "Next: upload PhoneDesk.dmg to your GitHub Release, next to PhoneDesk-Windows.zip."
read -p "Press Return to close. "
