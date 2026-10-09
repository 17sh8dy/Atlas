# Atlas Tool Catalog

What Atlas can do, what it can do in part, what is missing, and what it will not do.
Every capability has **one canonical skill id**; where an item appears in several
categories (shutdown, Create ZIP, Open Task Manager…) it points at the same skill, so
nothing is built twice. The catalog is a *layer over* the skills, not a second set of tools.

**Status key**

| | |
|---|---|
| ✅ | Built, tested |
| 🟡 | Partly there, or reachable by combining existing skills |
| 🔨 | **Built in the 1.0.6 catalog pass** — tested, listed in the section at the end |
| ❌ | Not built — can be |
| 🚫 | Not built **on purpose** or cannot be built (reason given) |

**Rules that apply to every row** (from `ARCHITECTURE.md`): no general `exec`; every native
operation is a closed set with checked arguments; risk follows *consequence*, not mechanism;
anything that deletes, overwrites, publishes, changes permissions or needs administrator
rights asks first (or is refused); the emergency stop halts everything.

---

## Files & folders

| Capability | | Skill / how |
|---|---|---|
| Create file / folder | ✅ | `files.create`, `files.createFolder` (and by spoken place: "… on my desktop") |
| Open file / folder · Open containing folder | ✅ | `files.open`, `files.openKnown`, `files.reveal` |
| Rename file / folder · Change file extension | ✅ | `files.rename` (a new name with a new extension is the same operation) |
| Move file / folder | ✅ | `files.move` |
| Copy file | ✅ | `files.copy` |
| Copy folder · Duplicate file · Duplicate folder | 🔨 | `files.duplicate` (beside the original, "… - Copy", undo = Recycle Bin). `files.copy` into *another* folder is still files-only |
| Delete / Move to Recycle Bin | ✅ | `files.delete` (always the Recycle Bin, always asks) |
| Restore from Recycle Bin · Empty Recycle Bin | ✅ | `files.restore`, `files.recycleBin`, `system.emptyRecycleBin` |
| Compare two files | ✅ | `files.compare` |
| Compare two folders | 🔨 | `files.compareFolders` |
| Find file / folder · Find by name | ✅ | `files.find` |
| Find by extension · size · date | 🔨 | `files.search` (ext / min / max size / modified within) |
| Find recently modified | ✅ | `files.recent` |
| Find duplicate files | ✅ | `files.duplicates` |
| Find empty folders / empty files | 🔨 | `files.findEmpty` |
| Get file / folder information · Folder size | ✅ | `files.info`, `storage.folderSize` |
| Largest files · largest folders | ✅ | `storage.largestFiles`, `storage.largestFolders` |
| Watch a folder · Monitor a file | 🟡 | `watch.create` (downloads finishing, a path appearing); no general change-feed |
| Copy file path / folder path | ✅ | `files.copyPath` |
| Copy file name | ❌ | `files.copyPath` copies the full path; name-only is not yet |
| Batch rename | ✅ | `files.batchRename` (previewed, collision-safe) |
| Batch move · organize · Sort · Group | 🟡 | `files.organize` (by type, previewed, undoable) |
| Batch copy · Batch delete | ❌ | would be `confirm` with the exact list, like batch rename |
| Create ZIP · Extract ZIP · Archive · Extract archive | ✅ | `files.zip`, `files.unzip` |
| List ZIP contents | 🔨 | `files.listArchive` |
| Add / remove file in ZIP · 7z / tar / tar.gz | ❌ | needs a second archive library |
| Search inside text files / folders | ✅ | `code.search` (any allowed folder) |
| Replace text across files | 🔨 | `code.replaceAll` (1.0.8): exact, case-sensitive, 2+ chars; preview lists every file and count, the approval is for that plan, originals are saved to `.atlas-backup`, and `code.replaceAllUndo` puts them back. Never touches dependencies, lockfiles, build output or binaries |
| Create shortcut · Desktop shortcut · Start Menu shortcut | 🔨 | `files.createShortcut` (.lnk to a file/folder, .url to a web address; desktop by default, any folder you name; undo = Recycle Bin). Start Menu: say the folder. A shortcut to an *installed app* is not built (app targets are opaque) |
| Change attributes · Read-only · Hidden | ✅ | `files.attributes` |
| Hash file · SHA-256 file | 🔨 | `files.hash` |

## Text & documents

