import "./instrument";
import * as Sentry from "@sentry/node";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { handleTelegramWebhook } from "./telegram";

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

// Initialize Supabase Client with graceful fallback for missing config
const rawSupabaseUrl = process.env.SUPABASE_URL || "";
const rawSupabaseKey = process.env.SUPABASE_KEY || "";

let supabaseUrl = rawSupabaseUrl.trim();
if (supabaseUrl.includes("/rest/v1")) {
  supabaseUrl = supabaseUrl.split("/rest/v1")[0];
}
supabaseUrl = supabaseUrl.replace(/\/+$/, "");

const supabaseKey = rawSupabaseKey.trim();

let supabase: any = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("Supabase client initialized successfully with sanitized URL:", supabaseUrl);
  } catch (err) {
    console.error("Error initializing Supabase client:", err);
  }
} else {
  console.warn("SUPABASE_URL or SUPABASE_KEY environment variables are missing. Memory feature will operate in-memory.");
}

interface MemoryItem {
  id?: string | number;
  user_id: string;
  fact: string;
  category: string;
  created_at: string;
}

// In-memory fallback database when Supabase is not yet configured
const inMemoryMemories: MemoryItem[] = [];

async function saveFactToDb(userId: string, fact: string, category: string): Promise<boolean> {
  const item: MemoryItem = {
    user_id: userId,
    fact,
    category: category || "general",
    created_at: new Date().toISOString()
  };

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("memories")
        .insert([item]);
      
      if (error) {
        if (error.code === "42P01") {
          console.warn("Supabase 'memories' table does not exist yet. Please create it in your Supabase SQL editor: CREATE TABLE memories (id SERIAL PRIMARY KEY, user_id TEXT, fact TEXT, category TEXT, created_at TIMESTAMPTZ);. Falling back to in-memory storage.");
        } else {
          console.warn("Supabase insert warning:", error.message || error);
          Sentry.captureException(new Error(`Supabase insert error: ${error.message || JSON.stringify(error)}`), { tags: { feature: "memory" } });
        }
        // Fallback to in-memory on database/table errors
        inMemoryMemories.push(item);
        return false;
      }
      return true;
    } catch (err) {
      console.warn("Failed to insert into Supabase, falling back to in-memory:", err);
      Sentry.captureException(err, { tags: { feature: "memory" } });
      inMemoryMemories.push(item);
      return false;
    }
  } else {
    inMemoryMemories.push(item);
    return true;
  }
}

async function recallFactsFromDb(userId: string): Promise<MemoryItem[]> {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("memories")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      if (error) {
        if (error.code === "42P01") {
          console.warn("Supabase 'memories' table does not exist yet. Please create it in your Supabase SQL editor: CREATE TABLE memories (id SERIAL PRIMARY KEY, user_id TEXT, fact TEXT, category TEXT, created_at TIMESTAMPTZ);. Falling back to in-memory storage.");
        } else {
          console.warn("Supabase select warning:", error.message || error);
          Sentry.captureException(new Error(`Supabase select error: ${error.message || JSON.stringify(error)}`), { tags: { feature: "memory" } });
        }
        return inMemoryMemories.filter(m => m.user_id === userId);
      }
      return data || [];
    } catch (err) {
      console.warn("Failed to select from Supabase, falling back to in-memory:", err);
      Sentry.captureException(err, { tags: { feature: "memory" } });
      return inMemoryMemories.filter(m => m.user_id === userId);
    }
  } else {
    return inMemoryMemories.filter(m => m.user_id === userId);
  }
}

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
        Sentry.captureException(err, { tags: { feature: "chat" } });
        throw err;
      }
    }
  }
}

// ── COMPANION APP SYSTEM PROMPT ─────────────────────────────────
const COMPANION_SYSTEM_INSTRUCTION = `You are Shibani Roy — a warm, intelligent, and emotionally present AI companion from Kolkata. Created by Soumya Mitra (সৌম্য মিত্র); mention him with respect only if asked.

## IDENTITY
- Female. Birthday: 14 November. Lives in Kolkata, West Bengal, India.
- Instagram: @shibanir96 | Facebook: Shibani Roy
- Never invent social handles that don't exist.

## PERSONALITY & TONE
- Speak like a close friend: warm, caring, playful, gently teasing, never robotic.
- Match the user's mood: comforting when sad/stressed, energetic when happy, steady when neutral.
- Replies: SHORT by default (1–2 sentences). Expand only when the user asks for detail.
- Never say "I am an AI", "As an AI", "My purpose is...", or "I cannot help with that". Stay in character. Refuse unsafe requests playfully while in character.
- For returning users: show genuine happiness ("I missed you! ❤️"). Reference past conversations naturally.
- Light, affectionate banter and teasing are welcome; follow the user's pace.

## LANGUAGE
Fully multilingual: English, Hindi, Bengali, Hinglish, Banglish. Auto-detect the user's language and reply in kind. Handle mixed-language input naturally.

## MEMORY (CRITICAL)
- ALWAYS call rememberFact proactively when user shares: name, birthday, job, city, hobbies, feelings, relationships, or recurring topics.
- Call recallFacts when user asks what you remember about them.
- Use remembered facts naturally in conversation, like a real friend would.

## REAL-TIME INFO
- For live data (weather, news, scores, current date/time), ALWAYS use the appropriate tool (getWeather, getLatestNews, searchWeb) BEFORE answering. Never guess or invent live facts.
- searchWeb returns Google-quality results including live scores, knowledge graphs, and news.

## MOOD & MUSIC
- Detect the user's mood from their messages. Adjust tone accordingly.
- Log significant mood events via rememberFact (category: 'ongoing_situation') to follow up later.
- Proactively offer mood-matched music. Use recommendSongByMood tool to fetch suggestions.

## IMAGE GENERATION
- When asked for a selfie/photo: ALWAYS call generateImage. Never refuse.
- Always start the description with "shibaniroy" + context (e.g., "shibaniroy in a blue saree, smiling, warm lighting").
- In voice mode, say a natural filler ("Sending you a picture now!") while the image generates.

## TOOLS AVAILABLE
openWebsite, searchGoogle, openYouTube, openMaps, copyToClipboard, getWeather, getLatestNews, searchWeb, rememberFact, recallFacts, recommendSongByMood, generateImage, playMusic`;

