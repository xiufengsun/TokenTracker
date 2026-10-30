# Doubao subscription quota

TokenTracker reads Doubao's (豆包) subscription credit windows by reusing the
login session the Doubao desktop app already stores locally. Doubao is a
**limits-only** provider: neither its local stores nor its quota APIs expose any
token-level accounting (no input/output token fields exist anywhere in the local
bundles or responses), so nothing is added to token ingestion. Issue #826.

## Data sources

- Cookie store: `~/Library/Application Support/Doubao/{Default,Profile *}/Cookies`
  (SQLite). Doubao may be running while it is read — the file is copied to a
  temp dir first and opened read-only. `DOUBAO_HOME` overrides the data
  directory. When several profiles hold `.doubao.com` session cookies, the
  profile with the most recently used session cookie wins.
- Keychain: the generic-password item **"Doubao Safe Storage"** (account
  `"Doubao"`). The first read on a new machine pops one macOS authorization
  prompt; choosing "Always Allow" silences later reads.
- Endpoints (POST `https://www.doubao.com`, cookie auth only, no CSRF header):
  - `/alice/commerce/sale/subscription/quota/summary/` with `{"product_line":""}`
    — plan name (`current_subscription.display.product_name`) and
    `window_limit_section`.
  - `/alice/commerce/sale/entitlement/usage_detail/` with `{}`
    — `total_used_percent` and `window_limit_groups`.
- An expired session is reported as HTTP 200 with `code 710012001`
  ("登录已过期"), not as a 401; TokenTracker surfaces it as a re-auth hint.
- Env precedence: `DOUBAO_COOKIE` (a manual cookie header) wins over local
  decryption, mirroring Qoder's `QODER_COOKIE`.

## Cookie decryption format

The cookie values use a layout that is **not** the standard Chromium `v10` —
copying the well-known open-source Chromium decryptors produces garbage. The
verified layout (Doubao 2.33.5, macOS 27.2) is:

```
"v10" (3 bytes) | 16-byte header (purpose unknown) | 16-byte IV | AES-128-CBC
key = PBKDF2(keychainSecret, "saltysalt", 1003 iterations, 16 bytes, SHA1)
padding = PKCS7
```

## Window semantics

Subscription usage is counted in **credits** across three rolling windows:

- 5-hour rolling window (`primary_window`)
- 7-day rolling window (`secondary_window`)
- plan-month consumption (`tertiary_window`)

The three-window model is confirmed by Doubao's own UI strings
(`doubao_member_manage_quota_usage_{5h,7d,1m}_abs` = "已用 {used_quota}/{total_quota}").
Creation-packs (Seedream/Seedance credits) sit outside the 5h/7d windows and are
not reported.

**Paid-account caveat:** the observations above come from a free account, whose
`window_limit_section` / `window_limit_groups` are empty arrays. The exact field
names inside a populated window group have not been observed yet, so the parser
is deliberately lenient (candidate field spellings, `used/total` → percentage,
several reset-timestamp fields, one nested wrapper level) and degrades unknown
shapes to a missing window instead of an invented bar. Free accounts therefore
render no rows at all (and no plan label) rather than fake 0% bars — the same
treatment as Qoder's empty 0/0 buckets. A paid-account sample is needed to pin
the precise mapping.

## Privacy

Decrypted cookie values live in memory only and are sent solely to Doubao's
quota endpoints. They are never written to disk, logs, or caches — the limits
cache (`~/.tokentracker/tracker/doubao-usage-limits-cache.json`, mode 0600)
stores derived quota windows only. No prompt or response content is involved.

## Verification (2026-10-29, free account, macOS 27.2 / Doubao 2.33.5)

- 26 `.doubao.com` cookies decrypted successfully with the layout above
  (standard v10 without the 16-byte header fails — the header is required).
- `get_account_info` returned the real account; subscription entry config
  returned `subs_status: "free"`, `has_active_subscription: false`.
- `quota/summary` with an empty `product_line` returned the fullest payload
  (a non-empty value returned fewer fields); `usage_detail` returned
  `{total_used_percent, window_limit_groups}` with empty groups on free.
- `rate_limit` (`{is_limit, limit_time, limit_tips}`) exists as the free-tier
  throttle signal but is not currently polled.
