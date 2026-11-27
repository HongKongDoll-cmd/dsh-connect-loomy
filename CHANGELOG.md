# Changelog

All notable changes to `dsh-connect-loomy` will be documented in this file.

## [0.2.1] - 2026-11-27

### Fixed
- Guard against Loomy upstream `400 UPSTREAM_ERROR` (`请求有误，请重试；若多次出现请更新应用版本`) by omitting sub-56x56px images (such as 32x32 icons in tool/session history), sanitizing empty `content` messages and empty `tool_calls` arguments, and adding a bounded single-shot image-stripped retry if Loomy still rejects an image-bearing payload with generic 400.
- Surface oversized (> 3.5 MB) generic 400 rejections as HTTP 413 (`request_too_large`) so DSH can trigger automatic compaction instead of repeating the error.
- Strip cross-provider unsigned `thinking` blocks in `Context` (and all historical `thinking` / `reasoning_content` when `dropAllThinking` compatibility mode is enabled), and send `loomy-version: 0.9.39` header.

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
