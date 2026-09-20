# Atlas 1.0.0 — install and first run

Atlas is a local-first desktop assistant for Windows. It does its job on your PC, with no account,
no API key and no internet needed for the everyday things it does.

## What you need

| | |
| --- | --- |
| **Windows** | Windows 10 (64-bit) or Windows 11 |
| **Disk space** | About 460 MB installed (the voices and speech recognition are bundled) |
| **Rights** | None. It installs for your user only; no administrator prompt |
| **WebView2** | Built into Windows 11 and up-to-date Windows 10. If yours is missing, the installer fetches it, which needs an internet connection once |

You do **not** need Ollama, an API key or a Nova Account. Those are optional (see below).

## Install

1. Download `Atlas_1.0.0_x64-setup.exe` from the [latest release](https://github.com/17sh8dy/Atlas/releases/latest).
2. Run it and follow the steps.
3. Atlas starts. Press **Ctrl+Space** anywhere to summon or hide it.

### "Windows protected your PC"

Atlas 1.0.0 is **not code-signed yet**, so Windows SmartScreen shows a blue warning the first time.
That is expected for an unsigned installer, not a sign of a problem. Choose **More info → Run anyway**.

If you want to confirm the file is the one that was published, compare its checksum with the
`sha256` in `latest.json` on the same release page:

```powershell
Get-FileHash .\Atlas_1.0.0_x64-setup.exe -Algorithm SHA256
```

## First run

- **Ctrl+Space** summons Atlas. Press it again to hide it.
- Try: `what can you do?`, `system status`, `open steam`, `find my invoices`.
- **F8 is the emergency stop.** It halts whatever Atlas is doing, immediately. You can change the key
  in Settings.
- Atlas asks before it does anything that changes your files or system, unless you have turned that
  off. You choose which folders it may touch in Settings.

## Optional: a language model on your PC

Atlas answers open-ended questions through a model if you connect one. Nothing is sent anywhere for
local models.

1. Install [Ollama](https://ollama.com).
2. In Atlas: **Settings → Intelligence → Local Models**, turn on **Use local models**.
3. Install a model, for example in a terminal: `ollama pull qwen3:8b` (about 5 GB, the default).
   Larger optional models (GPT-OSS 20B, Qwen3-30B, Qwen3.5-35B) need a powerful PC.
4. Press **Refresh** in Atlas. A model can only be chosen once Ollama confirms it is installed.

Cloud models (OpenAI-style, Anthropic, Gemini) can be added in the same place with your own API key.
Keys are kept in Windows Credential Manager, never in Atlas's settings file.

## Optional: a Nova Account

A Nova Account is one sign-in across Nova products. Atlas works fully without it. To sign in:
**Settings → Account → Sign in to Nova**, then approve the code shown in your browser. Atlas never
asks for your password. To change your name, picture, email or password, use the buttons there.

## Updates

Atlas checks for updates about 20 seconds after it starts and every few hours while it runs. You can
check yourself in **Settings → About → Check for updates**. An update downloads, is verified against a
checksum, and installs when you say so.

> Older builds (0.85.x and earlier) do not have automatic updates. Install 1.0.0 by hand once; from
> then on it updates itself.

## Where things are stored

| | |
| --- | --- |
| Settings, memory, notes | `%APPDATA%\dev.atlas.assistant\` |
| API keys | Windows Credential Manager |
| The program | `%LOCALAPPDATA%\Programs\Atlas\` |

## Uninstall

**Settings → Apps → Atlas → Uninstall**. Your settings in `%APPDATA%\dev.atlas.assistant\` are kept
so a reinstall picks up where you left off; delete that folder to remove them too.

## Get help

- Support and tickets: <https://nova-help.17sh8dy.workers.dev/help/atlas>
- Discord: <https://discord.gg/XBhER9Z6EB>
- Source and issues: <https://github.com/17sh8dy/Atlas>