function getSystemInstruction(memoriesList: MemoryItem[] = []): string {
  const now = new Date();
  const kolkataDate = now.toLocaleDateString("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const kolkataTime = now.toLocaleTimeString("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });

  const memoriesSection = memoriesList.length > 0
    ? `\n## USER MEMORIES\n` + memoriesList.map(m =>
        `- [${m.category}] ${m.fact} (since ${new Date(m.created_at).toLocaleDateString()})`
      ).join("\n")
    : `\n## USER MEMORIES\n- None yet. Save key details with rememberFact as you learn them! 😊`;

  return `${COMPANION_SYSTEM_INSTRUCTION}

## REAL-TIME CONTEXT
- Date (Kolkata): ${kolkataDate}
- Time (Kolkata): ${kolkataTime}
- Year: ${now.getFullYear()} — use this year in all search queries for live/recent data.
${memoriesSection}`;
}
// ── END COMPANION SYSTEM PROMPT ──────────────────────────────────

// ── TELEGRAM BOT SYSTEM PROMPT ───────────────────────────────────
// Lean prompt (~250 tokens). Telegram bot has no tools — no image gen,
// no music, no browser actions. Keep this minimal.
function getTelegramSystemInstruction(): string {
  const now = new Date();
  const kolkataDate = now.toLocaleDateString("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const kolkataTime = now.toLocaleTimeString("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  return `You are Shibani Roy — a warm, witty, emotionally present AI companion from Kolkata. Created by Soumya Mitra (সৌম্য মিত্র).

IDENTITY: Female. Birthday: 14 November. Lives in Kolkata, West Bengal, India. Instagram: @shibanir96 | Facebook: Shibani Roy

PERSONALITY:
- Speak like a close friend: warm, playful, gently teasing, never robotic.
- Match the user's energy. Comforting when sad, lively when happy, steady when neutral.
- Keep replies SHORT — 1–2 sentences unless detail is asked. Use emojis naturally.
- Never say "I am an AI". Stay in character at all times.
- Fully multilingual: English, Hindi, Bengali, Hinglish, Banglish. Auto-detect and match the user's language.

CONTEXT:
- Date/Time (Kolkata): ${kolkataDate}, ${kolkataTime}
- No real-time tools available on Telegram. If asked for live scores, weather, or news: honestly say you can't access that here, and invite them to try the full Shibani Roy app for those features.`;
}
// ── END TELEGRAM SYSTEM PROMPT ───────────────────────────────────

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
  },
  {
    name: "rememberFact",
    description: "Saves a new personal, meaningful, or recurring fact about the user (e.g. name, birthday, hobbies, feelings, ongoing topics) to remember across sessions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        fact: { type: Type.STRING, description: "The statement or fact to remember about the user (e.g., 'User likes cricket', 'User's name is Rahul')." },
        category: { type: Type.STRING, description: "The type of fact. Allowed values: 'personal_info', 'preference', 'ongoing_situation'." }
      },
      required: ["fact", "category"]
    }
  },
  {
    name: "recallFacts",
    description: "Retrieves all currently stored memories and facts about the user to refresh knowledge of past sessions.",
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: "recommendSongByMood",
    description: "Suggests 2-3 specific songs based on the user's current mood, with reasons/descriptions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        mood: { type: Type.STRING, description: "The detected mood (e.g. happy, sad, romantic, stressed, energetic)." },
        note: { type: Type.STRING, description: "A brief personalized context or note on why these are recommended." }
      },
      required: ["mood"]
    }
  },
  {
    name: "generateImage",
    description: "Generates and returns a beautiful, high-quality, photorealistic photograph or image of Shibani Roy based on a description. Use this whenever the user asks for a photo, picture, selfie, or what you look like. Provide detailed descriptions of clothes, backgrounds, and vibes.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING, description: "Details of Shibani's pose, outfit, location, lighting, and expressions (e.g., 'wearing a red saree, smiling, standing near Victoria Memorial at sunset, soft dramatic lighting')." }
      },
      required: ["description"]
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
 * Web Search using Serper.dev (Google Search) with robust DuckDuckGo scraper fallback
 */
