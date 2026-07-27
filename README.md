# Shibani Roy - Real-Time AI Companion 💖

Shibani Roy is a full-stack, real-time AI companion, virtual friend, and personal assistant built using Express, Vite, React 19, Tailwind CSS, and the Google Gemini API. 

She features a distinctive, young, witty, and engaging virtual persona designed to feel like a close friend rather than a robotic assistant.

---

## 🚀 Real Features

1. **Voice Mode (Live API)**:
   - Powered by **Gemini Live API** (`gemini-3.1-flash-live-preview`) using the `@google/genai` SDK with the prebuilt `Aoede` voice.
   - Low-latency, bi-directional audio streaming over WebSocket (`/api/live-ws`) with 16kHz PCM input and 24kHz PCM output.
   - High-fidelity **Web Audio API** scheduling for gapless playback with active noise buffer.
   - Real-time dynamic visualizers reacting to microphone and speaker volumes.
   - Instant interruption handling when the user speaks or interruptions are signaled.

2. **Streaming Chat Mode**:
   - Powered by **Gemini 3.1 Flash Lite** (`gemini-3.1-flash-lite`) via streaming server endpoints (`/api/chat`).
   - Integrated function calling with safe context slicing to prevent orphaned call-response pairs.
   - Quick reply suggestion tags, typing indicator, and safe custom Markdown processor.

3. **Long-Term & Short-Term Memory**:
   - Automatic extraction and storage of facts and user context into Supabase (`memories` table).
   - In-memory fallback mechanism when Supabase database is disconnected.
   - Memory recall integrated into both Voice and Chat system instructions.

4. **Fal.ai Consistent Image Generation**:
   - Dedicated endpoint (`/api/tools/generate-image`) utilizing Fal.ai with FLUX LoRA models for generating consistent portrait photos of Shibani.
   - 800-character input verification, image rate limiters, and rate quota enforcement.

5. **Built-In YouTube Music Player**:
   - Interactive music search endpoint (`/api/music/search`) resolving track requests to playable YouTube video streams.
   - Embedded audio player with playback controls, volume slider, and track progress bar.

6. **Telegram Bot Channel**:
   - Full webhook integration (`/telegram/webhook`) allowing users to chat with Shibani directly via Telegram.
   - Shares system instructions, persona configuration, and Supabase memory integration.

7. **Avatar System & Look Gallery**:
   - Externally hosted look images (`look-1.jpg` through `look-8.jpg` on Supabase Storage).
   - Canvas display mode and avatar gallery switcher.

8. **Theme Customization**:
   - Built-in visual themes: **Midnight**, **Rose**, **Cyberpunk**, **Dark**, and **Sunset**.

9. **Free-Tier Daily Usage Limits & Admin Bypass**:
   - Fair-use rate limits per user: max **5 image generations/day** and max **30 tool calls/day** (calculated daily in `Asia/Kolkata` timezone).
   - Usage tracked in Supabase (`user_usage` table) with in-memory fallback.
   - Friendly HTTP 429 notifications dispatched to the UI.
   - Admin bypass (`isAdmin`) configured for unlimited administrative usage.

10. **Production Security**:
    - Express server configured with `helmet` security headers, strict origin CORS configuration, 1MB JSON body payload limiters, and `express-rate-limit`.
    - Integrated Sentry error monitoring and full server-side API key protection (`GEMINI_API_KEY` is never exposed to the client).

---

## 🛠️ Folder Structure

```text
/
├── server.ts                  # Full-stack Express server, WebSocket proxy, and API routes
├── telegram.ts                # Telegram Bot webhook & message handling logic
├── index.html                 # Main SPA HTML file
├── package.json               # Dependencies and build scripts
├── metadata.json              # Applet capabilities & permissions
├── src/
│   ├── main.tsx               # React application entry point
│   ├── App.tsx                # Master UI layout & coordinator
│   ├── types.ts               # Shared TypeScript definitions
│   ├── components/
│   │   ├── Header.tsx         # Navigation header, mode switcher, and theme controls
│   │   ├── VoiceVisualizer.tsx# Audio waveforms, avatar avatar display, and microphone button
│   │   ├── ChatWindow.tsx     # Messenger chat UI and quick reply chips
│   │   ├── MusicPlayer.tsx    # YouTube music playback component
│   │   └── LookGallery.tsx    # Avatar look switcher modal
│   ├── hooks/
│   │   └── useVoiceConnection.ts # Web Audio API & Live WebSocket pipeline
│   ├── services/
│   │   └── ToolExecutor.ts    # Client-side tool & proxy request handler
│   └── utils/
│       ├── audioUtils.ts      # Audio format conversions (PCM16 / Float32)
│       └── userId.ts          # Unique user session identification helpers
```

---

## ⚙️ Environment Variables & Setup

### Required Environment Variables

Define the following environment variables in your server configuration or `.env` file:

```env
# Gemini API Key (Server-side only)
GEMINI_API_KEY="your-gemini-api-key"

# Supabase Credentials (Optional for persistence, falls back to in-memory)
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_KEY="your-supabase-key"

# Fal.ai Image Generation (Required for /api/tools/generate-image)
FAL_API_KEY="your-fal-api-key"
FAL_LORA_PATH="your-fal-lora-model-path"

# Telegram Bot (Required for Telegram Webhook)
TELEGRAM_BOT_TOKEN="your-telegram-bot-token"

# Application Security & Monitoring (Optional)
APP_URL="https://your-app-domain.com"
SENTRY_DSN="your-sentry-dsn"
```

---

## 🗄️ Supabase Database Schema

To enable persistent memories and daily usage quotas, run the following DDL in your Supabase SQL Editor:

```sql
-- Long-term memories table
CREATE TABLE IF NOT EXISTS memories (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily free usage tracking table
CREATE TABLE IF NOT EXISTS user_usage (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD (Asia/Kolkata timezone)
  images_generated INT DEFAULT 0,
  voice_minutes INT DEFAULT 0,
  tool_calls INT DEFAULT 0,
  chat_messages INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);
```

---

## 🏁 Running the Application

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Development Server
```bash
npm run dev
```
The server will start on `http://localhost:3000` with full-stack Express and Vite middleware.

### 3. Build & Production Start
```bash
npm run build
npm start
```
`npm run build` bundles client assets with Vite and compiles `server.ts` into a self-contained `dist/server.cjs` via esbuild.

---

## 💡 Pricing & Quota Note

- **Web App**: Free to use with daily limits (**50 chat messages**, **5 image generations**, and **30 tool calls** per day).
- **Telegram Bot**: Available as a free public channel for conversing with Shibani.