| Capability | | Skill / how |
|---|---|---|
| Create text document · Append text | ✅ | `files.create`, `files.append` |
| Edit text file · Replace text · Find and replace | ✅ | `code.edit`, `code.write`, `text.replace` (on text) |
| Insert at line · Delete / move / duplicate lines | 🟡 | `code.edit` patches a range; no named line verbs |
| Format JSON · Minify JSON · Validate JSON | ✅ | `util.json` |
| Format / validate XML · YAML · TXT↔Markdown · Markdown→HTML | ❌ | |
| Count words · Count lines | ✅ | `text.count` |
| Open document in default app | ✅ | `files.open` |
| Extract text from a document (PDF/Word) | ❌ | needs a document reader |
| Search document | ✅ | `code.search`, `files.peek` |
| Compare documents · Generate diff | ✅ | `files.compare` (first differing lines), `git.diff` |
| Merge text files | ❌ | |

## Applications

| Capability | | Skill / how |
|---|---|---|
| Launch application | ✅ | `app.open` — installed → several → known site → already-open → on disk → asks |
| Close · Force-close | ✅ | `window.close` (asks), `system.endProcess` (asks; protected processes refused) |
| Restart application | 🔨 | `app.restart` — reopens exactly what it closed, never a similarly named app (Store apps with no launchable entry: it closes, says so, and asks you to say "open …") |
| Focus · Minimize · Maximize · Restore · Switch | ✅ | `window.focus` / `minimize` / `maximize` / `restore` |
| Move · Resize · Snap left/right/top/bottom | ✅ | `window.move`, `window.place` |
| List running · Is it running | ✅ | `system.processes`, `window.list`, `app.isRunning` |
| Get application path · Find installed application | ✅ / 🔨 | `app.list`, `app.open`; a running one's path: `system.processInfo` |
| Uninstall application | ✅ | `apps.uninstall` (winget, asks) |
| Install / update application | ✅ | `apps.install`, `apps.update`, `apps.updates` |
| Restart as administrator · Run as administrator | 🚫 | Atlas never launches anything elevated; `app.runAsAdmin` says so and opens nothing |
| Open application with file / URL | 🟡 | `web.open` (browser), `files.open` (default app); no "open X *with* Y" |
| Create application shortcut | ❌ | see above — needs a launchable target for the app |

## Mouse & keyboard

Semantic actions are preferred over raw input: "create a new document in Notepad++" is
*focus → wait for window → Ctrl+N*, never a blind click. Every input is checked against the
foreground window, refuses protected/elevated targets, and reports whether it was verified.

| Capability | | Skill / how |
|---|---|---|
| Move mouse · Left / right / double / middle click · Drag · Wheel | ✅ | `input.*`, `kbm.*` |
| Key press · Shortcut · Key combination · Hold key | ✅ | `input.pressKey`, `input.hotkey`, `input.holdKey` |
| Release key | 🚫 | holds always release themselves, even on the emergency stop |
| Type text · Paste · Copy / Cut · Undo / Redo · Select all · Enter / Esc / Tab / Shift+Tab / Ctrl+N/T/W/S / Ctrl+Shift+S / Alt+F4 | ✅ | `input.typeText`, `input.hotkey` (Alt+F4 asks) |
| Detect focused window / active application | ✅ | `window.active`, `kbm.get_active_window`, `uia.focusedElement` |
| Wait for window | ✅ | `window.await` |
| Wait for UI element | 🟡 | `uia.tree` polling inside `ui.drive` |
| Screenshot screen · window | ✅ | `screen.capture`, `screen.captureWindow` |
| Screenshot region | ❌ | |
| **Understand a screenshot** (read it, find things in it) | 🚫 | **vision** — no OCR / vision model; Atlas reads UI through the accessibility tree instead. A local vision model would be needed; cloud vision is excluded by rule |

## Browser / web

Atlas drives the browser through the OS (open, search, keys) and reads pages as text through
research. It has **no in-page automation** (clicks, forms, DOM) — that needs a browser driver.

| Capability | | Skill / how |
|---|---|---|
| Open browser · Open URL · Search web · Search YouTube / images / maps / Wikipedia | ✅ | `web.openBrowser`, `web.open`, `web.search`, `web.search*` |
| Search a site · GitHub · Reddit · documentation | 🔨 | `web.searchSite` (GitHub, Reddit, Stack Overflow, npm, crates.io, PyPI, MDN, Amazon, eBay, IMDb, Steam, or any domain) |
| New tab · Close tab · Switch tab · Reload · Back / forward · Find on page · Scroll | 🟡 | `input.hotkey` into the focused browser |
| Copy URL | 🟡 | hotkey (Ctrl+L, Ctrl+C) |
| Read webpage · Extract text · Web research · Search multiple sources · Compare sources · Find official source · Check page date | ✅ | `research.search`, `research.open` |
| Summarize webpage | 🟡 | needs a language model |
| Extract tables · Extract links | ❌ | |
| Click link / button · Type into field · Select dropdown · Check / uncheck · Submit form | 🚫 | no browser driver (UIA can click what is visible, unreliably in web content) |
| Download file · Upload file · Save webpage / PDF | ❌ | |
| Open downloads · Open / search / clear history · Bookmarks | 🟡 | `files.openKnown downloads`; history and bookmarks are browser-private databases |
| Screenshot webpage | 🟡 | `screen.captureWindow` |

