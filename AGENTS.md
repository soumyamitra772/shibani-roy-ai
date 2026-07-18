# Agent Guidelines and Project Rules

These are persistent guidelines and rules for any AI agent working on this repository.

## ⚠️ CRITICAL: Static Asset Rules

- **Do NOT modify, regenerate, replace, or touch** any files inside the following directories:
  - `public/assets/avatar/`
  - `assets/avatar/`
- These directories contain manually-uploaded image files (`look-1.jpg` through `look-8.jpg`) that are managed directly by the user via GitHub.
- AI agents must treat them strictly as **read-only external assets** outside the project scope.
- You may reference them by path in code (e.g. `/assets/avatar/look-X.jpg`), but **never** write to, overwrite, delete, or modify their contents.

## 🛠️ Dev Server & Environment

- The application uses a custom full-stack Express server (`server.ts`) integrated with Vite for development and built to `dist/server.cjs` for production.
- Port: `3000` is the only externally accessible port.
- Any server changes require restarting the dev server via `restart_dev_server`.
