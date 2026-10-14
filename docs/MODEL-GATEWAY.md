# The model gateway (Phase D)

Status: **built and verified in the real app, 2026-10-14, `atlas-2.0`** (local commits only).

The gateway is how Atlas gets a *plan* out of a connected model when its own grammar cannot read an
instruction. It is deliberately small, and deliberately not a new door: it returns validated steps
or nothing, and everything after that is what a plan has always gone through (the executor, the
execution mode, the confirmation cards, the content policy, F8).

## What it does

1. **Route.** From the model's capabilities (`provider-capabilities.ts`) — and only from what is
   positively known — it picks `tools` (native tool calling), `schema` (a reply held to a JSON
   Schema) or `text` (the plain catalog-in-the-prompt path every model can follow). Unknown is
   "no". The server's own report is read first (cached by the provider, bounded to 4 s); this
   was found by driving the real app, where the first plan after launch had only the declared
   descriptor and used the plain path.
2. **Tools, at most 20.** The deterministic BM25 router picks the skills worth offering for the
   request. A discovery tool (`find_capabilities`) lets a model say "none of these fit"; Atlas
   answers it once, from the router, with a new list. It cannot loop.
3. **Read whatever comes back.** Tool calls, or JSON in text however the model wrapped it.
4. **Validate every step** with the registry's own rules; one bad step invalidates the plan. Text
   the user put in quotes must appear in the plan exactly.
5. **Repair and re-ask — once.** An unusable reply gets one correction that says exactly what was
   wrong. A second failure is not retried: the caller falls to its normal ask-or-clarify path.
   Nothing is ever retried *into an action*: the only product of a retry is another reply.
6. **Step down.** A server or model that refuses tools or a schema (`unsupported:constraints`) is
   asked again one route lower, without that counting as a failed attempt.

## What it deliberately cannot do

- Run anything, pick a provider, change a mode, or widen what a plan may contain. It imports only
  types, the router and the tool-call reader; `gateway-no-new-door.test.ts` fails the build if it
  names the executor, the registry class, the platform, storage or confirmation.
- Send more than a plan request already sent: the same user words and the same skill descriptions,
  never memory, files or system details. The text route's prompt is byte-for-byte what it was.
- Choose another *paid* provider. The only routing input beyond capabilities is a setting that can
  only make Atlas ask less: **Let a cloud model plan actions** (Settings → Intelligence, default on
  as before). Off keeps a cloud model to conversation; a local model is unaffected.

## The plumbing

| | |
|---|---|
| Port | `ask(prompt, handlers, { tools, responseSchema })`, `handlers.onToolCalls`. Providers that cannot honour them ignore the fields. |
| Ollama | `tools` and `format` added to `/api/chat`; tool calls arrive on their own event channel (never mixed with words); a 400 on a constrained request is `unsupported:constraints`; `local_model_info` also returns the server version (JSON-schema output is enforced from 0.5.0). |
| Cloud | OpenAI-compatible (`tools`, `tool_choice`, `response_format: json_schema`) and Anthropic (`tools`, `tool_use` blocks); Gemini stays text. Declared only where the wire format guarantees it: Anthropic, and OpenAI's own host. A custom "OpenAI-compatible" address stays unknown. |
| Bounds | the page may offer at most 40 tools / 120 KB / a 40 KB schema; names are `[A-Za-z0-9_-]{1,64}`; checked natively. |
| Evidence | `gateway:plan` event → diagnostics line `route=tools asks=1 result=plan steps=1` (counts only). |

## Evaluation

`test/gateway-eval.test.ts`:

- **Behaviours (always runs):** 11 ways a model misbehaves × 6 requests = 66 cases. Recoverable
  ones recover within one correction; unrecoverable ones return nothing; no case ever returns a step
  outside the catalog or one that did not validate; never more than two asks.
- **A real server (opt-in):** `ATLAS_LIVE_OLLAMA=http://127.0.0.1:11434 ATLAS_LIVE_MODEL=<tag>`.
  On `qwen3.5:9b` here: **tools 6/6 in 6 asks; text 5/6 in 9 asks; schema 5/6 in 9 asks** — tool
  calling was both more accurate and needed no corrections.

## Verified in the real application

Release build, real Ollama 0.40.1 server, `qwen3.5:9b`, every cloud provider disabled for the run:
the server's `tools` capability was read, the model was chosen in the real Settings page, an
instruction the grammar does not read was typed, and the diagnostics recorded
`route=tools asks=1 result=plan steps=1`; the plan ran through the executor and answered
"🔊 Volume 30%." (volume restored afterwards). Nothing went to a cloud provider.

## Not done, on purpose

- Gemini function calling (text only until a model is measured).
- Retrieval (Phase E) and a multi-provider router: the only router is "which route for the one
  model you chose", because switching providers on someone's behalf is how money gets spent.
- A per-model measured capability override in Settings: the descriptor is declared or reported,
  never inferred from a model's name.