## Windows / system, Display, Power, Windows UI

| Capability | | Skill / how |
|---|---|---|
| Windows version · System info · CPU · GPU · RAM · Storage | ✅ | `system.specs`, `system.info`, `system.disk` |
| Motherboard · BIOS | 🔨 | `system.firmware` |
| Network info · IP · Uptime | ✅ | `net.adapters`, `net.ip`, `system.uptime` |
| Current user · Computer name | 🔨 | `system.firmware` (also `system.specs`) |
| Lock · Sign out · Restart · Shut down · Sleep · Hibernate | ✅ | `system.lock`, `system.power`, `system.sleep` |
| Schedule shutdown / restart · Cancel | ✅ | `system.shutdownIn`, `system.shutdownCancel` |
| Open Settings (19 pages) · Windows Update · Network / Display / Sound / Bluetooth / Storage / Apps / Privacy | ✅ | `system.settingsPage` |
| Task Manager · Device Manager · Control Panel · File Explorer · This PC · Recycle Bin | ✅ | `system.openTool` |
| Services · Event Viewer · Disk Management · Resource Monitor · Registry Editor · Run | 🔨 | `system.openTool` (extended) |
| Open Start · Quick Settings · Notification Center · Search | 🟡 | Windows-key combinations via `input.hotkey` |
| Open Windows Terminal / PowerShell / CMD | ✅ | `project.terminal`, `app.open` |
| Resolution · Refresh rate · Scaling · HDR · Night Light on/off/schedule · Primary monitor · Enable/disable monitor | 🚫 | Windows keeps these to the person; Atlas opens the page (`system.settingsPage display / night-light`) |
| List monitors · Move window to monitor · Projection mode | ✅ | `screen.listDisplays`, `window.place`, `system.projectDisplay` |
| Get resolution · refresh rate · scaling | 🟡 | `screen.listDisplays` gives size and scaling; refresh rate is not read yet |
| Dark mode · Light mode · Brightness | ✅ | `system.theme`, `system.brightness` |
| Power plan · Balanced / Performance / Battery saver · Battery status | ✅ | `system.powerPlan`, `system.battery` |

## Audio

| Capability | | Skill / how |
|---|---|---|
| Get / set / increase / decrease / mute / unmute volume | ✅ | `system.volumeSet`, `system.volume`, `system.mute` |
| Microphone status · mute · unmute · level | ✅ | `system.micMute`, `system.micLevel` |
| List audio devices · Get output / input device | ✅ | `system.audioDevices` (read-only) |
| Per-app volume · Now playing · Shuffle | ✅ | `system.appVolume`, `media.nowPlaying`, `media.shuffle` |
| Change output / input device | 🚫 | Windows has no supported API for it |
| Test microphone / speakers | ❌ | speakers: `system.playTest` could reuse the alert tones |

## Archives, search, processes, startup

| Capability | | Skill / how |
|---|---|---|
| ZIP create / extract / compress / decompress folder | ✅ | `files.zip`, `files.unzip` |
| List ZIP contents · Get archive size | 🔨 | `files.listArchive` |
| Search files / folders / filenames / extensions / size / dates / location | ✅ / 🔨 | `files.find`, `files.search` |
| Search applications | ✅ | `app.list`, `app.open` |
| Search settings | 🟡 | `system.settingsPage` by name |
| Search processes | ✅ | `system.processes`, `app.isRunning` |
| Search registry · Search environment variables | 🟡 | `environment.list` / `get`; a read-only registry reader is not built (and sensitive keys would be refused) |
| Search recently opened · Installed programs | ✅ | `files.recent`, `app.list`, `apps.updates` |
| List / find processes · CPU / RAM per process | ✅ | `system.processes` |
| Process information · path · command line | 🔨 | `system.processInfo` |
| Start process | ✅ | `app.open` |
| Stop · Force-stop process | ✅ | `system.endProcess` (asks) |
| Restart process | 🔨 | `app.restart` |
| Monitor process · Wait for process · Detect launch / exit | ✅ | `watch.create` |
| List startup apps · Enable · Disable | ✅ | `system.startupApps` |
| Add · Remove startup app · Inspect command | 🟡 | the list shows each command; adding/removing writes autorun entries and is not built |
| Open Startup folder / settings | ✅ | `system.settingsPage startup-apps` |

## Network

