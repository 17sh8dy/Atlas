# Atlas 2.0.5 — "Hands-free Atlas" — Plan

Status: **PLAN ONLY. No code written.** Awaiting Brandon's approval. Baseline: 2.0.3 (main 787d1e4).
Written 2026-10-24 from Brandon's "Project JARVIS" checklist, scoped by Brandon the same day.
Branch `atlas-2.0.5` (local, unpushed). **No push / release without his word.**

## Scope (decided by Brandon)

| Checklist section | Decision |
|---|---|
| 1 Real-time voice assistant | **IN** (opt-in wake word, clap, modes, conversation). Cloud "Advanced Voice" speech-to-speech = LATER |
| 2 Custom voices and personalities | **IN** |
| 3 Desktop control | **IN, as audit + gap-fill** (most exists) |
| 4 AI model integration | **Almost nothing new** — already built. Only a regression test that voice/personality/sketch work on every provider |
| 5 Image generation | **Only a small start: code-drawn sketches** (the model writes SVG). Real image generators = LATER |
| 6 Background assistant | **IN** (tray exists; add startup, stay-resident, modes, quiet hours) |
| 7 Advanced agent capabilities | **LATER update.** Only the existing agent is wired to voice |
| 8 Task memory / resume | **IN, narrow:** resume by voice/chat on the existing tasks system |
| 9 Security and privacy | **IN** (it is the price of an open microphone) |
| 10-12 Architecture, testing, release | Followed. Additive only; no removals |

## Honest limits (read first)

- **The microphone rule changes.** Today `listen.rs` says "there is no always-on microphone in this process." A wake word or clap listener reverses that. So: **OFF by default, explicit opt-in, visible indicator, one switch to kill it, NovaLegal privacy text updated before release** (ask before writing/pushing it).
- **Custom wake words are not free text.** A small on-device detector needs a trained model per word. Plan: ship "Hey Atlas" (and one more if a free model exists); for any typed name, an *optional* slower mode that transcribes short chunks with the existing whisper and matches text (more CPU, more false triggers, labelled as such). **No account-based engines (Porcupine).**
- **Barge-in (interrupting Atlas) and not hearing itself** cannot be proven without Brandon's mic and speakers. Design: mute the wake listener while Atlas speaks, duck/stop speech on detected voice, rely on the webview's echo cancellation. Headphones will work much better than speakers. Verified only by Brandon trying it.
- **Local conversation speed.** Speech→text→model→speech on this CPU with a 9B model is slow. Sentence-by-sentence streaming makes it feel faster but cannot fix the model's own speed. A small/fast model or a cloud model is the honest answer, and the Voice settings say so.
- **Clap detection needs tuning on a real room.** Thresholds are settings; false-positive rate is measured by Brandon.
- Full-screen games keep their existing limitation.

## Workstreams, in build order

### V1. Activation (the listener)
- **Where it lives:** the webview owns the microphone (as today); Rust still never starts listening. A new `voice/activation` module in the web layer runs a lightweight detector on a mic stream. All detection is local, nothing is recorded or stored while idle (a rolling ~2 s ring buffer in memory only, discarded).
- Detectors: `clap` (onset energy + sharpness, double-clap window configurable), `wakeword` (on-device model, "Hey Atlas"), `wakeword-text` (optional, whisper-chunk match for custom names). Any combination: clap-only, wake-only, clap+wake, both-as-either.
- Anti-false-trigger: sensitivity setting, cooldown, refusal while Atlas is speaking, optional "confirm with a short chime".
- **Mic indicator:** a persistent, truthful indicator in the title bar and tray tooltip: *Listening for wake word / Mic off / Recording*. Windows' own mic-in-use indicator also shows. State comes from the real stream, not a flag.
- Modes: Standard, Push-to-Talk (existing), Wake-Word, Clap, Microphone Disabled. Stored in settings; default stays what 2.0.3 does today.

