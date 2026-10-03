# BambooKit Desktop

BambooKit is an AI coding workspace for Windows with a phone remote. Chat with coding agents on your PC,
review diffs, and keep an eye on sessions, approvals and changed files from the BambooKit Android app.
Sessions are stored only on your PC; the BambooKit API relays them live to your phone and never keeps
chats, code or diffs.

- Website and docs: https://bambookit-web.onrender.com
- API: https://bambookit-api.onrender.com

## Install (Windows 10/11, 64-bit)

Run in PowerShell:

```powershell
irm https://bambookit-web.onrender.com/install.ps1 | iex
```

Or download `BambooKit-Setup-<version>-x64.exe` from the
[latest release](https://github.com/BambooKit/bambookit-application/releases/latest) and run it.
The installer is not code-signed yet, so Windows SmartScreen may ask you to confirm ("More info" → "Run anyway").

Then open **BambooKit** from the Start menu, sign in, and pair your phone:
BambooKit (title bar) → **Add mobile device** → scan the QR code in the BambooKit Android app.

## Build from source

Requirements: [Bun](https://bun.sh) 1.3+, Node.js 22+, Git.

```powershell
git clone https://github.com/BambooKit/bambookit-application.git
cd bambookit-application
bun install
cd packages/desktop
copy .env.bambookit.example .env.bambookit   # BambooKit API, Supabase and Firebase public settings
$env:OPENCODE_CHANNEL = "prod"
bun ./scripts/prebuild.ts
bun run build
bun run package:win                           # installer in packages/desktop/dist
```

## Credits

BambooKit Desktop is built on [OpenCode](https://github.com/anomalyco/opencode) (MIT License, see
[LICENSE](LICENSE)). The agent engine, models and tools come from OpenCode; BambooKit adds the account,
device pairing, phone remote, session relay, file map and project diagram, and its own branding.