| Capability | | Skill / how |
|---|---|---|
| Adapters · Wi-Fi status · IP · saved networks · online check | ✅ | `net.adapters`, `net.wifi`, `net.ip`, `net.savedNetworks`, `net.online` |
| Test connection · Ping · Speed test | ✅ | `net.online`, `net.ping`, `net.speedTest` |
| Flush DNS | ✅ | `net.flushDns` |
| DNS lookup · Trace route | 🔨 | `net.dnsLookup`, `net.traceroute` |
| Gateway · DNS servers · Ethernet status · Network usage | 🟡 | partly in `net.adapters` |
| Renew / release DHCP · Connect / disconnect Wi-Fi | 🚫 | change the connection; need administrator rights or interrupt the connection Atlas may be using |
| Wi-Fi / Bluetooth / airplane on/off | ✅ | `system.radio` (off asks) |

## Security (extra permission controls)

All read-only unless stated. Changes to permissions, firewall, registry or security settings
are **not built** and, if added, would be `confirm` per action at minimum.

| Capability | | Skill / how |
|---|---|---|
| Defender status · Firewall status · Open Windows Security · Open firewall | 🔨 / ✅ | `security.status`; `system.settingsPage privacy` |
| Check administrator status | 🔨 | `security.status` |
| Hash / SHA-256 file | 🔨 | `files.hash` |
| Verify file signature · Check certificate | ❌ | Authenticode via WinVerifyTrust — not yet |
| List firewall rules · Account permissions · Inspect file / folder permissions | ❌ | |
| Request administrator permission | ✅ | per-action approvals for services and environment variables only (`elevation.rs`) |
| Run command as administrator · Change permissions · Firewall changes | 🚫 | no general elevation |

## PowerShell / terminal

| Capability | | Skill / how |
|---|---|---|
| Open PowerShell · CMD · Terminal | ✅ | `project.terminal` (opens a shell in the project) |
| Run PowerShell / CMD command or script · Capture output · exit code · Kill · Wait | 🚫 | **no general exec — by design.** Needs a design decision: an effect-aware classifier (read-only allowed, writes/deletes confirmed, admin refused). Tracked separately |
| Run a *named project script* (lint, typecheck, format, build, test) | ✅ / 🔨 | `build.run` (its `target` is any script the project defines), `test.run` |
| Set / get / list / create / remove environment variable | ✅ | `environment.*` (system scope asks, via elevation) |
| Add / remove PATH entry | 🚫 | `PATH` is a protected variable — overwriting it is a way to change what every program runs |

## Developer tools, testing

| Capability | | Skill / how |
|---|---|---|
| Git status · diff · log · branch · switch · commit · stage · pull · push · stash | ✅ | `git.*` |
| Merge branch · Create tag · List tags · Unstage · Discard a file's changes · Initialize repository | 🔨 | `git.merge`, `git.tag`, `git.tags`, `git.unstage`, `git.discardChanges`, `git.init` |
| Clone repository · Checkout commit | ❌ | network / detached state |
| Open project · Open in VS Code · Create project · Create / edit file · Search project | ✅ | `project.*`, `code.*` |
| Run tests · specific test · test output · build · compiler errors | ✅ | `test.run` (with filter), `build.run` |
| Run linter · formatter · typecheck | 🔨 | "run the linter / typecheck / formatter" → `build.run` with that script |
| Find TODOs / FIXMEs | ✅ | `code.search` |
| Search symbols · Find references · Open definition | ❌ | needs a language server |
| Retry failed tests · Generate test report · Compare results | ❌ | |
| Install dependencies · Scaffold · Deploy | ✅ | `dependency.install*`, `project.scaffold`, `project.deploy` |

## System monitoring, clipboard, images, video

| Capability | | Skill / how |
|---|---|---|
| CPU / RAM / disk usage · free space · process usage | ✅ | `system.info`, `system.disk`, `system.processes` |
| GPU · VRAM · Temperatures · Fans | ❌ | needs vendor APIs |
| Network usage | ❌ | |
| Monitor disk / CPU / RAM / process / folder / network | 🟡 | `watch.create` for processes, folders, downloads, connectivity |
| Clipboard read / write / clear / append / transform / save | ✅ | `clipboard.*` |
| Clipboard history · image · detect type | 🔨 / ❌ | `clipboard.history` · `clipboard.restore` · `clipboard.clearHistory` — OFF by default, memory only, secrets never kept (see the review below). Images and type detection: not built |
| Open image · Convert · Resize · Compress | ✅ | `files.open`, `media.convert`, `media.resizeImage` |
| Image dimensions / format · Crop · Rotate · Flip · Thumbnail | 🔨 | `media.info`, `media.edit` (rotate, flip, square crop, thumbnail; free-form crop is not built) |
| Compare images · Find duplicate images | 🚫 | needs vision / perceptual hashing |
| Video: open · convert · compress · extract audio | ✅ | `media.convert`, `media.compress` |
| Video: information · duration · resolution · FPS · Extract frame · Trim | 🔨 | `media.info`, `media.trim`, `media.frame` |
| Merge videos | ❌ | |
| Open recording folder · Find latest / largest recording | 🟡 | `files.recent`, `storage.largestFiles` on the folder |

