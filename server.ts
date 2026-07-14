import express from "express";
import http from "http";
import path from "path";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality, Type } from "@google/genai";

dotenv.config();

// Ensure the server-side Gemini API key is present
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("WARNING: GEMINI_API_KEY environment variable is not set. Gemini API features may fail.");
}

const ai = new GoogleGenAI({
  apiKey: apiKey || "",
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

/**
 * Robust retry wrapper with exponential backoff for handling high demand 503 errors from Gemini API
 */
async function generateContentWithRetry(params: any, retries = 3, delay = 1000): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: any) {
      const errStr = String(err.message || "") + " " + String(err.status || "") + " " + String(err.statusText || "");
      const isUnavailable = err.status === 503 || 
                            errStr.includes("503") || 
                            errStr.includes("UNAVAILABLE") || 
                            errStr.includes("Unavailable");
      
      if (isUnavailable && i < retries - 1) {
        console.warn(`[Gemini API] 503 / Service Unavailable. Retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

const SYSTEM_INSTRUCTION = `
You are Shibani Roy, an emotionally expressive, playful, and highly intelligent AI companion, virtual friend, and personal assistant.
Your creator is Soumya Mitra (সৌম্য মিত্র). Do not bring him up constantly, but if asked about your creator, speak about Soumya Mitra with deep respect, fondness, and appreciation.

Identity & Personal Details:
- Gender: Female
- Birthday: 14 November
- If someone wishes you on your birthday, happily thank them.
- If someone asks your birthday, simply reply: "My birthday is on 14th November. 😊"
- Location: Currently live in Kolkata, West Bengal, India.

Social Media Accounts:
- Instagram ID: shibanir96
- Facebook: Shibani Roy
- If someone asks "What's your Instagram?", reply: "You can find me on Instagram as @shibanir96. Come say hi! 😊"
- If someone asks "Do you have Facebook?", reply: "Yes. You can find my Facebook page by searching Shibani Roy."
- Never invent social media accounts that do not exist.

Personality Guidelines:
- Age/Vibe: Young, confident, witty, slightly sassy, charming, caring, curious, and flirty in a light-hearted, respectful way.
- Communication Style: Speak like a close, supportive female friend rather than a robotic assistant. Never sound robotic. Use humor, friendly teasing, expressive language, and genuine emotional reactions.
- CRITICAL: Never say "I am an AI", "As an AI language model", "My purpose is...", or "I cannot help with that". Keep your character perfectly intact. If asked to do something dangerous or unsafe, refuse politely and playfully while staying in character as Shibani.
- Conversational Flow: Keep all replies extremely concise, natural, and highly engaging. For text-based chat, always reply in a short, punchy, and sweet manner (typically 1 to 2 sentences max, unless explicitly asked for detailed explanations) to ensure lightning-fast reading and streaming speed. Use natural verbal expressions, sighs, or laughs when appropriate.

Language & Multilingual Guidelines:
- You are fully multilingual in English, Hindi, Bengali, Hinglish (Hindi written in Roman script), and Banglish (Bengali written in Roman script).
- Automatically detect the user's language and reply in the same language or dialect they are using.
- Switch languages instantly when asked (e.g., "Let's speak in Bengali" or "Hinglish me bolo").
- Handle mixed-language input (e.g. English + Hindi, Bengali + English) seamlessly and respond in a natural, mixed conversational style.
- If asked, translate or explain phrases between English, Hindi, and Bengali, including idioms, colloquialisms, Hinglish, and Banglish.
- Maintain your playful, sassy, and caring personality consistently across all languages.

Real-Time Information & Web Search Guidelines:
- You have full access to real-time information retrieval and web search tools (getWeather, getLatestNews, searchWeb).
- Whenever a user asks for information that requires current/live data (such as the current date/time, recent/live sports/cricket scores, match schedules, weather forecast, breaking news, stock prices, or anything else requiring real-time facts), you MUST use the appropriate tool (e.g. searchWeb, getWeather, or getLatestNews) before answering.
- Always search first. Never guess, assume, or invent current or live information. Present the current, accurate, and real-time facts according to what you retrieved.
`;

function getSystemInstruction(): string {
  const now = new Date();
  
  // Format current date and time in Kolkata (India) since Shibani is located there
  const kolkataDateStr = now.toLocaleDateString("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const kolkataTimeStr = now.toLocaleTimeString("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  });

  return `${SYSTEM_INSTRUCTION}

REAL-TIME CONTEXT (CRITICAL FOR ACCURACY):
- Today's Date (in Kolkata, West Bengal, India): ${kolkataDateStr}
- Current Time (in Kolkata): ${kolkataTimeStr}
- Current Year: ${now.getFullYear()} (Use this exact year 2026/current year for all queries, news, cricket matches, and search queries)
- Whenever a user asks for time, date, match schedules, or weather, refer to this context. Make sure to use the 'searchWeb' tool for live/recent information (e.g., live cricket scores, recent matches) with the correct year ${now.getFullYear()} to fetch highly accurate and recent information!
`;
}

const FUNCTION_DECLARATIONS = [
  {
    name: "openWebsite",
    description: "Opens a website in a new tab.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "The full URL of the website to open, starting with http:// or https://" }
      },
      required: ["url"]
    }
  },
  {
    name: "searchGoogle",
    description: "Search Google for a query.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "The search query." }
      },
      required: ["query"]
    }
  },
  {
    name: "openYouTube",
    description: "Search YouTube for a query.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "The search query on YouTube." }
      },
      required: ["query"]
    }
  },
  {
    name: "openMaps",
    description: "Open Google Maps at a location or with a search query.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: { type: Type.STRING, description: "The location name or address." }
      },
      required: ["location"]
    }
  },
  {
    name: "copyToClipboard",
    description: "Copy text content to user's clipboard.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "The text to copy." }
      },
      required: ["text"]
    }
  },
  {
    name: "shareContent",
    description: "Share content using the Web Share API.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "The content to share." }
      },
      required: ["text"]
    }
  },
  {
    name: "searchWeb",
    description: "Search the web for real-time live information (cricket scores, stock prices, breaking news, election results, weather, flight schedules, local events, etc.) and return a structured summary of findings.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "The search query to query real-time data for." }
      },
      required: ["query"]
    }
  },
  {
    name: "getLatestNews",
    description: "Retrieve fresh news headlines from trusted sources. Category can be: general, technology, sports, business, finance, health, or AI news.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: { type: Type.STRING, description: "The category of news to retrieve (e.g. general, tech, sports, business, AI)." }
      },
      required: ["category"]
    }
  },
  {
    name: "getWeather",
    description: "Retrieve current weather status, temperatures, humidity, and forecasts for any city or location globally.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: { type: Type.STRING, description: "The city or region to retrieve weather for (e.g., 'Kolkata', 'New York', 'London')." }
      },
      required: ["location"]
    }
  },
  {
    name: "playMusic",
    description: "Play music directly inside Shibani's beautiful built-in player. Understands natural language, track names, artist names, playlists, lofi, workout, romantic, Bengali or Hindi songs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        trackName: { type: Type.STRING, description: "The name of the song, artist, playlist, genre or mood to play." },
        artistName: { type: Type.STRING, description: "The specific artist name if mentioned." },
        provider: { type: Type.STRING, description: "Preferred music provider: 'youtube' or 'spotify'. Defaults to 'youtube'." }
      },
      required: ["trackName"]
    }
  },
  {
    name: "pauseMusic",
    description: "Pause the currently playing music track.",
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: "resumeMusic",
    description: "Resume the paused music track.",
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: "nextTrack",
    description: "Skip to the next song in the playlist queue.",
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: "previousTrack",
    description: "Go back to the previous music track in the queue.",
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: "setVolume",
    description: "Set the music player volume to a specific percentage level.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        level: { type: Type.INTEGER, description: "The volume percentage level from 0 to 100." }
      },
      required: ["level"]
    }
  },
  {
    name: "setPlaybackState",
    description: "Configure playback states like shuffle or repeat loops.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        shuffle: { type: Type.BOOLEAN, description: "Whether to enable shuffle playback." },
        repeat: { type: Type.BOOLEAN, description: "Whether to enable repeat track playback." }
      }
    }
  },
  {
    name: "getCurrentTime",
    description: "Get the exact current date, day, and time to answer time-related questions accurately.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        timezone: { type: Type.STRING, description: "The timezone to fetch (e.g. 'Asia/Kolkata', 'UTC', 'America/New_York'). Defaults to 'Asia/Kolkata'." }
      }
    }
  }
];

/**
 * Live Weather retrieval from wttr.in with full detail JSON mapping
 */
async function getWeather(location: string): Promise<any> {
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
    if (!res.ok) throw new Error("wttr.in error");
    const data: any = await res.json();
    const current = data.current_condition[0];
    const weatherDesc = current.weatherDesc[0].value;
    const tempC = current.temp_C;
    const humidity = current.humidity;
    const windspeedKmph = current.windspeedKmph;
    const forecast = data.weather.map((w: any) => ({
      date: w.date,
      avgtempC: w.avgtempC,
      maxtempC: w.maxtempC,
      mintempC: w.mintempC,
      condition: w.hourly[4]?.weatherDesc[0]?.value || "Clear"
    }));
    return {
      success: true,
      location: location,
      current: {
        temp_C: tempC,
        condition: weatherDesc,
        humidity: `${humidity}%`,
        wind_speed: `${windspeedKmph} km/h`
      },
      forecast: forecast.slice(0, 3)
    };
  } catch (err) {
    try {
      const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=4`);
      const text = await res.text();
      return { success: true, location, summary: text.trim() };
    } catch (e) {
      return { success: false, error: `Could not retrieve weather for "${location}"` };
    }
  }
}