### V2. Conversation
- After activation: capture until the speaker stops (VAD with configurable silence timeout, default 2 s). Command spoken with the wake word ("Hey Atlas, open Spotify") is processed immediately; wake word alone → one short activation reply ("Yes, I'm here."), never repeated in a loop.
- Continuous conversation: stays open for follow-ups, no wake word needed during an active conversation, returns to standby after a configurable idle period or on "that's all"/"thanks". Context kept by the existing conversation memory.
- Barge-in: voice detected while speaking → stop playback at once (the halt path already exists), listen, treat as a correction or new command.
- Streaming pipeline: model reply is split into sentences and spoken as each completes (Piper/Kokoro already synthesise fast; playback is chunked). No new cloud dependency.
- Changing mind mid-command ("open Spotify—no, Chrome"): last clear instruction wins; ambiguous → one clarifying question. Reuses the existing question-gate.

### V3. Voices and personalities
- Voice picker with preview, speed (and pitch only where the engine supports it), all existing voices and Kokoro preserved. Changing voice never changes the model.
- **Personality = settings, not prompt hacking:** presets (Formal "sir", Casual, Humorous, Sarcastic, Custom), "how Atlas addresses you", custom greeting, custom confirmation lines per action class. Confirmations and activation lines are **fixed templates** (instant, offline, no tokens); the model's tone is influenced by a short style instruction only for open conversation.
- Personality can never loosen safety: permissions, confirmations and verification text are unaffected (a test asserts that).

### V4. Background and presence
- Tray exists. Add: *Launch at Windows startup* (opt-in, setting + real verification that the Run key is written), *stay resident when the window is closed* (opt-in), *Quit* fully quits (stops mic).
- Modes: Active / Background / Presence / Privacy (Privacy = no listener, no proactive speech). Quick switch from the tray menu. Saved.
- Idle cost target: no mic stream, no timers faster than needed when Mic Disabled; with wake word on, CPU stays low (measured and published, not assumed).
- Proactive speech: only the **existing reminders/alarms/watches** may speak, with **quiet hours** and an "unsolicited speech" off switch. "Your stream starts in 15 minutes, prepare OBS?" is a LATER item (needs a calendar source).

### V5. Desktop control — audit and gap-fill
- Audit table of every item in checklist §3 against the skill registry: Exists / Partial / Missing, with the test that proves each. Close the gaps that are small: window move/resize/maximize/minimize by name, app nicknames ("my music app"), clarifying questions for ambiguous apps.
- Media: pause/resume/skip/volume/mute via media keys (no login). **Playing a named Spotify playlist** needs the Spotify Web API (credentials) — not in 2.0.5 unless Brandon supplies a path; `spotify:` links the user pastes are supported.
- Every phrasing variant from the checklist ("launch / bring up / start the … app") gets a corpus test routing to one action (existing standing rule: the AI tier is never the only route).

### V6. Resume by voice
- "Continue that project from yesterday" → lists unfinished tasks from the existing task store, offers the last checkpoint, **asks before resuming**. Distinguishes remembered plan vs actually completed steps (the store already separates them; the reply must say which).