## Gaming and the Nova ecosystem

| Capability | | Skill / how |
|---|---|---|
| Launch / close a game or launcher (Steam, Epic, Xbox, Battle.net, Ubisoft, Minecraft, Fortnite) | ✅ | `app.open`, `window.close` |
| Detect running game · Monitor game process · Wait for exit | ✅ | `app.isRunning`, `watch.create` |
| Find game folder · save files | 🟡 | `files.find` |
| FPS | ❌ | needs an overlay or driver API |
| Open Replay.GG / Nova Cut / Atlas / sites | ✅ | `app.open`, `web.open` |
| Start / stop a Replay.GG recording | ❌ | needs an interface in Replay.GG itself |
| Latest clip / screenshot | 🟡 | `files.recent` |

## Atlas's own tools

| Capability | | Skill / how |
|---|---|---|
| Atlas version · Check for update · Download / install · Restart | 🟡 | updater is in Settings → About; no skill yet |
| List skills · Search skills · Inspect skill | ✅ / 🔨 | `engine.help` ("what can you do"); `engine.searchSkills` ("can you do anything with zip files") |
| Enable / disable a skill · Reload · Test | ❌ | |
| Get / change execution mode · permission mode | 🚫 | **a model must not be able to loosen its own permissions** — changed by the person only |
| View / clear logs · Export diagnostics · Self-test | 🟡 / 🔨 | `engine.selfTest` is built; logs and export live in Settings → About / Activity |
| Nova Intelligence: find / select folder / start / stop / check | 🟡 | Settings → Intelligence; no skills |
| Ollama: check · list local models | 🟡 | Settings → Intelligence |
| Open Atlas settings | ✅ | the gear / "open settings" |

## Credentials / accounts