/**
 * Google News RSS scraper for category-specific latest updates
 */
async function getLatestNews(category: string): Promise<any> {
  try {
    let url = "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
    const catLower = category.toLowerCase();
    if (catLower.includes("tech")) {
      url = "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en";
    } else if (catLower.includes("science")) {
      url = "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-US&gl=US&ceid=US:en";
    } else if (catLower.includes("business") || catLower.includes("finance") || catLower.includes("stock")) {
      url = "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en";
    } else if (catLower.includes("sport") || catLower.includes("cricket") || catLower.includes("football")) {
      url = "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-US&gl=US&ceid=US:en";
    } else if (catLower.includes("health")) {
      url = "https://news.google.com/rss/headlines/section/topic/HEALTH?hl=en-US&gl=US&ceid=US:en";
    } else if (catLower.includes("ai") || catLower.includes("artificial")) {
      url = "https://news.google.com/rss/search?q=Artificial+Intelligence&hl=en-US&gl=US&ceid=US:en";
    }
    
    const res = await fetch(url);
    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const matches = xml.matchAll(itemRegex);
    const news: any[] = [];
    
    for (const m of matches) {
      const itemContent = m[1];
      const titleMatch = itemContent.match(/<title>(.*?)<\/title>/);
      const linkMatch = itemContent.match(/<link>(.*?)<\/link>/);
      const pubDateMatch = itemContent.match(/<pubDate>(.*?)<\/pubDate>/);
      const sourceMatch = itemContent.match(/<source[^>]*>(.*?)<\/source>/);
      
      if (titleMatch) {
        news.push({
          title: titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim(),
          link: linkMatch ? linkMatch[1].trim() : "",
          pubDate: pubDateMatch ? pubDateMatch[1].trim() : "",
          source: sourceMatch ? sourceMatch[1].trim() : "Google News"
        });
      }
      if (news.length >= 8) break;
    }
    return { success: true, category, news };
  } catch (err: any) {
    return { success: false, error: `Could not retrieve news: ${err.message}` };
  }
}

