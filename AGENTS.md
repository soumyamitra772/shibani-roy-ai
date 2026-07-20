# Agent Guidelines and Project Rules

These are persistent guidelines and rules for any AI agent working on this repository.

## 🌟 Avatar Images (Hosted Externally)

- Shibani Roy's avatar look images (`look-1.jpg` through `look-8.jpg`) are hosted completely externally on Supabase Storage and are NOT part of this repository:
  `https://lkxxnumhlcdbqknmulmu.supabase.co/storage/v1/object/public/avatars/`
- Since there are no local asset folders or image files for the avatar inside the repository, there is no risk of future commits modifying, corrupting, or trying to "optimize" them. Do not re-add any local image file variants to this codebase.

## 🛠️ Dev Server & Environment

- The application uses a custom full-stack Express server (`server.ts`) integrated with Vite for development and built to `dist/server.cjs` for production.
- Port: `3000` is the only externally accessible port.
- Any server changes require restarting the dev server via `restart_dev_server`.