| Capability | | Skill / how |
|---|---|---|
| Open credential manager · account settings · password manager | 🟡 | `app.open` |
| Check whether a credential exists | ✅ | internal only (Atlas's own keys) |
| Read / show tokens, passwords, cookies, sessions, API keys | 🚫 | **hard no**, whatever the wording |

## Cleanup

| Capability | | Skill / how |
|---|---|---|
| Find large files · duplicates · old downloads · old installers | ✅ / 🔨 | `storage.largestFiles`, `files.duplicates`, `files.recent`, `files.search`, `cleanup.review` |
| Find temp files · crash dumps · caches | 🔨 | `cleanup.review` (temp, crash dumps, old installers); browser and app caches are private to those apps — not offered |
| Clean temp · crash dumps · old installers | 🔨 | `cleanup.clean` — counts again, shows the exact amount, asks once; refuses if there is now much more than was reviewed; installers go to the Recycle Bin, scratch is removed for good and says so |
| Empty Recycle Bin | ✅ | `system.emptyRecycleBin` (asks) |
| Clean browser cache · app cache · Windows temp (system) · logs | 🚫 | browser/app caches are private to those apps; system folders need administrator rights |

## Time, notifications, services, registry, cloud

| Capability | | Skill / how |
|---|---|---|
| Current time / date · Timers · Stopwatch · Reminders · Alarms | ✅ | `time.*`, `stopwatch`, `reminder.*`, `alarm.set` |
| Schedule application launch · recurring task | ✅ | `routine.create` (safe steps only, approved once) |
| Schedule shutdown / restart | ✅ | `system.shutdownIn` |
| Schedule a script | 🚫 | no script runner (see PowerShell) |
| Create Atlas notification | ✅ | `notify.send`, reminders |
| Notification preferences (toast, sound, which sound) | ✅ | Settings → Notifications |
| Dismiss / clear / read Atlas notifications | ❌ | |
| Services: list · status · start · stop · restart | ✅ | `service.*` (changes ask; administrator approval is per action) |
| Services: enable / disable | ❌ | |
| Registry: read value | ❌ | not built; would be read-only with sensitive keys refused |
| Registry: search · create / set / delete · export / import | 🚫 | writes are not offered; every write would need explicit confirmation |
| Cloud (GitHub, Drive, Dropbox, OneDrive, Discord, Gmail, Calendar, Slack, Notion, Cloudflare, Vercel, Actions) | 🚫 | each needs its own account and permission domain; "delete this repository" must never be treated like "open GitHub". Compose-only mail and calendar exist (`mail.compose`, `calendar.add`); Vercel / Cloudflare deploy exists (`project.deploy`) |

---

## Release review (before 1.0.6)

**Marked "missing" but actually built:** none turned up — every skill id the catalog names was checked against the code
(a script does this). Rows that *were* missing and are now built: shortcuts, duplicate, cleanup review → clean,
clipboard history, self-test, media info / trim / frame / edit, restart an app, and everything in the section below.

**Partial that the new skills now complete:** copy / duplicate (files and folders), cleanup (review → clean),
clipboard history (text), video and picture information.

**Duplicate capabilities — none, but these sit close, and are kept apart on purpose:**

| Looks like | Why both exist |
|---|---|
| `files.copy` vs `files.duplicate` | copy puts a *file* in another folder; duplicate makes "X - Copy" beside it, folders included |
| `files.compare` vs `files.compareFolders` | two files vs two folders |
| `media.convert` (video → picture) vs `media.frame` | first frame vs a frame at a time you give |
| `storage.largestFiles` / `files.duplicates` vs `cleanup.review` | those find things anywhere; review looks at three fixed leftover places |
| `system.processes` vs `system.processInfo` | the list vs one program's file and uptime |

One canonical id per capability; the catalog maps every duplicate row to it.

**Checked against the design rules (no arbitrary execution, no credential exposure):**

- **Process command line — deliberately not exposed.** Programs are often started with tokens in their arguments.
- **Clipboard history — allowed only in this shape:** off by default; memory only (never written to storage, never sent
  to a model); anything that looks like a key, token, password line, private key, card number or long random string is
  never kept; cleared when turned off or when Atlas closes; the list is shown but not saved with the conversation and
  not read aloud. Tested against 20 secret-like samples and 9 ordinary texts.
- **Cleanup — closed list.** Three fixed places, never a path from the caller; re-counts before removing.
- **The self-test reads only.** It runs `git --version` / `ffmpeg -version`, never touches the clipboard, credentials
  or the conversation.
- **Permission mode stays out of reach.** No skill reads or changes it; only the person does.

**Classified "won't" (explicit):** an arbitrary PowerShell / CMD runner (until there is an effect-aware classifier);
reading passwords, tokens, cookies, API keys or sessions; running anything as administrator; changing permissions,
firewall rules, certificates, the registry or security settings; choosing the audio device (no supported API);
vision / OCR (no local model; cloud vision is excluded); DOM-level browser automation; per-service cloud accounts;
adding to `PATH`.

**1.0.6 vs later**

| In 1.0.6 | Later (can work, not needed to ship) | Needs a decision first |
|---|---|---|
| everything in the two sections below, scroll speed | Batch copy / delete · replace text across files · add or remove a startup app · enable / disable a service · clone a repository · extract tables / links · merge videos · free-form crop · Atlas version skill · speaker test · notification dismissal · a read-only registry reader · verify a file signature | PowerShell runner · anything that writes the registry or firewall · GPU / temperature monitoring (needs a driver or vendor API) · starting / stopping a Replay.GG recording (needs an interface in Replay.GG) |

## 1.0.6 catalog pass — what was added

Every skill below is new in this pass (none duplicates an existing one), tested, and — where it
touches the machine — a closed native operation covered by the emergency-stop sweep.

| Skill | What |
|---|---|
| `system.openTool` (extended) | Services, Event Viewer, Disk Management, Resource Monitor, Registry Editor |
| `app.restart` | "restart discord" — asks, closes it, reopens the same program |
| lint / typecheck / format *(phrasing)* | → `build.run` with that script, in the current project |
| `web.searchSite` | search GitHub, Reddit, Stack Overflow, npm, crates.io, PyPI, MDN, Amazon, eBay, IMDb, Steam, or any domain |
| `engine.searchSkills` | "can you do anything with zip files" |
| `files.hash` | SHA-256 of a file |
| `files.listArchive` | what is in a zip, without extracting |
| `files.search` | by extension, size, age |
| `files.findEmpty` | empty files / folders (lists only) |
| `files.compareFolders` | what differs between two folders |
| `git.merge` · `git.tag` · `git.tags` · `git.unstage` · `git.discardChanges` · `git.init` | a merge that would conflict is aborted at once; discarding names one file and says it cannot be undone |
| `net.dnsLookup` · `net.traceroute` | trace route can take a minute or two |
| `media.info` · `media.trim` · `media.frame` · `media.edit` | ffmpeg; length / size / fps, trim a clip, a still from a video, rotate / flip / square-crop / thumbnail a picture — always a new file |
| `system.processInfo` | where a running program lives, memory, uptime — **never its command line** |
| `system.firmware` | BIOS, motherboard, computer and user name |
| `security.status` | firewall, Defender real-time protection, whether Atlas is elevated — read only |
| `files.duplicate` | a copy of a file or whole folder beside it ("X - Copy"); undo = Recycle Bin |
| `files.createShortcut` | .lnk to a file/folder or .url to a web address; undo = Recycle Bin |
| `cleanup.review` · `cleanup.clean` | temp files, crash dumps, old installers: review counts, clean re-counts + asks; installers → Recycle Bin |
| `clipboard.history` · `clipboard.restore` · `clipboard.clearHistory` | opt-in, memory only, secrets skipped |
| `engine.selfTest` | checks this install is in working order (registry, phrasings, PC probes, git/ffmpeg, settings, model) |
| Scroll speed *(Settings → General)* | wheel speed 25–200%, and one wheel flick is capped at 160 px |

### Next (can work today, not yet built)

Merge videos and free-form crop; a read-only registry reader; an Atlas version skill; refresh rate; speaker test.

### Needs a decision, not more code

An arbitrary PowerShell / CMD runner (would need an effect-aware classifier); anything that
changes permissions, firewall rules, certificates or the registry; audio device switching (no
supported API); vision / OCR (no local model; cloud vision is excluded by rule); DOM-level
browser automation (needs a driver); cloud accounts (each is its own permission domain).

## 1.0.8 — project tools that need no model

Added with the "switch the whole app to red" request that used to end in *"I couldn't reach your
language model"*. All four share `skills/project-files.ts` (bounded reads that skip dependencies,
lockfiles and build output; every original copied to `.atlas-backup\<label>-<time>\` before any
write; restored backups are marked, never deleted).

| Skill | What it does |
|---|---|
| `project.recolor` · `project.recolorUndo` | "make the whole app red", "switch the look of D:\Dev\X to blue". Rotates the hue of the theme's own colours (css, html `<style>`/`style=`/theme-color, js/ts hex strings and `rgb()`), keeping lightness, saturation and alpha. Colours with a meaning of their own (a gold "hot" chip, a green "good" badge) and greys stay. Preview first; **not** claimed for one part ("make the button red") or a build ("make me a red app") — those still need a model. `hsl()` and colour keywords are reported, not rewritten |
| `code.replaceAll` · `code.replaceAllUndo` | `replace "old" with "new" in D:\Dev\X` (quoted text, and a project named as the place — plain-text replace keeps its own tool) |
| `project.stats` | files and lines by language, biggest files — "how many lines of code are in my project" |
| `project.todos` | TODO / FIXME / HACK / XXX comments with file and line |
| edit requests with a folder | "add a shop to D:\Dev\Game" → `devagent.run` (needs a model, and says so plainly) instead of "that question needs one" and an offer to search the web |

Also in 1.0.8: "what's your name?" answers with the name only (the full introduction is for "who are you?");
short definition questions ("what is a lagoon?") are asked of the model for **three sentences** with the other
meanings named, because on a CPU-only local model the length of the reply *is* the wait; and the sign-in client
polls straight away when Atlas regains focus after you approve it in the browser.

## 1.0.8 — PC health, file intelligence, developer tools, background input

Every tool below that only looks is `safe` and genuinely read-only: the native side (`pc_health.rs`) has
no write path, its PowerShell reads are fixed scripts that take their inputs through environment
variables (never pasted into the script), paths go through Allowed Folders, the registry reader is
HKCU/HKLM only with the security hives refused and password-like values hidden, and every command checks
the emergency stop first. Text that comes from outside (event-log messages, documents, build output) is
shown as data and never acted on. Tests: `health-tools.test.ts`, `virtual-input.test.ts`,
`workflow-report.test.ts`, `builder.test.ts`, `notify.test.ts`.

| Skill | What it does |
|---|---|
| `system.metrics` | live CPU, memory, GPU, disks, network speed, and the programs using the most CPU / memory (one ~1 s sample, said to be one reading) |
| `system.errors` | critical and error events from the System and Application logs, grouped by source, last 1–168 h |
| `system.software` | installed programs (name, version, publisher, size), filter by word, biggest first |
| `system.drivers` | installed drivers by class, versions and dates, unsigned ones flagged |
| `net.usage` | bytes sent / received per adapter and the rate right now — counters only |
| `system.report` | **the evidence-based performance report**: every finding quotes its numbers; what could not be measured is listed; thresholds are fixed and tested; same readings → same report |
| `files.verify` | what a file really is (from its first bytes) vs its extension, SHA-256, and Authenticode signature (who signed, is it trusted / changed since). Never runs the file |
| `files.readDocument` | text of a PDF or .docx, or only the passages around a word. Scanned PDFs have no text (no OCR) and password-protected ones are refused |
| `files.searchContent` | text *inside* files in a folder: text/code files (the `code.search` engine) plus PDF / Word documents (first 25) |
| `files.mergeText` | join text files into ONE NEW file — never overwrites, originals untouched, exact list shown first, approval is for that plan |
| `registry.read` | one registry key's values and sub-keys. There is no registry *write* tool and none is planned |
| `build.diagnose` | runs the project's own build / test / lint / typecheck (confirm, like `build.run`) and explains a failure: file, line, first cause, hint, the code around it. `build.run` / `test.run` failures now carry the same "What went wrong" summary |
| `git.releaseNotes` | release notes from commits since the last tag (or a tag you name), grouped Added / Fixed / Improved / Changed / Removed / Documentation / Internal |
| `workflow.last` | the standard account of the last run: each step done / failed / declined / stopped / not run, what changed, what is left, where the results are. The transcript's step disclosure shows the same account |
| `files.batchRename` (+ `dryRun`) | "preview renaming…" shows every change, asks nothing, changes nothing; the real run still shows the plan and asks |
| `notify.send` (improved) | control characters stripped, long text cut and said so, a denial tells you where to turn notifications on |
| `project.check` · `builder.status` | the builder's **check** step and "what did you build" — see below |

### Background keyboard and mouse (`kbm.*`)

`kbm.click_element`, `kbm.type_text` (with a `control`) and `kbm.scroll` (with a `window`/`control`) now try the
**background route first**: they act through the window's accessibility interface, so your cursor stays put,
the keyboard is not used and the window in front stays in front. If the app can't do it that way Atlas says
why and **asks** before using the real mouse and keyboard — never a silent fall-back. `mode: virtual` never
falls back; `mode: real` goes straight to the real ones. A permission screen, protected desktop or window
running above Atlas is refused (nothing is offered), and passwords are never typed into in the background.
Coordinates (`kbm.click`), bare keys, hotkeys and untargeted text are real input by nature and say so.
Native: `uia_capabilities` (read), `uia_append_value` (adds text, reads it back to verify), `uia_scroll`.

### Builder foundation: describe → build → check → open

"Build me a clicker game in D:\Dev\Clicker" is now `scaffold → (install) → project.check → open`; a request for
something no template covers, in a named folder, is `developer agent → project.check → open`. The check is
static (is there something to open, does every file the page loads exist, do JSON files parse, does
package.json point at real files) and runs nothing; it does not prove the program works and says so. All
ready-made templates are built onto a real folder and checked by `builder.test.ts`. The change loop arrived in 1.0.9 (below).
Hosted backends and cloud deployment stay out of scope.

`uia.typeInto` follows the same rule: it sets the field's value in the background, and when the control can't
take text that way it now **asks** before focusing the field and typing with the real keyboard (it used to do that
silently). Same `mode` argument: `virtual` never falls back, `real` goes straight to the keyboard.

Note on `files.verify`: the signature check is Windows' own (`Get-AuthenticodeSignature`). To decide whether a signer is
trusted, Windows can contact the certificate authority to check the certificate has not been revoked, so that one
check may make a small network request the way any Windows signature check does. Atlas sends nothing about the file
itself, and never runs it.

## 1.0.9 — the builder loop, assist tools, transactional workflows

- `builder.change` (asks): snapshot of the project's text files to `.atlas-backup\change-<time>`, the developer agent makes only the
  asked change, `project.check` runs again; the reply says what changed and whether it is *verified* (a build/test passed AND the check is
  clean). Needs a model; says so plainly without one. `builder.revert` restores the snapshot and never deletes files the change added.
  Phrasings: "make the buttons bigger", "add a shop to the game", "undo the last change to my game", "rebuild it", "preview the game".
- `atlas.selfAudit`, `workflow.dryRun`, `diagnostics.explainFailure`, `git.changeImpact`, `config.diff`, `knowledge.citeEvidence` - read-only
  (see docs/ROADMAP.md 1.0.9 for what each does and what it cannot see). `text.pronounce` speaks a word, slowly, then spells it.
- **Workflows** - `workflow.transaction`, `workflow.resume`, `workflow.rollback`, `workflow.history`. "Do these as one workflow: A, then B".
  Validate first (an un-understood part or an unavailable tool refuses everything before step 1), one approval for the plan, then every step
  through the normal executor so its own approval, content policy and execution mode still apply. A checkpoint is saved before and after each
  step (`atlas.workflow.transactions`, last 30). On a failure Atlas offers to run the undo each finished step reported, newest first, and lists
  the steps with no undo - those stay done. An interrupted run resumes from the last finished step; the step that was in flight is asked about,
  never assumed done. "Verified" means the tool reported success, not that Atlas inspected the result. At most 15 steps.
