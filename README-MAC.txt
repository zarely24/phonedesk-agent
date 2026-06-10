PhoneDesk - build the Mac app
=============================

You need a Mac with Node.js (LTS) installed first:  https://nodejs.org
(Download the big "LTS" button, install it, then continue.)

STEPS
-----
1. Unzip this folder somewhere easy, like your Desktop.
2. Open the "Terminal" app (press Cmd+Space, type Terminal, Return).
3. In Terminal, type  cd  followed by a space, then DRAG the unzipped folder onto
   the Terminal window, then press Return.
4. Type this and press Return:
       bash build-mac.command
5. Wait. It installs and builds (first time: a few minutes). When it's done, your
   app is at:   dist-installers/PhoneDesk.dmg
6. Upload PhoneDesk.dmg to your GitHub Release (next to PhoneDesk-Windows.zip).

That's it - the "Download for macOS" button on your website will then work.

NOTE (unsigned app): the first time an owner opens it, they RIGHT-CLICK the app and
choose "Open" (not double-click). If macOS still refuses, open Terminal and run:
       xattr -cr /Applications/PhoneDesk.app
A paid Apple Developer account ($99/yr) removes this step later.

Stuck on any step? Send me what Terminal printed and I'll help.
