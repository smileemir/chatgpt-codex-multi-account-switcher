# ChatGPT Codex Multi Account Switcher

Local-first ChatGPT/Codex multi-account switching for coding sessions. Connect multiple ChatGPT accounts, keep a persistent Codex thread in a local SQLite store, and switch the active account after a usage-limit response without losing the conversation transcript.

## Why this exists

The switcher separates two things that are often confused:

- Account authentication and usage limits belong to the selected ChatGPT account.
- Conversation continuity belongs to the local session record: workspace, model, provider thread ID, turns, assistant text, events, approvals, and account pool.

When account A reaches a limit, the current turn is never blindly replayed after a side effect. If no side effect started, the manager can retry the logical turn on the next connected account. If a command or tool started, the session pauses and asks for an explicit decision. Switching to B or C resumes the saved provider thread and keeps the transcript visible.

## Features

- ChatGPT/Codex OAuth account connections with private local credentials.
- Account pools per coding session (A → B → C order).
- Persistent local SQLite sessions and provider thread IDs.
- Safe usage-limit failover with side-effect protection.
- Account-scoped model discovery and common-model validation.
- Approval requests, activity events, interrupt support, and session recovery after restart.
- Chrome extension dashboard plus a local native host over a permissioned socket.
- English and Turkish UI.

## Important boundary

This project does not merge provider quotas or bypass a provider limit. It only selects another account that the user has explicitly connected. OpenAI may change Codex authentication, model availability, or usage-limit behavior; verify current behavior against official documentation before production use. This project is independent and is not affiliated with OpenAI.

## Development

Requirements: Node.js 22+, npm, Chrome/Chromium, and the Codex CLI available on the host machine.

```bash
npm install
npm run typecheck
npm test
npm run build
```

`dist/extension` is the unpacked extension directory. `dist/native` contains the bundled native bridge and service. A production installer must register the generated native-messaging manifest with the extension ID and write `config/install.json` under the platform data directory.

## Data and security

Data is local-first. Credentials are stored in an owner-only file under the application data directory, the SQLite database is created with restrictive permissions, and the native bridge verifies the calling extension origin. The native service accepts only the Codex command set defined in `packages/contracts`.

See [docs/codex-continuity.md](docs/codex-continuity.md) for the session state machine and [docs/setup.md](docs/setup.md) for development setup.

## Search terms

ChatGPT multi account, Codex multi account, ChatGPT account switcher, Codex account switcher, ChatGPT usage limit failover, Codex session continuity, local-first OAuth account manager, Chrome extension for coding sessions.

## License

MIT © 2026 smileemir. See [LICENSE](LICENSE).
