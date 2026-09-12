# GhostTrace — Zero-Trace Privacy Engine (Chrome MV3)

![Release](https://img.shields.io/badge/Release-v1.0.0-20c997?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Chromium%20MV3-00a8ff?style=flat-square)
![Engine](https://img.shields.io/badge/Engine-Zero--Trace%20MV3-ff9f43?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-85e89d?style=flat-square)

> **Version 1.0.0** · Manifest V3 · Minimum Chrome: 119 · Zero runtime dependencies · Zero telemetry

GhostTrace is an automated, zero-trace privacy and data cleaner extension for Chromium browsers. When you close a tab or leave an unlisted site, GhostTrace automatically removes all cookies, history, storage remnants, and download records left behind by that site — while keeping your whitelisted logins and sessions intact.

---

## Features

- **3-Tier Protection Model**:
  - **Whitelist**: Logins, cookies, and local data are permanently preserved. Granular cookie retention (`all`, `session-only`, or custom pattern matching like `auth_*`).
  - **Grey List**: Preserved only for the current browser session. All data and rules are wiped when the browser closes.
  - **Temporary Access**: Automatically expires after a set duration (15m, 1h, 24h) and purges data once no tabs remain open.
  - **Default (Unlisted)**: Cleaned automatically after closing the tab or navigating away (configurable 0–600s delay).
- **Accurate Domain Scoping**: Uses the real Public Suffix List (eTLD+1). Whitelisting `user.github.io` or `sub.example.com` never leaks protection to other sibling or parent domains.
- **Deep Clean Engine**:
  - **Cookies**: Removed one-by-one (including partitioned CHIPS cookies). Collateral damage to whitelisted parent cookies is prevented with immediate restore.
  - **History**: Paged and budget-limited deletion of visited URLs via `chrome.history.deleteUrl`.
  - **Download Records**: Erases download history entries from `chrome://downloads` without touching physical files on disk.
  - **Site Storage & Cache**: Targeted origin-based wiping of LocalStorage, IndexedDB, Service Workers, Cache Storage, OPFS, and HTTP disk cache.
- **URL Tracking Parameter Stripping**: Strips marketing and analytics identifiers (`utm_*`, `fbclid`, `gclid`, etc.) immediately on page load with zero reload, and cleans the dirty URL from browsing history.
- **Startup Full Sweep**: Optional setting to automatically sweep all unlisted cookies and browsing remnants whenever the browser starts.
- **Privacy Sandbox Hardening**: Optional controls to disable third-party cookies, related website sets, network prediction, address bar suggestions, and navigation error helpers.
- **100% Ephemeral Logging**: Diagnostic logs and third-party discovery maps live strictly in RAM (`chrome.storage.session`) and never touch disk.
- **Accessible & Responsive**: Fully localized in English and Turkish with light/dark/system themes, keyboard traps, WCAG-compliant contrast, and zero layout shift.

---

## Installation

### From Source (Developer Mode)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/StRonKEA/GhostTrace.git
   ```
2. Open Chrome/Chromium and navigate to `chrome://extensions`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `GhostTrace` project root directory.

---

## Development & Testing

GhostTrace has zero runtime dependencies and uses Node.js native test runner (`node:test`) with an in-memory Chrome API emulator.

```bash
# Install development tooling (ESLint)
npm install

# Run all 898 unit and integration tests
npm test

# Run code linter
npm run lint

# Run privacy, store, i18n, and UI consistency audits
npm run audit:privacy
npm run audit:store
npm run audit:i18n
npm run audit:ui

# Package extension zip for Chrome Web Store
npm run package
```

---

## License

MIT License. See [LICENSE](LICENSE) or source headers for details.