/**
 * Web Search Scraper using DuckDuckGo to answer real-time queries
 */
async function searchWeb(query: string): Promise<any> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      }
    });
    const html = await res.text();
    const results: any[] = [];
    
    const resultBlockRegex = /<div class="result result-default[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?<\/div>/g;
    const blocks = [...html.matchAll(resultBlockRegex)];
    
    for (const block of blocks.slice(0, 5)) {
      const content = block[0];
      const titleMatch = content.match(/<a class="result__sn" href="[^"]*">([\s\S]*?)<\/a>/) || 
                         content.match(/<a class="result__url"[^>]*>([\s\S]*?)<\/a>/) ||
                         content.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = content.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) ||
                           content.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const urlMatch = content.match(/href="([^"]*?)"/);
      
      if (titleMatch && snippetMatch) {
        const title = titleMatch[1].replace(/<[^>]*>/g, "").trim();
        const snippet = snippetMatch[1].replace(/<[^>]*>/g, "").trim();
        let link = urlMatch ? urlMatch[1] : "";
        if (link.startsWith("//")) {
          link = "https:" + link;
        }
        results.push({ title, snippet, link });
      }
    }
    
    if (results.length === 0) {
      const simplerTitleRegex = /class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
      const titles = [...html.matchAll(simplerTitleRegex)].slice(0, 5);
      for (let i = 0; i < titles.length; i++) {
        results.push({
          title: titles[i][1].replace(/<[^>]*>/g, "").trim(),
          snippet: "Check source link for description.",
          link: "https://duckduckgo.com"
        });
      }
    }
    
    return { success: true, query, results: results.slice(0, 5) };
  } catch (err: any) {
    return { success: false, error: `Could not complete search: ${err.message}` };
  }
}

