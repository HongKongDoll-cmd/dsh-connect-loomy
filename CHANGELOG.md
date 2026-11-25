# Changelog

All notable changes to `dsh-connect-loomy` will be documented in this file.

## [0.2.0] - 2026-11-26

### Added
- WorkBuddy-aligned 5-tab settings & full-page UI (`Accounts`, `Models`, `Capabilities`, `Diagnostics`, `SDK`).
- Optional **Show Loomy in the sidebar** toggle with dedicated full-page route and "Back to conversation" navigation.
- Live per-model and batch availability/latency/TPS probing (`Probe`).
- Points redemption code support (`POST /api/v1/points/redemption-codes/redeem`).
- Compatibility mode toggle (`dropAllThinking`) forcing `reasoning_effort: none` and `enable_thinking: false`.
- Repository publishing hygiene: 128px PNG icon, privacy policy, GitHub CI & Release tarball workflows, PII scanner, and `awesome-dsh-plugin` submission template.

### Fixed
- Primary button contrast in DSH dark themes and non-overlapping section tabs.
- Immediate persistence of local settings overrides alongside DSH host settings service.

## [0.1.0] - 2026-11-26

### Added
- Initial release integrating iFlyTek Loomy models into DeepSeek Harness.
- Standalone WeChat QR login (with SMS phone-binding fallback), SMS login, manual token entry, and local Loomy Desktop session auto-discovery.
- Multi-account vault (`$DSH_HOME/loomy-vault/accounts.json`) and automatic same-model failover across accounts on `100002`, `429`, credit exhaustion, or model unavailability.
- Composer credits pill with one-click primary account switching.
