<p align="center">
  <img src="icons/dsh-connect-loomy-128.png" width="96" alt="dsh-connect-loomy icon">
</p>

# dsh-connect-loomy

English | [中文](README.md)

Connects **iFlyTek Loomy** (`loomy.xunfei.cn`) models and multi-account pools to **DeepSeek Harness (DSH)**. Supports standalone WeChat QR / SMS sign-in without requiring the desktop client, automatic catalog & point-multiplier sync, transparent same-model failover across accounts, points balance & redemption codes, live model probing, and an optional full-page sidebar view.

## Features

- **Standalone Sign-In**: Built-in WeChat QR scan (including SMS phone-binding fallback) and mobile SMS code login, plus local Loomy Desktop session discovery and manual token support.
- **Multi-Account Pool & Auto-Failover**: Manage multiple accounts with health badges, cooldown timers, balances, and transparent same-model failover on `100002` auth expiry, credit exhaustion, HTTP 429 rate limits, or transient model failures.
- **5-Tab UI & Optional Sidebar Panel**: Organized into **Accounts / Models / Capabilities / Diagnostics / SDK** tabs, with per-model latency/TPS probing, redemption codes, compatibility mode (`dropAllThinking`), composer points pill, and an opt-in sidebar entry.
- **Privacy First**: Credentials remain locally in `$DSH_HOME/loomy-vault/accounts.json` (`0600`) and are never exposed to the browser or telemetry services. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Installation

- **Prebuilt GitHub Release tarball (recommended, no build scripts required)**:
  ```sh
  dsh plugin add https://github.com/HongKongDoll-cmd/dsh-connect-loomy/releases/latest/download/dsh-connect-loomy-0.2.0.tgz
  ```
- **Local checkout / development**:
  ```sh
  pnpm install
  pnpm run check
  ```
  Then add the directory in DSH via **Plugins → Add plugin**.