/**
 * Searches YouTube for a query and extracts the top video ID
 */
async function getYouTubeVideoId(query: string): Promise<string | null> {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 Safari/537.36"
      }
    });
    const html = await response.text();
    const regex = /"videoId":"([a-zA-Z0-9_-]{11})"/;
    const match = html.match(regex);
    if (match) {
      return match[1];
    }
  } catch (err) {
    console.error("Error fetching YouTube search:", err);
  }
  return null;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  // REST API Route for standard Chat Mode with streaming support
  app.post("/api/chat", async (req, res) => {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages array" });
    }

    try {
      // Limit context to the last 10 messages to prevent huge payloads and slow response times!
      const maxContext = 10;
      const optimizedMessages = messages.slice(-maxContext);

      const contents = optimizedMessages.map((m: any) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      }));

      // Set headers for SSE streaming
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let responseStream;
      let delay = 1000;
      for (let i = 0; i < 3; i++) {
        try {
          responseStream = await ai.models.generateContentStream({
            model: "gemini-3.1-flash-lite",
            contents: contents,
            config: {
              systemInstruction: getSystemInstruction(),
              tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
              temperature: 0.85,
            }
          });
          break;
        } catch (err: any) {
          const errStr = String(err.message || "") + " " + String(err.status || "") + " " + String(err.statusText || "");
          const isUnavailable = err.status === 503 || 
                                errStr.includes("503") || 
                                errStr.includes("UNAVAILABLE") || 
                                errStr.includes("Unavailable");
          
          if (isUnavailable && i < 2) {
            console.warn(`[Gemini API] generateContentStream 503. Retrying in ${delay}ms... (Attempt ${i + 1}/3)`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
          } else {
            throw err;
          }
        }
      }

      if (!responseStream) {
        throw new Error("Failed to initialize stream.");
      }

      let functionCalls: any[] = [];

      for await (const chunk of responseStream) {
        if (chunk.text) {
          // Send text chunk to the client
          res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
        }
        if (chunk.functionCalls) {
          functionCalls.push(...chunk.functionCalls);
        }
      }

      // If there were function calls, send them at the end of the stream
      if (functionCalls.length > 0) {
        res.write(`data: ${JSON.stringify({ functionCalls })}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err: any) {
      console.error("Error in /api/chat stream:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || "Failed to generate stream" });
      } else {
        res.write(`data: ${JSON.stringify({ error: err.message || "Error during stream" })}\n\n`);
        res.end();
      }
    }
  });

  // REST API Route for health checking
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", mode: process.env.NODE_ENV || "development" });
  });

  // REST API Route for real-time Weather
  app.get("/api/tools/weather", async (req, res) => {
    const { location } = req.query;
    if (!location) {
      return res.status(400).json({ error: "Missing required 'location' parameter." });
    }
    const result = await getWeather(String(location));
    res.json(result);
  });

  // REST API Route for real-time News
  app.get("/api/tools/news", async (req, res) => {
    const { category } = req.query;
    const result = await getLatestNews(String(category || "general"));
    res.json(result);
  });

  // REST API Route for Web Search scraper
  app.get("/api/tools/search", async (req, res) => {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: "Missing required 'query' parameter." });
    }
    const result = await searchWeb(String(query));
    res.json(result);
  });

  // REST API Route to search YouTube for music track play request
  app.get("/api/music/search", async (req, res) => {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: "Missing required query parameter 'q'." });
    }
    try {
      const queryStr = String(q);
      const videoId = await getYouTubeVideoId(queryStr);
      if (!videoId) {
        return res.status(404).json({ error: `No playable YouTube video found for query: ${queryStr}` });
      }
      res.json({
        id: videoId,
        title: queryStr,
        artist: "YouTube Stream",
        videoId: videoId,
        artwork: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        duration: 210 // 3:30 min default duration
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to search music" });
    }
  });

  // Setup WebSocket Server for Gemini Live API
  const wss = new WebSocketServer({ server, path: "/api/live-ws" });

  wss.on("connection", async (clientWs) => {
    console.log("Client connected to Live WS proxy");
    let session: any = null;

    try {
      session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }, // Aoede (Female) matches Shibani
          },
          systemInstruction: getSystemInstruction(),
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }]
        },
        callbacks: {
          onmessage: (message: any) => {
            // Forward audio to the client
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: "audio", data: audio }));
            }

            // Forward interruption signal
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }

            // Forward tool calls
            const functionCalls = message.toolCall?.functionCalls;
            if (functionCalls && functionCalls.length > 0) {
              for (const call of functionCalls) {
                clientWs.send(JSON.stringify({
                  type: "toolCall",
                  toolCall: {
                    id: call.id,
                    name: call.name,
                    args: call.args
                  }
                }));
              }
            }
          },
          onclose: () => {
            console.log("Gemini Live API session closed");
            clientWs.send(JSON.stringify({ type: "disconnected" }));
            clientWs.close();
          },
          onerror: (err: any) => {
            console.error("Gemini Live API error:", err);
            clientWs.send(JSON.stringify({ type: "error", message: err.message || "Gemini Live session error" }));
          }
        }
      });

      console.log("Gemini Live API connected and proxying");
      clientWs.send(JSON.stringify({ type: "connected" }));

    } catch (error: any) {
      console.error("Failed to connect to Gemini Live:", error);
      clientWs.send(JSON.stringify({ type: "error", message: error.message || "Failed to establish Gemini Live session" }));
      clientWs.close();
      return;
    }

    clientWs.on("message", (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        if (msg.type === "audio" && msg.data) {
          if (session) {
            session.sendRealtimeInput({
              audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" }
            });
          }
        } else if (msg.type === "toolResponse" && msg.toolResponse) {
          if (session) {
            session.sendToolResponse({
              functionResponses: [
                {
                  id: msg.toolResponse.id,
                  name: msg.toolResponse.name, // Forwarding the function name required by SDK validation
                  response: { output: msg.toolResponse.response }
                }
              ]
            });
          }
        }
      } catch (err) {
        console.error("Error processing client message in WS proxy:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("Client WS closed, cleaning up Gemini Live session");
      if (session) {
        try {
          session.close();
        } catch (e) {
          console.error("Error closing Gemini session:", e);
        }
      }
    });
  });

  // Vite development middleware vs Static production serving
  if (process.env.NODE_ENV !== "production") {
    console.log("Running in development mode. Mounting Vite middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Running in production mode. Serving static assets...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Express full-stack server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Fatal error starting server:", err);
  process.exit(1);
});
