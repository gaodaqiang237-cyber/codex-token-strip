# Codex Token Strip

[简体中文](README.md) · Windows x64 · MIT

A small independent floating status strip for the official Codex desktop window: **session API-equivalent cost and tokens, all-local cost, estimated output tok/s, and input cache hit rate**. Drag it under the composer or anywhere within the window.

![Native strip with fictional demonstration data](docs/preview.png)

The utility does not patch Codex, inject code, or require an API key. It makes no outbound network requests and has no telemetry. It is not an official OpenAI plugin.

## Run

Requires Windows 10/11 x64, .NET Framework 4.8, and Node.js 22+. Window detection currently supports the Microsoft Store installation of Codex. Tested with Codex `26.1013.4894.0`; its internal log format may change.

Download and fully extract the Windows ZIP from [Releases](https://github.com/gaodaqiang237-cyber/codex-token-strip/releases), then double-click `app/overlay/TokenStrip.exe`. Keep the other files beside it. Switch to Codex, drag the strip into position, and right-click for theme/position/exit controls. A custom Node installation can be discovered and saved by running `node scripts/launch.cjs`.

The executable is built from this repository and is unsigned. It does not change the signature of your Codex installation.

## Build from source

```sh
git clone https://github.com/gaodaqiang237-cyber/codex-token-strip.git
cd codex-token-strip
npm test
npm run build
npm start
```

No `npm install` is needed: the backend and build scripts use Node standard-library modules only. Windows builds use the system .NET Framework C# compiler. `npm stop` exits this strip; an unused backend exits after about 15 minutes. `npm run package` produces a ZIP and SHA-256 checksum in `dist/` using a fixed release-file allowlist.

## Accounting and limitations

- Dollars estimate public API token cost; they are **not subscription charges, remaining credit, or a weekly allowance**. Total covers readable local sessions and archives, including the current session. It does not cover all devices or cloud usage.
- Input, cached input, cache writes and output are priced separately. Cached input is already part of input; reasoning is already part of output. Response IDs are deduplicated across forks/archives. Missing service tiers assume Standard. Unknown prices and incomplete records are disclosed, not silently priced at zero. `≥$` means a partial known minimum.
- Rates and long-context/speed assumptions live in [`app/pricing.json`](app/pricing.json), checked on 2026-10-19 against [API pricing](https://developers.openai.com/api/docs/pricing). Rates require manual maintenance; they do not describe subscription usage multipliers.
- Speed is an estimate for the latest completed response, updated after completion. Its timing can include reasoning/waiting. It is not a live decoding-token counter. Cache hit is the latest cached input divided by latest input.
- Active-chat detection tails `ownerRoutePath` navigation metadata in desktop diagnostic logs. This is an undocumented internal format, not a stable extension API. Some versions emit this event alongside built-in browser sidebar synchronization: try opening an in-app browser tab and switching chats if binding is absent. Missing/ambiguous events fail closed.
- Cloud chats without local usage records show unavailable usage. Multiple indistinguishable primary windows, remote sessions, and older log formats can lack metrics. No extra context-usage circle is drawn.

## Local data

Reads `%USERPROFILE%/.codex/sessions`, `archived_sessions`, and Microsoft Store Codex's desktop logs. `CODEX_HOME` can override the session root. It reads log bytes and may parse message events for response timing, but does not store message bodies or expose them over HTTP. It does not read `auth.json`.

Settings, error logs and runtime diagnostics go to `%LOCALAPPDATA%/CodexTokenStrip/`. These may include paths, process IDs, chat IDs and aggregate usage: **redact them before reporting an issue**. Do not upload credentials or session files. The backend binds to `127.0.0.1:23957` with Host/Origin checks; other local processes can still access this port. Do not expose it to your network.

Copy `settings.example.json` to that local data directory as `settings.json` to customize Node path, port and log roots after exiting the strip. For isolated development use `CODEX_TOKEN_STRIP_DATA_DIR` and `CODEX_TOKEN_STRIP_PORT`.

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and [MIT License](LICENSE). Not affiliated with or endorsed by OpenAI.
