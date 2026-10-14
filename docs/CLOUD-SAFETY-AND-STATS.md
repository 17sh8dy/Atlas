# Cloud safety, credential handling and Atlas Stats

Status: **built and verified in the real app, 2026-10-14, `atlas-2.0`** (local commits only).
Companion to `SECURITY-HARDENING-2.0.md`.

## 1. Cloud safety — what existed, what was missing, what is there now

**Before.** Atlas had no protection around a paid model provider. The web-search backends already
recognised a spent allowance (`quota:` tags in the search manager), but for *model* providers a
429 was reported as "rate limited — try again in a moment" whether it meant "slow down" or "your
account is out of money"; a 402 or a billing 400 was shown as a raw provider message; and in
ordinary conversation the failure was swallowed entirely (Atlas answered with its own small-talk
and the next message hit the paid provider again). Nothing counted spend, nothing capped it, and
a loop could send requests as fast as the model answered.

**Now** (`cloud_safety.rs`, `cloud-limits.ts`, `CloudProviders.tsx`):

| | |
|---|---|
| Provider says it is out of money | recognised from the status (402) and each provider's own wording (`insufficient_quota`, `billing_hard_limit_reached`, "credit balance is too low", "reached your specified API usage limits", Gemini daily/billing quota…). The provider is **paused natively**: every later request is refused without being sent until you resume it. |
| Plain rate limit | told apart: reported as a rate limit, nothing paused. |
| Atlas's own caps | per provider, monthly **requests** and/or **tokens** (provider-reported where it says, otherwise ≈ 4 characters a token and labelled an estimate), counted against the same totals the Stats page shows. Enforced before the request. |
| Runaway guard | more than 30 requests to one provider in a minute pauses it for five minutes: a loop, not a conversation. |
| Never another provider | nothing in the path selects or asks a different provider; tested (the other paid provider and the local model are not asked, and the selection is not changed). |
| What you see | in the chat, always (even for small talk): `⚠️ Cloud AI Limit Reached — Your <provider> account has reached its spending limit. Atlas has paused requests to this provider. You can switch to a local model or manage your limits through your provider.` Atlas's own caps and the loop guard have their own wording. In Settings → Intelligence the card shows the paused state with **Resume**, this month's requests and tokens, and the two limit fields. |
| Resuming and loosening | **Resume**, raising a cap and removing a cap each ask in a native Windows box, because each makes spending possible again. Lowering a cap or setting a first one asks nothing. |

Provider differences, as the request put it: OpenAI hard limits can lag, Claude caps stop
requests when reached. Atlas does not depend on either: its own caps and the loop guard act
before the provider does, and a provider's refusal is honoured the moment it arrives.

## 2. Where credentials can be

Audited: Rust (`println!`, `eprintln!`, the diagnostics file, error strings), TypeScript
(`console.*`, persisted transcript, memory, clipboard history), storage keys, and the repository.

| Found | Fix |
|---|---|
| Provider and search keys | already only in Windows Credential Manager (`secrets.rs`); read natively for one request; never returned to the webview. Unchanged. |
| **Nova sign-in session in `storage.json`, in plain text** | moved to Credential Manager (`Atlas:account:session`). Adopted at startup (a copy left in the file is moved and removed); `account_session_*` commands for the account client. |
| Diagnostics file (`%TEMP%\atlas-diagnostics.log`) accepted any text, up to 2,000 characters from the page | `redact.rs`: key-shaped tokens, bearer headers, `name=value` secrets and long random tokens are replaced with `[key hidden]` before writing and again when read back. |
| Provider error text could echo a rejected key | the same redaction on everything `ask_cloud_provider` returns. |
| A key pasted into the chat was saved in the conversation history; "remember this" notes kept it | `redactSecrets` (core) is applied to the persisted transcript and to remembered notes. The message is still shown to you; it is not kept on disk. |
| Clipboard history | already refused anything that looks like a secret (`looksSensitive`); unchanged. |
| Repository | no key-shaped strings outside test fixtures. |

Redaction is eager and token-based: ordinary words, Windows paths, URLs and SHA-256 digests are
left alone (tested). It is a safety net behind "keys live in Credential Manager", not a
replacement for it.

**Compatibility note.** Moving the session out of `storage.json` signs an *older* Atlas that
shares the same data folder out until it signs in again; the account is optional and sign-in is
one device code.

## 3. Atlas Stats

"Your activity. Your statistics. Your device." — a **Stats** tab in Settings.

- **Stored** in `%APPDATA%\dev.atlas.assistant\stats\stats.json`: daily totals per metric, one
  small file (a year is a few hundred rows). Chosen over SQLite deliberately: no new dependency
  (installer size), trivially inspectable, and period queries are sums over day buckets. Written
  atomically every 15 seconds and on quit, with a backup copy at most every ten minutes and a
  fall-back to it if the file is damaged.
- **Local only.** No network code in the module, no account, no setting that adds either. It does
  not read the Nova session or the installed version (a test tripwire enforces it). It is not
  touched by signing in or out, changing or deleting an account, or updating: an update replaces
  the program, and the folder lives outside the install folder. Only "Reset statistics" (a native
  question) or deleting Atlas's data folder clears it.
- **Counts, not content.** Never prompts, files, searches or paths. The page may record only a
  closed list of metric names; anything else is refused.
- **Real.** Counted where it happens: the native side counts model requests (local, cloud per
  provider, Nova), tokens (provider-reported or estimated, labelled), web searches and fetches,
  voice, confirmation questions and how they were answered, emergency stops, launches and minutes
  open. The interface reports only what it alone sees: actions done / failed / declined / stopped
  (by area), tasks completed / failed / cancelled, who answered a message.
- **Periods**: Lifetime, Today, Yesterday, Last 7 days, Last 30 days, This month, This year, Last
  year (the page remembers the last one). Each is an exact sum over its own days (boundary tested).
  A bar chart shows activity per day (per month for long periods).
- The page says, in the interface, the honest caveat: a cloud request still goes to the provider
  you chose; keeping the *statistics* local does not make those requests private from it.

Verified in the real app: counts accumulate across a session, appear on the page for Lifetime /
Today / Last year, are in the file with no content, survive a restart (launches 1 → 2), and the
page cannot invent a metric.