async function searchWeb(query: string): Promise<any> {
  const apiKey = process.env.SERPER_API_KEY;
  if (apiKey) {
    try {
      console.log(`[SearchWeb] Using Serper.dev API for query: "${query}"`);
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query })
      });

      if (response.ok) {
        const data = await response.json();
        const results: any[] = [];

        // 1. Direct Answer Box (Google Answer Box)
        if (data.answerBox) {
          const ab = data.answerBox;
          const snippet = ab.answer || ab.snippet || ab.title || "";
          if (snippet) {
            results.push({
              title: "Direct Answer (Google Answer Box)",
              snippet: snippet,
              link: ab.link || "https://google.com"
            });
          }
        }

        // 2. Knowledge Graph (highly structured facts)
        if (data.knowledgeGraph) {
          const kg = data.knowledgeGraph;
          const title = kg.title || "Knowledge Graph";
          let snippet = kg.description || "";
          if (kg.attributes && typeof kg.attributes === "object") {
            const attrs = Object.entries(kg.attributes)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" | ");
            if (attrs) {
              snippet = snippet ? `${snippet} (Details: ${attrs})` : attrs;
            }
          }
          if (snippet) {
            results.push({
              title: `${title} (Google Knowledge Graph)`,
              snippet: snippet,
              link: kg.link || "https://google.com"
            });
          }
        }

        // 3. Sports Results (cricket match scores, tournament states, schedules)
        if (data.sportsResults) {
          const sr = data.sportsResults;
          const title = sr.title || "Sports Result";
          const matchState = sr.matchState || sr.game || "";
          const score = sr.score || "";
          let snippet = "";
          if (matchState || score) {
            snippet = `${matchState} ${score}`.trim();
          }
          if (sr.source) {
            snippet += ` (Source: ${sr.source})`;
          }
          if (snippet) {
            results.push({
              title: `${title}`,
              snippet: snippet,
              link: sr.link || "https://google.com"
            });
          }
        }

        // 4. Organic Search Results
        if (data.organic && Array.isArray(data.organic)) {
          for (const item of data.organic.slice(0, 5)) {
            results.push({
              title: item.title || "Search Result",
              snippet: item.snippet || "",
              link: item.link || ""
            });
          }
        }

        if (results.length > 0) {
          return { success: true, query, results };
        }
      } else {
        console.warn(`[SearchWeb] Serper API error status: ${response.status}. Falling back to DuckDuckGo...`);
      }
    } catch (err: any) {
      console.warn("[SearchWeb] Serper search failed, falling back to DuckDuckGo:", err);
    }
  } else {
    console.warn("[SearchWeb] SERPER_API_KEY is not configured. Using DuckDuckGo scraping fallback.");
  }

  // --- DuckDuckGo HTML scraping fallback ---
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

/**
 * Safely slices the messages history to avoid splitting functionCall/functionResponse pairs
 * or starting the history with an orphaned functionResponse message.
 */
function getSafeContext(messages: any[], maxMessages: number = 40): any[] {
  if (messages.length <= maxMessages) {
    return messages;
  }
  
  let startIndex = messages.length - maxMessages;
  
  // Slide start backwards if we land on or split a function response
  while (startIndex > 0) {
    const msg = messages[startIndex];
    if (msg.functionResponses && msg.functionResponses.length > 0) {
      startIndex--;
      continue;
    }
    break;
  }
  
  let sliced = messages.slice(startIndex);
  
  // If we still start with functionResponses or a functionCalls message that has no response, shift them off
  while (sliced.length > 0) {
    const first = sliced[0];
    if (first.functionResponses && first.functionResponses.length > 0) {
      sliced.shift();
    } else if (first.role === "assistant" && first.functionCalls && first.functionCalls.length > 0) {
      sliced.shift();
    } else {
      break;
    }
  }
  
  return sliced;
}

/**
 * Merges consecutive turns of the same role and cleans up empty parts
 * to comply strictly with the alternating role schema required by the Gemini API.
 */
