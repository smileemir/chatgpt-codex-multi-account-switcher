# Local setup

1. Install Node.js 22 or newer and the Codex CLI.
2. Run `npm install`, `npm run typecheck`, `npm test`, and `npm run build`.
3. Load `dist/extension` as an unpacked Chrome extension.
4. Register the native host for the extension ID and create the local `config/install.json` containing that ID. On Windows also include a 64-character `serviceSecret`.
5. Open the extension options page, connect accounts, choose a workspace and common model, then create a session.

Use `CODEX_SWITCHER_DATA_ROOT` to point tests or a development run at an isolated data directory. Use `CODEX_SWITCHER_CODEX_EXECUTABLE` to select a non-default Codex CLI path.
