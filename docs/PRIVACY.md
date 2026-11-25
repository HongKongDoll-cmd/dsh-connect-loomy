# Privacy & Credential Handling

`dsh-connect-loomy` treats Loomy account sessions and phone numbers as strictly local secrets.

## What Data Is Stored Locally

- **Credential vault (`$DSH_HOME/loomy-vault/accounts.json`, mode `0600`)**: stores signed-in Loomy session tokens, user IDs, optional nicknames, and masked phone numbers (`138****0000`).
- **Local plugin settings (`$DSH_HOME/loomy-vault/settings.json`)**: stores user preferences (`enabled`, `baseUrl`, enabled model IDs, vision overrides, thinking effort overrides, `sidebarPanelEnabled`, `dropAllThinking`, `autoSwitchAccount`, `pollIntervalMs`).
- **Auto-discovered desktop sessions**: reads existing Loomy Desktop local data (`auth-session.json` or Chromium `Local Storage` LevelDB) only on the local machine when resolving credentials.

## What Never Leaves Your Machine

- Session tokens, unmasked phone numbers, and user IDs are **never** sent to browser client code (`/plugins/dsh-connect-loomy/usage` only returns masked phone numbers and obfuscated account IDs), **never** written to DSH `cordis.patch.yml`, and **never** logged in plaintext.
- No analytics, telemetry, crash reporting, or third-party tracking servers are contacted.

## Network Endpoints Contacted

1. **Loomy Official / User-Configured Gateway** (`https://loomyad.xunfei.cn/api/v1` by default):
   - `/models`, `/points/records`, `/user/identity`, `/team-points/balance`, `/points/redemption-codes/redeem`, `/chat/completions`.
2. **iFlyTek CAccount & WeChat Open Platform** (only when the user initiates WeChat QR or SMS sign-in):
   - `https://account.xfinfr.com`
   - `https://open.weixin.qq.com` & `https://lp.open.weixin.qq.com`
3. **Loopback Localhost (`127.0.0.1`) Only**:
   - The embedded OpenAI-compatible HTTP shim binds exclusively to `127.0.0.1` and requires a random per-process bearer secret.
