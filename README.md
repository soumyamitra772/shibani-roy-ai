# Shibani Roy - Real-Time AI Companion 💖

Shibani Roy is a production-ready, highly expressive, real-time AI companion, virtual friend, and personal assistant built with the modern full-stack Express + Vite + React ecosystem. 

She features a distinctive, young, witty, slightly sassy, and flirty virtual persona designed to sound like a close female friend rather than a robotic assistant.

---

## 🚀 Key Features

1. **Voice Mode (Primary)**:
   - Powered by **Gemini Live API** (`gemini-3.1-flash-live-preview`).
   - Full-duplex continuous low-latency audio streaming (**16kHz PCM input** and **24kHz PCM output**).
   - High-fidelity **Web Audio API** scheduling for gapless playback with active noise/jitter buffer.
   - **Interruption Handling**: Instant sound cancellation when the user speaks or interruptions are signaled.
   - Dynamic SVG visualizer equalizers responding to microphone/speaker decibel volumes.

2. **Chat Mode**:
   - High-fidelity messenger style layout.
   - Powered by **Gemini 3.5 Flash** for rapid text generation.
   - Custom-engineered lightweight **Markdown renderer** (safe from XSS).
   - Animated typing indicator, timestamps, quick reply suggestion tags, and clear/new chat triggers.

3. **Multilingual Speech Detection**:
   - Fluent conversational support in **English**, **Hindi (Devanagari)**, **Bengali (বাংলা)**, **Hinglish**, and **Banglish**.
   - Auto-detects input language and shifts immediately. Supports seamless mixed-language query understanding.

4. **Interactive Tool Execution (Function Calling)**:
   - **`openWebsite(url)`**: Safe client-side tab execution for browsers.
   - **`searchGoogle(query)`**: Opens standard Google Search query.
   - **`openYouTube(query)`**: Search query on YouTube.
   - **`openMaps(location)`**: Direct Google Maps lookup.
   - **`copyToClipboard(text)`**: Immediate custom write-text pipeline.
   - **`shareContent(text)`**: Integrated Web Share API with clipboard fallback.
   - Tool calls execute synchronously and append automated tool history logs directly into Chat history.

5. **Security First**:
   - The server handles all `@google/genai` WebSocket and REST configurations.
   - **The `GEMINI_API_KEY` is never exposed to the client browser.**

---

## 🛠️ Architecture & Folder Structure

```text
/
├── server.ts              # Full-stack entry point (Express + ws WebSocket proxy + Vite Dev Server)
├── index.html             # Client SPA HTML layout
├── package.json           # Application dependencies & esbuild scripts
├── metadata.json          # AI Studio permissions & capability declarations
├── src/
│   ├── main.tsx           # React mounting entry point
│   ├── App.tsx            # Master UI Coordinator
│   ├── types.ts           # App-wide shared types
│   ├── index.css          # Tailwind CSS global styles
│   ├── components/
│   │   ├── Header.tsx           # Mode slider, connection indicators, creator credit
│   │   ├── VoiceVisualizer.tsx  # Equalizer waveforms, glowing core avatar, mic control
│   │   ├── ChatWindow.tsx       # Message list, quick replies, messenger input
│   │   └── Markdown.tsx         # Hand-crafted secure Markdown processor
│   ├── hooks/
│   │   └── useVoiceConnection.ts # Raw PCM voice engine, analyser nodes, ws bridges
│   ├── services/
│   │   └── ToolExecutor.ts      # Client-side actions runner (maps, search, sharing)
│   └── utils/
│       └── audioUtils.ts        # Float32 to PCM16 encoding and Base64 decoding
```

---

## ⚙️ Setup & Installation

### Prerequisites
- Node.js (v18+)
- npm

### 1. Configure Secrets
Ensure you have set up your `GEMINI_API_KEY` inside your environment or AI Studio Secrets manager.
For local testing, create a `.env` file at the root:
```env
GEMINI_API_KEY="your-gemini-api-key-here"
```

### 2. Install Dependencies
Run the package installation command to pull in all required core libraries (including React 19, Motion, and Express):
```bash
npm install
```

### 3. Run Development Server
Boot up the full-stack server. In development, Express will automatically mount the Vite middleware:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📦 Production Compilation & Deployment

To compile the application into a compact, production-ready full-stack bundle, execute:
```bash
npm run build
```
This script performs two operations:
1. Runs `vite build` to bundle client assets into `/dist`.
2. Runs `esbuild` to compile our `/server.ts` into a unified CommonJS file `/dist/server.cjs` (handling external modules automatically to bypass strict Node.js runtime pathing checks).

To spin up the production build, run:
```bash
npm run start
```
The application will run with maximum efficiency, low cold start lag, and peak security on port `3000`.