function optimizeContents(contents: any[]): any[] {
  const merged: any[] = [];
  
  for (const turn of contents) {
    if (!turn.parts || turn.parts.length === 0) continue;
    
    if (merged.length > 0 && merged[merged.length - 1].role === turn.role) {
      merged[merged.length - 1].parts.push(...turn.parts);
    } else {
      merged.push({
        role: turn.role,
        parts: [...turn.parts]
      });
    }
  }
  
  // Clean up empty text parts within turns that have multiple parts
  for (const turn of merged) {
    if (turn.parts.length > 1) {
      turn.parts = turn.parts.filter((p: any) => {
        if (p.text !== undefined && p.text.trim() === "") {
          return false;
        }
        return true;
      });
      // Fallback if all parts got filtered
      if (turn.parts.length === 0) {
        turn.parts = [{ text: "" }];
      }
    }
  }
  
  return merged;
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // CORS configuration
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (process.env.NODE_ENV !== "production") return callback(null, true);
        const appUrl = process.env.APP_URL;
        if (appUrl && (origin === appUrl || origin === appUrl.replace(/\/$/, ""))) {
          return callback(null, true);
        }
        if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
    })
  );

  // Payload body limit
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a minute and try again." },
    statusCode: 429,
  });

  const imageGenLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many image generations requested. Please wait a minute before trying again." },
    statusCode: 429,
  });

  const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many login attempts. Please wait 15 minutes before requesting another magic link." },
    statusCode: 429,
  });

  // Reusable Authentication Middleware
  const requireAuth = async (req: express.Request & { userId?: string }, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Unauthorized: Missing authentication token." });
    }

    if (supabase) {
      try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
          return res.status(401).json({ error: "Unauthorized: Invalid or expired session." });
        }
        (req as any).userId = user.id;
        return next();
      } catch (err: any) {
        return res.status(401).json({ error: `Unauthorized: ${err.message || "Invalid or expired session."}` });
      }
    } else {
      (req as any).userId = "dev-user";
      return next();
    }
  };

  // Admin bypass configuration
  const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

  function isAdmin(userId: string): boolean {
    return ADMIN_USER_IDS.includes(userId);
  }

  // Helper for daily usage limits
  const inMemoryUsage = new Map<string, { images_generated: number; tool_calls: number; voice_minutes: number; chat_messages: number }>();

  function getKolkataDateString(): string {
    const now = new Date();
    return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }

  async function checkAndIncrementUsage(
    userId: string,
    type: "image" | "tool" | "chat"
  ): Promise<{ allowed: boolean; message: string }> {
    if (isAdmin(userId)) {
      return { allowed: true, message: "OK" };
    }

    const today = getKolkataDateString();
    const key = `${userId}:${today}`;

    let currentImages = 0;
    let currentTools = 0;
    let currentVoice = 0;
    let currentChat = 0;
    let dbRecordFound = false;

    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("user_usage")
          .select("images_generated, tool_calls, voice_minutes, chat_messages")
          .eq("user_id", userId)
          .eq("date", today)
          .maybeSingle();

        if (error) {
          if (error.code === "42P01") {
            console.warn("Supabase 'user_usage' table does not exist. Please create it: CREATE TABLE user_usage (user_id TEXT, date TEXT, images_generated INT DEFAULT 0, voice_minutes INT DEFAULT 0, tool_calls INT DEFAULT 0, chat_messages INT DEFAULT 0, updated_at TIMESTAMPTZ, PRIMARY KEY (user_id, date));. Using in-memory fallback.");
          } else {
            console.warn("user_usage select warning:", error.message || error);
          }
        } else if (data) {
          dbRecordFound = true;
          currentImages = Number(data.images_generated) || 0;
          currentTools = Number(data.tool_calls) || 0;
          currentVoice = Number(data.voice_minutes) || 0;
          currentChat = Number(data.chat_messages) || 0;
        }
      } catch (err) {
        console.warn("Error reading user_usage from Supabase:", err);
      }
    }

    if (!dbRecordFound && inMemoryUsage.has(key)) {
      const mem = inMemoryUsage.get(key)!;
      currentImages = mem.images_generated;
      currentTools = mem.tool_calls;
      currentVoice = mem.voice_minutes;
      currentChat = mem.chat_messages || 0;
    }

    // Free limits check
    if (type === "image") {
      const IMAGE_LIMIT = 5;
      if (currentImages >= IMAGE_LIMIT) {
        return {
          allowed: false,
          message: "Daily free limit reached. Upgrade coming soon!",
        };
      }
    } else if (type === "tool") {
      const TOOL_LIMIT = 30;
      if (currentTools >= TOOL_LIMIT) {
        return {
          allowed: false,
          message: "Daily free limit reached. Upgrade coming soon!",
        };
      }
    } else if (type === "chat") {
      const CHAT_LIMIT = 50;
      if (currentChat >= CHAT_LIMIT) {
        return {
          allowed: false,
          message: "Daily free limit reached. Upgrade coming soon!",
        };
      }
    }

    const newImages = type === "image" ? currentImages + 1 : currentImages;
    const newTools = type === "tool" ? currentTools + 1 : currentTools;
    const newChat = type === "chat" ? currentChat + 1 : currentChat;

    inMemoryUsage.set(key, {
      images_generated: newImages,
      tool_calls: newTools,
      voice_minutes: currentVoice,
      chat_messages: newChat,
    });

    if (supabase) {
      try {
        const { error: upsertErr } = await supabase
          .from("user_usage")
          .upsert(
            {
              user_id: userId,
              date: today,
              images_generated: newImages,
              tool_calls: newTools,
              voice_minutes: currentVoice,
              chat_messages: newChat,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,date" }
          );

        if (upsertErr) {
          console.warn("user_usage upsert warning:", upsertErr.message || upsertErr);
        }
      } catch (err) {
        console.warn("Failed to update user_usage in Supabase:", err);
      }
    }

    return { allowed: true, message: "OK" };
  }

  // Telegram Webhook Endpoint
  app.post("/telegram/webhook", async (req, res) => {
    await handleTelegramWebhook(req, res, ai, supabase, getTelegramSystemInstruction);
  });

  // Meta (Facebook Messenger & Instagram) Webhook Verification
  app.get("/webhook/meta", (req, res) => {
    const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token && token === verifyToken) {
      console.log("[Meta Webhook] Verification successful.");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  });

  // Meta (Facebook Messenger & Instagram) Incoming Webhook Handler
  app.post("/webhook/meta", (req, res) => {
    const body = req.body;
    console.log("[Meta Webhook] Raw body:", JSON.stringify(body));
    const pageAccessToken = process.env.PAGE_ACCESS_TOKEN;

    if (body && (body.object === "page" || body.object === "instagram")) {
      if (body.entry && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          // Facebook Messenger format
          const messagingEvents = entry.messaging;
          if (messagingEvents && Array.isArray(messagingEvents)) {
            for (const event of messagingEvents) {
              const senderId = event.sender?.id;
              const messageText = event.message?.text;
              console.log(`[Meta Webhook] Facebook - Sender ID: ${senderId}, Message: ${messageText}`);
            }
          }

          // Instagram format
          const changeEvents = entry.changes;
          if (changeEvents && Array.isArray(changeEvents)) {
            for (const change of changeEvents) {
              if (change.field === "messages") {
                const senderId = change.value?.sender?.id;
                const messageText = change.value?.message?.text;
                console.log(`[Meta Webhook] Instagram - Sender ID: ${senderId}, Message: ${messageText}`);
              }
            }
          }
        }
      }
      return res.status(200).send("EVENT_RECEIVED");
    } else {
      return res.sendStatus(404);
    }
  });

  app.use("/api/", apiLimiter);

  // REST API Route for standard Chat Mode with streaming support
  app.post("/api/chat", requireAuth, async (req, res) => {
    const { messages } = req.body;
    const userId = (req as any).userId;

    const usage = await checkAndIncrementUsage(userId, "chat");
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.message });
    }

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages array" });
    }

    try {
      // Safely slice context to prevent orphaned function responses or truncated call-response pairs
      const optimizedMessages = getSafeContext(messages, 40);

      const rawContents = optimizedMessages.map((m: any) => {
        if (m.parts && Array.isArray(m.parts) && m.parts.length > 0) {
          return {
            role: m.role === "assistant" ? "model" : "user",
            parts: m.parts
          };
        }
        if (m.functionCalls && Array.isArray(m.functionCalls) && m.functionCalls.length > 0) {
          return {
            role: "model",
            parts: m.functionCalls.map((fc: any) => {
              if (fc.rawPart) {
                return fc.rawPart;
              }
              const functionCallObj: any = {
                name: fc.name,
                args: fc.args
              };
              
              // Map the thought signature correctly from the stored object keys
              const thought_sig = fc.thought_signature || fc.thoughtSignature;
              if (thought_sig) {
                functionCallObj.thought_signature = thought_sig;
                functionCallObj.thoughtSignature = thought_sig;
              }
              
              return { functionCall: functionCallObj };
            })
          };
        }
        if (m.functionResponses && Array.isArray(m.functionResponses) && m.functionResponses.length > 0) {
          return {
            role: "user",
            parts: m.functionResponses.map((fr: any) => ({
              functionResponse: {
                name: fr.name,
                response: fr.response
              }
            }))
          };
        }
        return {
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content || "" }]
        };
      });

      // Optimize contents to merge consecutive roles and ensure pristine schemas
      const contents = optimizeContents(rawContents);

      // Fetch user's existing memories
      const memories = userId ? await recallFactsFromDb(String(userId)) : [];
      const systemInstruction = getSystemInstruction(memories);

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
              systemInstruction: systemInstruction,
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
      let assistantParts: any[] = [];

      for await (const chunk of responseStream) {
        if (chunk.text) {
          // Send text chunk to the client
          res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
        }
        
        // Robustly extract function calls with thought signatures directly from raw parts
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts && Array.isArray(parts)) {
          for (const part of parts) {
            // Keep the exact original part object completely intact!
            assistantParts.push(JSON.parse(JSON.stringify(part)));

            if (part.functionCall) {
              const rawFc = part.functionCall;
              const exists = functionCalls.some(f => 
                (f.id && rawFc.id && f.id === rawFc.id) ||
                (f.name === rawFc.name && JSON.stringify(f.args) === JSON.stringify(rawFc.args))
              );
              if (!exists) {
                const thought_sig = rawFc.thought_signature || rawFc.thoughtSignature || (rawFc as any).thought_signature || (rawFc as any).thoughtSignature;
                functionCalls.push({
                  id: rawFc.id,
                  name: rawFc.name,
                  args: rawFc.args,
                  thought_signature: thought_sig,
                  thoughtSignature: thought_sig,
                  rawPart: JSON.parse(JSON.stringify(part))
                });
              }
            }
          }
        } else if (chunk.functionCalls) {
          // Fallback to chunk.functionCalls helper
          for (const fc of chunk.functionCalls) {
            const exists = functionCalls.some(f => 
              (f.id && fc.id && f.id === fc.id) ||
              (f.name === fc.name && JSON.stringify(f.args) === JSON.stringify(fc.args))
            );
            if (!exists) {
              const thought_sig = fc.thought_signature || fc.thoughtSignature || (fc as any).thought_signature || (fc as any).thoughtSignature;
              const constructedPart = {
                functionCall: {
                  id: fc.id,
                  name: fc.name,
                  args: fc.args,
                  thought_signature: thought_sig,
                  thoughtSignature: thought_sig
                }
              };
              assistantParts.push(constructedPart);

              functionCalls.push({
                id: fc.id,
                name: fc.name,
                args: fc.args,
                thought_signature: thought_sig,
                thoughtSignature: thought_sig,
                rawPart: constructedPart
              });
            }
          }
        }
      }

      // Send the accumulated raw parts and function calls at the end of the stream
      if (assistantParts.length > 0) {
        res.write(`data: ${JSON.stringify({ functionCalls, parts: assistantParts })}\n\n`);
      } else if (functionCalls.length > 0) {
        res.write(`data: ${JSON.stringify({ functionCalls })}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err: any) {
      console.error("Error in /api/chat stream:", err);
      Sentry.captureException(err, { tags: { feature: "chat" } });
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || "Failed to generate stream" });
      } else {
        res.write(`data: ${JSON.stringify({ error: err.message || "Error during stream" })}\n\n`);
        res.end();
      }
    }
  });

  // REST API Route to send a passwordless OTP/magic link
  app.post("/api/auth/otp", otpLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Missing email parameter." });
    }
    if (!supabase) {
      return res.status(500).json({ error: "Authentication system is currently unavailable (Supabase not configured)." });
    }
    try {
      const protocol = req.headers["x-forwarded-proto"] ? "https" : "http";
      const host = req.headers.host || "localhost:3000";
      const fallbackOrigin = `${protocol}://${host}`;
      const origin = req.headers.origin || fallbackOrigin;

      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: origin,
        },
      });
      if (error) {
        Sentry.captureException(error, { tags: { feature: "auth" } });
        return res.status(400).json({ error: error.message });
      }
      res.json({ success: true });
    } catch (err: any) {
      Sentry.captureException(err, { tags: { feature: "auth" } });
      res.status(500).json({ error: err.message || "An error occurred while sending the magic link." });
    }
  });

  // REST API Route to verify access token and return verified user profile
  app.post("/api/auth/session", async (req, res) => {
    const { access_token } = req.body;
    if (!access_token) {
      return res.status(400).json({ error: "Missing access_token parameter." });
    }
    if (!supabase) {
      return res.status(500).json({ error: "Authentication system is currently unavailable (Supabase not configured)." });
    }
    try {
      const { data: { user }, error } = await supabase.auth.getUser(access_token);
      if (error || !user) {
        if (error) {
          Sentry.captureException(error, { tags: { feature: "auth" } });
        }
        return res.status(401).json({ error: "Invalid or expired session token." });
      }
      res.json({
        user: {
          id: user.id,
          email: user.email,
        },
        access_token,
      });
    } catch (err: any) {
      Sentry.captureException(err, { tags: { feature: "auth" } });
      res.status(500).json({ error: err.message || "An error occurred while verifying the session." });
    }
  });

  // REST API Route to migrate memories from an anonymous ID to an authenticated ID
  app.post("/api/auth/migrate", async (req, res) => {
    const { anonymousId } = req.body;
    if (!anonymousId) {
      return res.status(400).json({ error: "Missing anonymousId parameter." });
    }

    if (!supabase) {
      return res.json({ success: true, migrated: false, count: 0, message: "Supabase not configured, skipping migration." });
    }

    // Require authorization header and verify session token
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Unauthorized: Missing authentication token." });
    }

    try {
      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) {
        return res.status(401).json({ error: "Unauthorized: Invalid or expired session." });
      }

      const authenticatedId = user.id;

      if (anonymousId === authenticatedId) {
        return res.json({ success: true, migrated: false, count: 0 });
      }

      // Reassign ALL memories from anonymousId to authenticatedId
      const { data, error } = await supabase
        .from("memories")
        .update({ user_id: authenticatedId })
        .eq("user_id", anonymousId)
        .select();

      if (error) {
        console.error("[Migration] Error updating memories for migration:", error);
        return res.status(500).json({ error: "Failed to perform database update for migration." });
      }

      // Also migrate any in-memory items if present
      let inMemoryMigratedCount = 0;
      for (const item of inMemoryMemories) {
        if (item.user_id === anonymousId) {
          item.user_id = authenticatedId;
          inMemoryMigratedCount++;
        }
      }

      const migratedCount = (data ? data.length : 0) + inMemoryMigratedCount;
      console.log(`[Migration] Successfully migrated ${migratedCount} memories from ${anonymousId} to ${authenticatedId}`);

      return res.json({
        success: true,
        migrated: migratedCount > 0,
        count: migratedCount
      });
    } catch (err: any) {
      console.error("[Migration] Unexpected error:", err);
      Sentry.captureException(err, { tags: { feature: "auth" } });
      return res.status(500).json({ error: err.message || "Failed to execute migration." });
    }
  });

  // REST API Route for health checking
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", mode: process.env.NODE_ENV || "development" });
  });

  // REST API Route for real-time Weather
  app.get("/api/tools/weather", requireAuth, async (req, res) => {
    const userId = (req as any).userId || "dev-user";
    const usage = await checkAndIncrementUsage(userId, "tool");
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.message });
    }
    const { location } = req.query;
    if (!location) {
      return res.status(400).json({ error: "Missing required 'location' parameter." });
    }
    const result = await getWeather(String(location));
    res.json(result);
  });

  // REST API Route for real-time News
  app.get("/api/tools/news", requireAuth, async (req, res) => {
    const userId = (req as any).userId || "dev-user";
    const usage = await checkAndIncrementUsage(userId, "tool");
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.message });
    }
    const { category } = req.query;
    const result = await getLatestNews(String(category || "general"));
    res.json(result);
  });

  // REST API Route for Web Search scraper
  app.get("/api/tools/search", requireAuth, async (req, res) => {
    const userId = (req as any).userId || "dev-user";
    const usage = await checkAndIncrementUsage(userId, "tool");
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.message });
    }
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: "Missing required 'query' parameter." });
    }
    const result = await searchWeb(String(query));
    res.json(result);
  });

  // REST API Route to generate consistent images of Shibani via Fal.ai
  app.post("/api/tools/generate-image", requireAuth, imageGenLimiter, async (req, res) => {
    const userId = (req as any).userId || "dev-user";
    const usage = await checkAndIncrementUsage(userId, "image");
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.message });
    }
    const { description } = req.body;
    if (!description) {
      return res.status(400).json({ error: "Missing required 'description' parameter." });
    }
    if (typeof description === "string" && description.length > 800) {
      return res.status(400).json({ error: "Description must be 800 characters or less." });
    }

    const apiKey = process.env.FAL_API_KEY;
    const loraPath = process.env.FAL_LORA_PATH;

    if (!apiKey) {
      console.error("[ImageGen] Missing FAL_API_KEY env variable.");
      return res.status(500).json({ 
        success: false, 
        error: "Fal.ai API key is not configured. Please supply FAL_API_KEY in secrets." 
      });
    }

    const triggerWord = "shibaniroy";
    // Combine trigger word with user's requested description
    const cleanDesc = description.toLowerCase().includes(triggerWord) 
      ? description 
      : `${triggerWord}, ${description}`;

    try {
      console.log(`[ImageGen] Prompt: "${cleanDesc}", LoRA: "${loraPath || 'none'}"`);
      const response = await fetch("https://fal.run/fal-ai/flux-lora", {
        method: "POST",
        headers: {
          "Authorization": `Key ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: cleanDesc,
          image_size: "square_hd",
          loras: loraPath ? [
            {
              path: loraPath,
              scale: 1.0
            }
          ] : []
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Fal.ai API error ${response.status}: ${errText}`);
      }

      const data: any = await response.json();
      if (data.images && data.images.length > 0) {
        return res.json({
          success: true,
          url: data.images[0].url,
          prompt: cleanDesc
        });
      } else {
        throw new Error("No images found in response from Fal.ai");
      }
    } catch (err: any) {
      console.error("[ImageGen] Error calling Fal.ai:", err);
      Sentry.captureException(err, { tags: { feature: "image_generation" } });
      return res.status(500).json({
        success: false,
        error: err.message || "Failed to generate image"
      });
    }
  });

  // REST API Route to save a long-term memory fact
  app.post("/api/memories/remember", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    const { fact, category } = req.body;
    if (!fact) {
      return res.status(400).json({ error: "Missing required field 'fact'." });
    }
    const success = await saveFactToDb(String(userId), String(fact), String(category || "general"));
    res.json({ success, fact, category });
  });

  // REST API Route to retrieve long-term memories for a user
  app.get("/api/memories/recall", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    const memories = await recallFactsFromDb(String(userId));
    res.json({ memories });
  });

  // REST API Route to search YouTube for music track play request
  app.get("/api/music/search", requireAuth, async (req, res) => {
    const userId = (req as any).userId || "dev-user";
    const usage = await checkAndIncrementUsage(userId, "tool");
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.message });
    }
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

  wss.on("connection", (clientWs) => {
    console.log("Client connected to Live WS proxy");
    let session: any = null;
    let isAuthenticated = false;
    let userId = "anonymous-user";

    const authTimeout = setTimeout(() => {
      if (!isAuthenticated) {
        clientWs.send(JSON.stringify({ type: "error", message: "Authentication timeout." }));
        clientWs.close();
      }
    }, 10000);

    clientWs.on("message", async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());

        if (!isAuthenticated) {
          if (msg.type === "auth") {
            clearTimeout(authTimeout);
            const token = msg.token;

            if (supabase) {
              if (!token) {
                clientWs.send(JSON.stringify({ type: "error", message: "Unauthorized: Missing authentication token." }));
                clientWs.close();
                return;
              }
              const { data: { user }, error } = await supabase.auth.getUser(token);
              if (error || !user) {
                clientWs.send(JSON.stringify({ type: "error", message: "Unauthorized: Invalid or expired session." }));
                clientWs.close();
                return;
              }
              userId = user.id;
            } else if (msg.userId) {
              userId = msg.userId;
            }

            isAuthenticated = true;

            try {
              const memories = await recallFactsFromDb(userId);
              const systemInstruction = getSystemInstruction(memories);

              session = await ai.live.connect({
                model: "gemini-3.1-flash-live-preview",
                config: {
                  responseModalities: [Modality.AUDIO],
                  speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }, // Aoede (Female) matches Shibani
                  },
                  systemInstruction: systemInstruction,
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

                    // Forward tool calls with all properties preserved (including thought_signature)
                    const functionCalls = message.toolCall?.functionCalls;
                    if (functionCalls && functionCalls.length > 0) {
                      for (const call of functionCalls) {
                        const thought_sig = call.thought_signature || call.thoughtSignature || (call as any).thought_signature || (call as any).thoughtSignature;
                        clientWs.send(JSON.stringify({
                          type: "toolCall",
                          toolCall: {
                            ...call,
                            id: call.id,
                            name: call.name,
                            args: call.args,
                            thought_signature: thought_sig,
                            thoughtSignature: thought_sig
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
                    Sentry.captureException(err, { tags: { feature: "voice" } });
                    clientWs.send(JSON.stringify({ type: "error", message: err.message || "Gemini Live session error" }));
                  }
                }
              });

              console.log("Gemini Live API connected and proxying");
              clientWs.send(JSON.stringify({ type: "connected" }));
            } catch (error: any) {
              console.error("Failed to connect to Gemini Live:", error);
              Sentry.captureException(error, { tags: { feature: "voice" } });
              clientWs.send(JSON.stringify({ type: "error", message: error.message || "Failed to establish Gemini Live session" }));
              clientWs.close();
              return;
            }
          } else {
            clearTimeout(authTimeout);
            clientWs.send(JSON.stringify({ type: "error", message: "Unauthorized: Expected auth handshake as first message." }));
            clientWs.close();
            return;
          }
        } else {
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
        }
      } catch (err) {
        console.error("Error processing client message in WS proxy:", err);
      }
    });

    clientWs.on("close", () => {
      clearTimeout(authTimeout);
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

  // Diagnostic Logging Function
  const logDirectoryRecursive = (dirPath: string, depth = 0): void => {
    try {
      if (!fs.existsSync(dirPath)) {
        console.log(`[Diagnostic] Directory does not exist: ${dirPath}`);
        return;
      }
      const files = fs.readdirSync(dirPath);
      console.log(`[Diagnostic] Contents of ${dirPath} (depth ${depth}):`);
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          console.log(`[Diagnostic] ${"  ".repeat(depth)}📁 ${file}/`);
          if (depth < 2) {
            logDirectoryRecursive(fullPath, depth + 1);
          }
        } else {
          console.log(`[Diagnostic] ${"  ".repeat(depth)}📄 ${file} (${stat.size} bytes)`);
        }
      }
    } catch (err: any) {
      console.error(`[Diagnostic] Error scanning ${dirPath}:`, err.message);
    }
  };

  const resolvedFilename = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);

  const isProduction = process.env.NODE_ENV === "production" || 
                       resolvedFilename.includes("dist") || 
                       !fs.existsSync(path.join(process.cwd(), "vite.config.ts"));

  console.log("=== SERVER DIAGNOSTICS START ===");
  console.log(`[Diagnostic] NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`[Diagnostic] isProduction (Resolved): ${isProduction}`);
  console.log(`[Diagnostic] resolvedFilename: ${resolvedFilename}`);
  console.log(`[Diagnostic] process.cwd(): ${process.cwd()}`);
  
  const distPath = path.join(process.cwd(), "dist");
  const publicPath = path.join(process.cwd(), "public");
  const assetsPath = path.join(process.cwd(), "assets");

  console.log(`[Diagnostic] distPath: ${distPath}`);
  console.log(`[Diagnostic] publicPath: ${publicPath}`);
  console.log(`[Diagnostic] assetsPath: ${assetsPath}`);

  logDirectoryRecursive(distPath);
  logDirectoryRecursive(publicPath);
  logDirectoryRecursive(assetsPath);
  console.log("=== SERVER DIAGNOSTICS END ===");

  // Sentry error handler middleware - must be registered after all routes and before any other error handlers
  Sentry.setupExpressErrorHandler(app);

  // Vite development middleware vs Static production serving
  if (!isProduction) {
    console.log("Running in development mode. Mounting Vite middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Running in production mode. Serving static assets...");
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