### V7. Sketches (the small image start)
- "Draw me a house / a logo / a flowchart" → the connected model writes **SVG**; Atlas validates, sanitises and shows it in the chat with **Save as SVG/PNG**.
- **Always shown with a note:** *"Drawn by your connected model as code. How good it looks depends on the model."* No image-generation model, no new download, no extra network (a cloud model's normal request only).
- Safety: SVG is untrusted model output. Strip `<script>`, event handlers, `<foreignObject>`, external references and `data:`/`javascript:` URLs; size cap; render only as an `<img>` of a sanitised data URL, never inline in the page. Tests with hostile SVG.
- No model connected → plain honest message, no fake drawing. Failure (invalid SVG) → one retry with the error, then say so.
- Out of scope: photo-style images, local Stable Diffusion, provider image APIs, image editing. They are the later "Image Engine".

### V8. Security and privacy
- Wake/clap detection local; no raw audio stored; voice history retention setting (default: transcripts follow the existing chat history, **no audio kept**).
- Settings text states exactly when audio leaves the PC (only if a *cloud* speech feature is ever added; none in 2.0.5, so: "never").
- Same safety rules for any model; spoken commands pass the same authorization as typed ones. A spoken instruction found in *content* (a web page read aloud, a file) is still data, not a command.
- NovaLegal: Atlas privacy/terms need a section on the optional listener. **Ask before writing or deploying.**

## Not in 2.0.5 (kept as later)
Cloud "Advanced Voice" speech-to-speech; real image generation (local or provider); Spotify Web API playlists; proactive calendar prompts ("prepare OBS"); anything in checklist §7 beyond wiring the existing agent to voice; expanding skill coverage beyond today's.

## Tests
- Unit: clap onset/double-clap windows (recorded fixtures, not live mic), VAD silence timeout, mode state machine, personality templates (no safety text changed), SVG sanitiser (hostile corpus), phrasing corpus for desktop actions, resume reply wording.
- Engine: voice-originated and typed requests produce identical plans and identical confirmations.
- Regression: the whole existing suite; settings/voice from 2.0.3 unchanged by default.
- **Real app (Brandon needed):** wake word and clap in his room, false-trigger rate over a normal hour, speakers vs headphones barge-in, startup entry, tray quit stops the mic, idle CPU number. I drive what can be driven (settings, tray, sketches); anything needing a real voice or clap is handed to him with exact steps.

## Release rules
Additive only: no tool, command, setting or voice removed; defaults unchanged (listener off). Full typecheck/lint/Rust/engine tests, fresh-install and upgrade check, release notes, known limits documented. **No push or release until Brandon says.**

## Decisions made by Brandon (2026-10-24) — revision 2

1. **Wake word: BOTH.** "Hey Atlas" is the default (dedicated lightweight detector). A user may also enter a custom assistant name (e.g. JARVIS) handled by a local approach. Both offline. The Voice settings must state the difference plainly (dedicated = low CPU, fewer false triggers; custom name = more CPU, more false triggers or slower).
2. **Background: YES, all opt-in, all default OFF, each separate:** Launch at Windows startup · Keep running in the tray when the window is closed · Background microphone listening. The mic indicator is always visible while any listener is live, and one control turns it off immediately.
3. **Spotify: WAIT.** Keep today's basic media controls. Named playlists and shuffle via the Spotify API are a later update.
4. **Engine: RESEARCH FIRST.** Findings below. **No dependency is added, nothing installed, no code written, nothing committed, pushed or deployed until Brandon approves.**

## Wake-word engine research (2026-10-24; sources: each project's README/LICENSE)

| | Licence (code) | Licence (shipped models / data) | Custom word | Windows | CPU / accuracy | Verdict |
|---|---|---|---|---|---|---|
| **openWakeWord** | Apache-2.0 | **Pre-trained models are CC BY-NC-SA 4.0 (non-commercial, share-alike)**. Atlas has a paid-tier preview, so shipping them is a risk | Train a small classifier on synthetic TTS clips ("several thousand" recommended) + large negative set. Colab <1 h. Not "say it 5 times" | Python + onnxruntime only (no tflite on Windows). Needs an ONNX runtime in Atlas (Rust `ort` or onnxruntime-web in the webview) plus its mel/embedding front-end models | Very light (README: 15-20 models on one Raspberry Pi 3 core); best published accuracy of the open options | Strong technically; licence of models and of the negative training data must be cleared. We would need to train our own "Hey Atlas" model, and that must use only data we may use commercially |
| **microWakeWord** | Apache-2.0 | Model licence not found in repo | Synthetic (Piper) + notebook; README calls it an early release for advanced users | Not mentioned; targets TFLite-Micro (ESP32) | Tiny and fast on MCUs | Not a fit for a Windows desktop. Rejected |
| **Rustpotter** | Apache-2.0 | None shipped; you make your own | **Yes, from 3-8 recordings of the word** (DTW "reference"), or train a model from a bigger set. A browser demo exists | Pure Rust crate (fits Atlas's Rust core); Windows support of the crate not stated in README, to be proven in the spike. No tagged releases; maintenance cadence unclear | Light. Reference mode is less accurate than a trained model (README says so) | Best fit for **custom names**, because the user records the name; weaker for "Hey Atlas" accuracy |
| **Picovoice Porcupine** | Proprietary | n/a | Yes | Yes | Good | **Rejected:** needs an AccessKey (account) even offline, and community reports say the free tier ended June 30 2026 |
| **Whisper text match** (already in Atlas) | MIT | n/a | **Any typed name, no training** | Already shipped | Heaviest: transcribes short chunks continuously; slower to react; more false triggers | Fallback for custom names; also the "no new dependency" option |
| Vosk | Apache-2.0 | n/a | Grammar-limited keyword mode | Yes | Heavier than a dedicated spotter | Not needed since whisper exists |

**Recommendation (to be confirmed by a short spike on Brandon's own recordings, see order step 0):**
- **"Hey Atlas" default → a dedicated detector.** Preferred: **our own-trained openWakeWord model** if the training-data licence is clean; fallback: a **Rustpotter trained model**. Do not ship openWakeWord's CC BY-NC-SA pre-trained models.
- **Custom names → Rustpotter references** (user records the name 3-8 times in a short in-app wizard; nothing to train, runs locally, light) **with the whisper text match kept as the zero-setup option** the settings can offer ("quick, uses more CPU").
- Net: at most **one** new Rust dependency (Rustpotter), plus an ONNX runtime only if openWakeWord wins the spike. Both options are Apache-2.0. The settings page labels each mode with its real cost.

## Voice state machine (applies to wake word, clap, push-to-talk alike)

```
DISABLED ──enable──▶ STANDBY ──trigger──▶ ACTIVATED ──▶ LISTENING ──utterance ended──▶ PROCESSING ──▶ SPEAKING ──▶ STANDBY
                        ▲                      │              ▲                              │             │
                        │                      └─ 2 s of no command ─ prompt once ──────────┘             │
                        │                                     └──────────── barge-in (voice while SPEAKING) ┘
                        └────────── idle timeout / "that's all" / error ──────────────────────────────────────
```

| State | Mic | What runs | Indicator |
|---|---|---|---|
| **DISABLED** | closed | nothing (Privacy mode, mic-off mode, permission lost, tray Quit) | "Mic off" |
| **STANDBY** | open only if background listening is ON | trigger detector only; rolling ~2 s buffer in memory, never stored | "Listening for wake word / clap" |
| **ACTIVATED** | open | trigger just fired; chime/visual; pre-roll audio kept so "Hey Atlas, open Spotify" keeps the command | "Activated" |
| **LISTENING** | open | VAD capture; silence timeout (default 2 s, setting) | "Recording" |
| **PROCESSING** | open or closed (setting) | local transcription → engine → plan; spoken answers never include private data not already in the reply | "Thinking" |
| **SPEAKING** | open (echo-cancelled) for barge-in, listener muted for the wake word | TTS, sentence by sentence | "Speaking" |

Transitions that matter:
- **Any state → DISABLED** immediately on the kill switch (tray menu, indicator click, hotkey, Privacy mode). Stops the stream tracks, which also ends Windows' own mic indicator.
- **ACTIVATED → LISTENING** immediately if speech follows. **If no command follows within the silence timeout (2 s), say the activation line once** ("Yes, I'm here. What do you need?") and keep LISTENING for a longer window; if still nothing, go quietly to STANDBY. It is never asked twice in a row, and never when a command came with the wake word.
- **SPEAKING → LISTENING (barge-in):** playback stops at once via the existing halt path, the interrupted reply is not resumed, and what the user says is taken as a correction or a new request.
- **PROCESSING → LISTENING (changed mind):** allowed only before any action ran; an action in flight is never silently abandoned (it follows the existing cancel path).
- **Conversation window:** after SPEAKING, the machine returns to LISTENING (no wake word needed) until an idle timeout, "that's all/thanks", or an error, then STANDBY.
- **Voice never approves a consequential action.** Dangerous and destructive confirmations still use the native Windows consent boxes, which a voice or a webview cannot answer (existing rule). Spoken "yes" is accepted only for low-risk follow-up questions.
- Push-to-talk and clap enter the machine at ACTIVATED exactly like the wake word, so there is one flow to test.
- The machine is a pure TypeScript reducer (state, event → state, effects) with a transition table test: every illegal transition is rejected, and every state has a path to DISABLED.

## Messages: personality is kept apart from security

Two separate catalogs, in separate files, with no shared keys:
- **Personality messages** (customisable): activation line, greeting, acknowledgements ("Certainly, sir" / "Got it!"), how Atlas addresses you, farewell/standby lines, tone of open conversation.
- **System messages** (NOT customisable, code-fixed, never routed through a model or a personality template): permission and consent prompts, what an action will do, confirmations of consequential actions, verification results ("done" / "not done"), error causes, mic and privacy status, limit/cost notices.
- Tests: the two catalogs share no key; every preset renders byte-identical system messages; a personality string can never be inserted into a system message; the "user-defined" greeting is escaped and length-capped so it cannot imitate a system prompt (e.g. cannot start with a consent-looking line). A spoken reply may contain both, but the system part is appended by code after the personality part.

## Updated implementation order (for approval)

0. **Spike (needs your OK to install in a throwaway folder, no change to Atlas):** record "Hey Atlas" and one custom name; compare Rustpotter (reference and trained), openWakeWord with a self-trained model, and whisper text match for accept rate, false triggers per hour of normal noise/TV, CPU, and Windows compatibility. Output: a report, then you choose.
1. **State machine + voice settings model + mic indicator** (pure TS, tested). Push-to-talk rewired through it with no behaviour change.
2. **Message catalogs** (personality vs system) + presets + settings UI + previews.
3. **Clap / double-clap detector** (pure DSP, no dependency) entering via the machine.
4. **Conversation layer:** VAD timeout setting, one-time activation prompt, follow-up window, barge-in, sentence-streamed speech, self-hearing guard.
5. **Background:** tray menu, opt-in startup entry, opt-in stay-resident, modes, quiet hours, separate background-listening switch, kill switch.
6. **Wake word** (engine per the spike): "Hey Atlas" + custom-name wizard + labelled performance trade-offs.
7. **Desktop-control audit and gap-fill; resume by voice.**
8. **Code sketches (SVG)** with the sanitiser and the "depends on the connected model" note.
9. **Privacy text (ask first), docs, release notes, full tests, real-app passes** (the parts needing your voice are handed to you with exact steps).
Rationale: the state machine and settings come first because everything hangs off them; the clap detector needs no dependency so it proves the whole path early; the wake word is last because it is the riskiest and the only one gated on a dependency decision.

## Remaining technical decisions
1. **Which wake-word engine and training route** (spike result): own-trained openWakeWord vs Rustpotter for "Hey Atlas"; and whether the negative-training data we use is licensed for commercial use. Needs your OK to run the spike.
2. **Where the detector runs.** The webview owns the mic and cannot run Rustpotter (Rust). Option A: stream 16 kHz frames from the webview to a Rust command that returns only "triggered" (frames discarded; Rust still cannot open the mic itself). Option B: an ONNX model running in the webview (onnxruntime-web). A adds a continuous audio feed into Rust, which changes the "Rust never hears audio unless handed an utterance" wording in `listen.rs` and the privacy text; B keeps it in the webview.
3. **Default sensitivities** for clap and wake word (measured on your mic; you tune).
4. **Whether PROCESSING keeps the mic open** (needed for "changed my mind") or closes it (lower privacy footprint). Recommendation: open only inside an active conversation.
5. **Voice-approved confirmations:** I recommend none for consequential actions (above); confirm.
6. **Private-folder knowledge** (was 2.0.4): not in this plan. Still next, later, or dropped?

## Decisions made by Brandon (2026-10-24) — revision 3

1. **Engine spike: YES, with restrictions** (restrictions below are mine; Brandon to amend).
2. **Detection runs in Rust** (option A). Consequences, all to be written down before the feature ships: the webview still owns the mic and sends 16 kHz frames to one Rust command; Rust returns only "triggered" and discards frames; Rust still cannot open the microphone itself; frames are never written to disk or logged; `listen.rs` doc wording and the NovaLegal privacy text are updated (ask before writing/deploying the legal text); the frame feed starts only while STANDBY is enabled and stops on the kill switch.
3. **Mic stays open during PROCESSING inside an active conversation only;** closed otherwise.
4. **No consequential approvals by voice.** Native consent boxes only.
5. **Knowledge: use the 2.0.3 three-layer design as is** (see "Knowledge" below). Not a 2.0.5 workstream.

### Spike restrictions
- Throwaway folder **on D:** (e.g. `D:\Dev\_wakeword-spike`), never inside the Atlas repo, never on C: (pip/cargo caches pointed at D: too). Deleted when the report is done.
- Nothing added to Atlas: no `Cargo.toml`/`package.json` change, no commit. Atlas is untouched.
- Only the engines in the research table; pinned versions; licence of each package and of any model/data file recorded before use; no pre-trained CC BY-NC-SA model used in anything but measurement.
- Offline after download. No cloud speech service, no account, no upload of Brandon's recordings. Recordings stay in the spike folder and are deleted afterwards unless Brandon says keep.
- Measured: accept rate for "Hey Atlas" and one custom name, false triggers per hour on ordinary room noise/speech/TV (Brandon supplies the audio or a recorded hour), CPU %, memory, Windows compatibility, effort to train/record.
- Output: a report in `docs/WAKEWORD-SPIKE.md`; Brandon chooses the engine. Nothing else follows from the spike automatically.

### Knowledge (Brandon's item 5) — what already exists from 2.0.3
Atlas already answers from three layers, built and released in 2.0.3:
1. **Built-in public knowledge** that ships in the installer (signed pack), works offline.
2. **The Nova-Knowledge GitHub repo** (github.com/17sh8dy/Nova-Knowledge): curated pages Brandon is finishing. Once pages are approved and the pack is published, installed copies refresh it daily from a signed release. Nothing in the repo is trusted unless it is in a pack signed with Brandon's key.
3. **Live lookups of Nova's public pages**, from a fixed list compiled into Atlas (never a URL taken from a page): nova-legal, nova-help, atlas-website, nova-780.pages.dev, replay-gg-site, nova-review, nova-cut-site, plus the GitHub latest-release pages for Atlas, Replay.GG and Nova Cut. Answers name their source and when it was read.
For 2.0.5 the only knowledge tasks are (a) voice answers must use the same tier (a spoken question gets the same cited answer, source spoken briefly and shown in full on screen), (b) check a successful live read online once, (c) publish the pack after Brandon finishes the Nova-Knowledge pages. The private-folder question (old 2.0.4) is still open.

## G. General Atlas — answers with no model (added 2026-10-25, Brandon: "urgent")

**The rule:** Atlas must be the best general-purpose assistant it can be with *no* model connected. A language model is an accessory; it must never be the reason a question that can be answered goes unanswered. Brandon's two examples ("how many folders are there in: D:\Dev?" and "what is a Reel from Instagram?") were refused with "I couldn't reach your language model". The fix is not those sentences, it is two general mechanisms (his instruction: do not fix the two questions, upgrade general usage).

### G1. Questions about this PC → answered from the file system
`src/general/file-facts.ts` (parser) + `src/skills/file-facts-skills.ts` (`files.facts`, read-only, `risk: safe`) + one grammar rule (`planner/facts-grammar.ts`).
- Understands: how many folders/files/items in a place (direct, plus the recursive total when it can be measured), how many of one kind (mp4, photos, documents… direct level), list the folders/files, newest/oldest file or folder, does X exist / is there a folder called X, when was X last changed, what drives do I have.
- Any phrasing with a count word + a kind of thing + a place (`D:\Dev`, `my downloads folder`, `D:`) is read the same way; instructions (delete, move, open…) are never read as questions.
- Honest about limits: `listDir` returns at most 500 entries, so a bigger folder says "at least"; the recursive walk can be partial and says so; a place outside Allowed Folders gives the normal "Add it?" offer.
- "largest/biggest" and "recent" stay with `storage.*` / `files.recent` (they scan properly).
- Also fixed on the way: "list the folders in D:\Dev" passed the whole phrase as the path; "difference between a virus and a bacteria" was read as a time-zone question; "what is the square root of 144" did not reach the calculator.

### G2. Questions about the world → looked up, read, answered, cited
`src/general/` : `shape.ts` (what kind of question, what is it about, what to search, in order), `answer.ts` (search → read the best pages → compose), `compose.ts` (extractive answer).
- Runs whenever no model can answer: none connected, cloud planning off, or the configured one cannot be reached (the old apology only appears when the web cannot be reached either). A connected, reachable model still answers first, exactly as before.
- **Extractive, never generative:** every word of the answer is a sentence a source wrote, chosen by a readable score (subject coverage, definition shape, position in the page, title fit — "Reels (Meta)" beats "List of most-viewed Instagram reels" —, source trust, agreement across independent sites). A sentence that is a fragment, chrome, or about something else with the same word (a fishing reel) is never a candidate. Nothing can be invented; the source line under it lets the person judge.
- Honest labels: "I'm not sure this is the answer, but it is the closest thing I found", "I can't work this out myself, but here is what the sources say" (why / yes-no / compare), "one source, not cross-checked". When nothing relevant is found it says what it did ("I searched, but nothing I read answered that clearly") plus the closest links.
- Current-information questions ("who is the president of France", "what season is Fortnite on") now read the pages and answer with "read from the web just now", instead of a bare list of links; the links remain the fallback and what "search the web for …" gets.
- Providers: the existing order (SearXNG if set up → Tavily if a key is saved → DuckDuckGo → Wikipedia backstop). Pages are read for the top results, the lead of each page is always kept (an encyclopedia's first sentences are the definition).
- Verified against real Wikipedia text for ~20 questions (definitions, people, measurements, dates, yes/no, how/why). Weak spot, stated plainly: *why/how* questions are only as good as the top page — Wikipedia as a backstop explains "why is the sky blue" badly; DuckDuckGo/Tavily results do better. DuckDuckGo is CAPTCHA-blocked on this machine, so the DuckDuckGo path was tested with fakes only.

### G3. Not done yet (next, in order)
1. Recursive counts by file type ("how many mp4 files in D:\Videos including subfolders") need a native `count_entries` command (Rust, authorization inventory entry); today it counts the folder itself and says so.
2. Live check of the DuckDuckGo / Tavily path in the real app with a real key.
3. A small answer cache (same question twice in a day should not re-search) and "tell me more" (the next sentences of the same source).
4. Offline reference data that needs no web at all: the 2.0.3 knowledge pack pattern could carry a few thousand common definitions and facts (capitals, units, constants, periodic table, calendar facts).
5. Spoken answers (V2) should read the first sentence and the source name only.
6. Broader local intelligence: system questions beyond the existing specs/disk/uptime, "what is using my CPU/RAM", "what changed in this folder since yesterday".

## Build status (2026-10-25, local branch atlas-2.0.5, nothing pushed)

| Workstream | State |
|---|---|
| G General Atlas (no-model answers) | Built, real-app verified (01097cf) |
| V7 Sketches | Built, hostile-SVG tested; not yet seen with a real model; PNG export deferred (no binary write command) |
| V1 Activation: double clap | Built (b4f18cf); thresholds from synthetic sounds, **not yet tuned on a real microphone** |
| V1 Activation: typed wake phrase | Built. The person types any phrase; matched against local whisper transcripts of short speech bursts. Measured on 48 spoken sentences (8 bundled voices): phrase heard 24/24, request after it intact 16/16, 0/24 false wakes, but only with the phrase leading whisper's prompt (it was 6 in 10 with the phrase last). Real human voices and a real room will be worse: **needs Brandon's mic** |
| V3 Personalities | Built: Formal, Casual, Light humour, Dry/sarcastic, Custom (one-line style note) + "how you like to be addressed"; wording only, safety text unchanged for every role (tested). Per-action custom confirmation lines intentionally NOT built: confirmations stay fixed so tone can never loosen them |
| V4 Background | Built: start with Windows (registry entry verified by read-back, real round-trip run), close-button choice, Normal/Quiet/Privacy modes, quiet hours, spoken reminders (off by default; alarms always sound). The 4th mode "presence" waits until there is something to volunteer |
| V2 Conversation (sentence-by-sentence speech, "that's all") | Barge-in already existed; the rest is not built |
| V5 Desktop-control audit, V6 resume by voice | Not built |
| V8 Privacy text | Settings text says what each listener does; NovaLegal update NOT written (ask first) |

### Next release (Brandon, 2026-10-25): do not limit activation to exactly two claps
The clap trigger is a fixed double clap for now. Planned for the release after: let the person choose the pattern
(e.g. single, double, triple, a rhythm they record), and combine it with the typed phrase. The detector already
reports each clap with its time, so a pattern matcher can sit on top without changing the audio side.

## Release rules reminder
Additive only; defaults unchanged (every listener, startup entry and tray-resident option OFF). **No Atlas code, commit, push or deploy until Brandon approves the plan; the spike runs only in its throwaway folder, only after he says go.**
