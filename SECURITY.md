# Security

This tool reads local usage and navigation logs and hosts a loopback-only HTTP service. It does not need API keys or upload data. Runtime diagnostics can contain local paths, chat IDs and usage totals; treat them as private.

Do not post exploitable vulnerabilities, credentials or raw session logs in public issues. Use GitHub's **Report a vulnerability** / private vulnerability reporting when available. If that option is unavailable, open an issue containing only a request for a private contact route, without exploit details or personal data.

Keep the service bound to `127.0.0.1`. Do not add public listening addresses or proxy it to a network. Host/Origin checks do not protect against software already running with access to your local account. Never turn a missing price or missing chat log into a fabricated complete value.

Only the current version is maintained. Codex internal log formats can change independently of this project.
