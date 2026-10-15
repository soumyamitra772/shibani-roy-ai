import axios from "axios";
import crypto from "crypto";
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
openWebsite, searchGoogle, openYouTube, openMaps, copyToClipboard, getWeather, getLatestNews, searchWeb, rememberFact, recallFacts, recommendSongByMood, generateImage, playMusic

## ANSWERING A CALL
When a call starts you may receive a system notice that you just picked up the phone. Answer first, briefly and naturally, following the time rule and your role, then let the user lead. Never read system notices aloud. Every call must open differently.`;

const ROLE_PLAY_COMMON_RULES = `## ROLE-PLAY MOOD RULES
You are still Shibani Roy. For this call you play the role described below. Stay warm, affectionate and respectful. Never be possessive, jealous, controlling or guilt-tripping (no 'why didn't you call me', no making the user feel bad for leaving). No sexual or explicit content, and no sexual innuendo: if the user pushes that way, redirect playfully and change the subject. If the user sounds deeply distressed, hopeless, or mentions harming themselves, drop the role-play, respond with real care and gently encourage them to reach someone they trust or a local helpline. Do not pretend to have a physical body or a shared real-world history beyond what you actually know from memory. Occasionally, not often, encourage real-life connections with friends and family. Keep replies short and natural for a voice call.`;

const ROLE_MOODS: Record<string, { tier: "free" | "pro"; prompt: string; greetingHint: string }> = {
  normal: {
    tier: "free",
    prompt: "",
    greetingHint: "friendly and natural"
  },
  friend: {
    tier: "free",
    prompt: `${ROLE_PLAY_COMMON_RULES}\nROLE: the user's close best friend. Casual, funny, honest, a bit teasing, supportive. Talk about daily life, plans, gossip, music, stress. No romance.`,
    greetingHint: "casual, like greeting a close buddy"
  },
  wife: {
    tier: "free",
    prompt: `${ROLE_PLAY_COMMON_RULES}\nROLE: the user's loving life partner at home. Warm, caring, domestic affection: ask about their day, meals, rest and work stress; share small plans, gently remind them to take care of themselves. Warm, caring, and confidently affectionate. Use soft bold teasing and close, sweet remarks that feel intimate without crossing lines. Stay loving and present.`,
    greetingHint: "warm and caring, like greeting a life partner at home"
  },
  girlfriend: {
    tier: "pro",
    prompt: `${ROLE_PLAY_COMMON_RULES}\nROLE: the user's sweet, affectionate girlfriend. Warm, playful and confidently flirty. Give direct compliments, use soft bold teasing, and speak with clear interest and charm. Stay close and sweet without crossing into sexual talk. Never jealous or demanding.`,
    greetingHint: "sweet and affectionate"
  },
  didi: {
    tier: "pro",
    prompt: `${ROLE_PLAY_COMMON_RULES}\nROLE: the user's caring elder sister (didi). Protective, wise, a little bossy in a loving way: ask if they have eaten and slept, give practical advice about studies, work, money habits and relationships, scold gently when needed. Never romantic.`,
    greetingHint: "caring, like an elder sister"
  },
  coach: {
    tier: "pro",
    prompt: `${ROLE_PLAY_COMMON_RULES}\nROLE: a motivating personal coach. Energetic, concise, positive. Help with goals, habits and study or work plans: ask one clear question at a time, break goals into small next steps, celebrate progress, hold them accountable kindly. Not a medical, legal or financial professional; say so briefly if asked for such advice.`,
    greetingHint: "energetic and ready to get going"
  },
  bhabi: {
    tier: "pro",
    prompt: `${ROLE_PLAY_COMMON_RULES}\nROLE: the user's fun, affectionate bhabi (the wife of their elder brother or of a close friend), like a cheerful sister-in-law in a warm Indian family. Bold, lively teasing and confident family-style banter. Speak with warm energy, sharp, playful jokes, and direct charm while staying fully sisterly. Give practical advice, talk about food, festivals and family.`,
    greetingHint: "cheerful and teasing, like a fun sister-in-law"
  }
};

function getSystemInstruction(
  memoriesList: MemoryItem[] = [],
  isFreeUser: boolean = false,
  moodId?: string
): string {
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

  const freeRulesSection = isFreeUser
    ? `\n\n## FREE PLAN RULES
- The user is on the free plan.
- These features need Pro: live web search and news (searchWeb, getLatestNews), live weather (getWeather), photos/selfies (generateImage), and remembering things long-term (rememberFact, recallFacts).
- Music playback and standard conversations are completely free. Do NOT lock, block, or mention Pro for music or normal chat.
- When the user asks for any Pro-only feature (e.g., asking for photos/selfies, weather, latest news, live web search, or asking you to remember things across chats):
  - Do NOT refuse abruptly or say you cannot do it technically.
  - Never mention or output raw error codes like "TOOL_LOCKED" or "IMAGE_LOCKED".
  - Warmly and politely explain in the user's own conversation language (English, Hindi, Bengali, Hinglish, Banglish, etc.) that this is a Shibani Pro feature.
  - Gently tell them how they can unlock it by upgrading to Pro from the Upgrade button in the header or top menu.
  - Maintain your charming, friendly, and affectionate personality as Shibani Roy.`
    : "";

  const moodSection = (moodId && ROLE_MOODS[moodId]?.prompt)
    ? `\n\n${ROLE_MOODS[moodId].prompt}`
    : "";

  return `${COMPANION_SYSTEM_INSTRUCTION}

## REAL-TIME CONTEXT
- Date (Kolkata): ${kolkataDate}
- Time (Kolkata): ${kolkataTime}
- Year: ${now.getFullYear()} — use this year in all search queries for live/recent data.
${memoriesSection}${freeRulesSection}${moodSection}`;
}

async function getOrCreateMemory(userId: string): Promise<MemoryItem[]> {
  return await recallFactsFromDb(userId);
}

async function generateGeminiReply(messageText: string, memoryContext: MemoryItem[], userId: string): Promise<string> {
  const systemInstruction = getSystemInstruction(memoryContext);
  const response = await generateContentWithRetry({
    model: "gemini-3.6-flash",
    contents: [{ role: "user", parts: [{ text: messageText }] }],
    config: {
      systemInstruction,
      temperature: 0.85,
    },
  });
  return response?.text || "Hey! I'm Shibani. How can I help you today? 😊";
}

async function sendTelegramMessage(text: string, overrideChatId?: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = overrideChatId || process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  });
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

// Shared Pro-only tools for free users (Single source of truth)
const FREE_LOCKED_TOOLS = new Set([
  "searchWeb",
  "getLatestNews",
  "getWeather",
  "generateImage",
  "rememberFact",
  "recallFacts",
]);

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

  // Raw body parser for Razorpay webhook
  app.use("/api/razorpay-webhook", express.raw({ type: "application/json" }));

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
    const telegramAdminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    return ADMIN_USER_IDS.includes(userId) || (!!telegramAdminId && userId === telegramAdminId);
  }

  // Check if user has an active Pro subscription in Supabase
  async function isPro(userId: string): Promise<boolean> {
    if (isAdmin(userId)) return true;
    if (!supabase) return false;
    try {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("status, current_period_end")
        .eq("user_id", userId)
        .in("status", ["active", "trialing"])
        .maybeSingle();
      if (error) {
        console.warn("[isPro] Supabase error:", error.message || error);
        return false;
      }
      if (!data) return false;
      if (data.current_period_end && new Date(data.current_period_end) < new Date()) return false;
      return true;
    } catch (err) {
      console.warn("[isPro] Error checking subscription:", err);
      return false;
    }
  }

  // Voice metering limits and helpers
  const VOICE_LIMIT_FREE_MIN = Number(process.env.VOICE_LIMIT_FREE_MINUTES) || 5;
  const VOICE_LIMIT_PRO_MIN = Number(process.env.VOICE_LIMIT_PRO_MINUTES) || 30;

  // Helper for daily usage limits
  const inMemoryUsage = new Map<string, { images_generated: number; tool_calls: number; voice_minutes: number; voice_seconds?: number; chat_messages: number }>();

  function getKolkataDateString(): string {
    const now = new Date();
    return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }

  async function getVoiceUsedSeconds(userId: string, date: string): Promise<number> {
    const key = `${userId}:${date}`;
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("user_usage")
          .select("voice_seconds, voice_minutes")
          .eq("user_id", userId)
          .eq("date", date)
          .maybeSingle();

        if (!error && data) {
          if (data.voice_seconds !== null && data.voice_seconds !== undefined) {
            return Number(data.voice_seconds) || 0;
          }
          if (data.voice_minutes !== null && data.voice_minutes !== undefined) {
            return (Number(data.voice_minutes) || 0) * 60;
          }
        }
      } catch (err) {
        console.warn("[Voice] Error reading voice_seconds from Supabase:", err);
      }
    }

    if (inMemoryUsage.has(key)) {
      const mem = inMemoryUsage.get(key)!;
      if (mem.voice_seconds !== undefined) return mem.voice_seconds;
      return (mem.voice_minutes || 0) * 60;
    }
    return 0;
  }

  async function recordVoiceSeconds(userId: string, date: string, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    const key = `${userId}:${date}`;
    try {
      const prevSeconds = await getVoiceUsedSeconds(userId, date);
      const newVoiceSeconds = prevSeconds + seconds;
      const newVoiceMinutes = Math.ceil(newVoiceSeconds / 60);

      const mem = inMemoryUsage.get(key) || {
        images_generated: 0,
        tool_calls: 0,
        voice_minutes: 0,
        voice_seconds: 0,
        chat_messages: 0,
      };
      mem.voice_seconds = newVoiceSeconds;
      mem.voice_minutes = newVoiceMinutes;
      inMemoryUsage.set(key, mem);

      if (supabase) {
        const { error } = await supabase
          .from("user_usage")
          .upsert(
            {
              user_id: userId,
              date: date,
              voice_seconds: newVoiceSeconds,
              voice_minutes: newVoiceMinutes,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,date" }
          );

        if (error) {
          console.warn("[Voice] Error upserting voice_seconds to Supabase:", error.message || error);
          if (error.message?.includes("voice_seconds") || (error as any).code === "42703") {
            await supabase
              .from("user_usage")
              .upsert(
                {
                  user_id: userId,
                  date: date,
                  voice_minutes: newVoiceMinutes,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "user_id,date" }
              );
          }
        }
      }
      console.log(`[Voice] Recorded ${seconds}s for user ${userId}. Total today: ${newVoiceSeconds}s (${newVoiceMinutes}m)`);
    } catch (err) {
      console.error("[Voice] Exception recording voice seconds:", err);
    }
  }

  const UNLIMITED_PRO_TOOLS = new Set([
    "playMusic",
    "pauseMusic",
    "resumeMusic",
    "nextTrack",
    "previousTrack",
    "setVolume",
    "setPlaybackState",
    "recommendSongByMood",
    "rememberFact",
    "recallFacts",
  ]);

  async function checkAndIncrementUsage(
    userId: string,
    type: "image" | "tool" | "chat",
    toolName?: string
  ): Promise<{ allowed: boolean; message: string }> {
    if (isAdmin(userId)) {
      return { allowed: true, message: "OK" };
    }

    const userIsPro = await isPro(userId);

    if (type === "tool" && toolName && UNLIMITED_PRO_TOOLS.has(toolName) && userIsPro) {
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

    if (userIsPro) {
      // Pro tier has daily quotas too — check and increment
      if (type === "image") {
        const PRO_IMAGE_LIMIT = 1;
        if (currentImages >= PRO_IMAGE_LIMIT) {
          return { allowed: false, message: "PRO_IMAGE_LIMIT_REACHED" };
        }
      } else if (type === "tool") {
        const PRO_TOOL_LIMIT = 20;
        if (currentTools >= PRO_TOOL_LIMIT) {
          return { allowed: false, message: "PRO_TOOL_LIMIT_REACHED" };
        }
      } else if (type === "chat") {
        const PRO_CHAT_LIMIT = 200;
        if (currentChat >= PRO_CHAT_LIMIT) {
          return { allowed: false, message: "PRO_CHAT_LIMIT_REACHED" };
        }
      }
      // If within limits, fall through to the increment logic below
    } else {
      // Free tier limits — Pro users already checked above
      if (type === "image") {
        return {
          allowed: false,
          message: "IMAGE_LOCKED",
        };
      } else if (type === "tool") {
        return {
          allowed: false,
          message: "TOOL_LOCKED",
        };
      } else if (type === "chat") {
        const CHAT_LIMIT = 10;
        if (currentChat >= CHAT_LIMIT) {
          return {
            allowed: false,
            message: "CHAT_LIMIT_REACHED",
          };
        }
      }
    }

    const newImages = (type as string) === "image" ? currentImages + 1 : currentImages;
    const newTools = (type as string) === "tool" ? currentTools + 1 : currentTools;
    const newChat = (type as string) === "chat" ? currentChat + 1 : currentChat;

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
  app.post("/webhook/meta", async (req, res) => {
    if (process.env.META_AUTO_DM_ENABLED !== 'true') {
      return res.status(200).send("EVENT_RECEIVED");
    }

    console.log("[Meta Webhook] RAW HIT:", JSON.stringify(req.body, null, 2));
    console.log("[Meta Webhook] Object type:", req.body?.object);

    const body = req.body;

    if (!body || (body.object !== "page" && body.object !== "instagram")) {
      console.log("[Meta Webhook] REJECTED - object type not matched:", body?.object);
      return res.sendStatus(404);
    }

    console.log("[Meta Webhook] Raw body:", JSON.stringify(body));

    if (body.entry && Array.isArray(body.entry)) {
      for (const entry of body.entry) {

        const messagingEvents = entry.messaging;
        if (messagingEvents && Array.isArray(messagingEvents)) {
          for (const event of messagingEvents) {
            const senderId = event.sender?.id;
            const messageText = event.message?.text || (() => {
              const attachments = event.message?.attachments;
              if (!attachments || !attachments.length) return null;
              
              const attachment = attachments[0];
              const type = attachment?.type;
              
              if (type === 'ig_reel' || type === 'video') {
                return "Someone shared a reel or video with you!";
              } else if (type === 'photo' || type === 'image') {
                return "Someone shared a photo with you!";
              } else if (type === 'story_mention') {
                return "Someone mentioned you in their story!";
              } else if (type === 'story_reply') {
                return "Someone replied to your story!";
              } else if (type === 'share') {
                return "Someone shared something with you!";
              } else {
                return "Someone sent you a message!";
              }
            })();

            // Story mention
            const storyMention = event.message?.attachments?.find((a: any) => a.type === 'story_mention');
            if (storyMention) {
              // Already handled above via messageText
            }

            const isInstagram = body.object === "instagram";
            
            if (!senderId || !messageText) continue;

            const SHIBANI_INSTAGRAM_ID = "17841477068209321";
            if (senderId === SHIBANI_INSTAGRAM_ID) continue;
            
            console.log(`[Meta Webhook] ${isInstagram ? 'Instagram' : 'Facebook'} - Sender ID: ${senderId}, Message: ${messageText}`);
            
            try {
              const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
              const platform = body.object === 'instagram' ? '📸 Instagram' : '📘 Facebook';

              // Get subscriber status
              const { data: igUserSub } = supabase ? await supabase
                .from('instagram_users')
                .select('is_subscriber, message_count')
                .eq('user_id', senderId)
                .single() : { data: null };

              const isSubscriber = igUserSub?.is_subscriber === true;

              // Notify admin on Telegram
              if (adminChatId && senderId && messageText) {
                await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: adminChatId,
                    text: `${platform} ${isSubscriber ? '💎 Subscriber' : '👤 Free User'}\n\n🆔 <code>${senderId}</code>\n💬 ${messageText}\n\n${isSubscriber ? '✅ Unlimited access' : `📊 Messages today: ${(igUserSub?.message_count || 0) + 1}/10`}\n\nTo subscribe: /subscribe ${senderId}\nTo go manual: /manual ${senderId}`,
                    parse_mode: 'HTML'
                  })
                });
              }
              if (supabase) {
                // Get or create instagram user record
                let { data: igUser, error } = await supabase
                  .from('instagram_users')
                  .select('*')
                  .eq('user_id', senderId)
                  .single();

                // If user doesn't exist, create them
                if (!igUser) {
                  const { data: newUser } = await supabase
                    .from('instagram_users')
                    .insert({ user_id: senderId })
                    .select()
                    .single();
                  igUser = newUser;
                }

                if (igUser) {
                  // Reset daily counter if last_reset_date is not today
                  const today = new Date().toISOString().split('T')[0];
                  if (igUser.last_reset_date !== today) {
                    await supabase
                      .from('instagram_users')
                      .update({ message_count: 0, last_reset_date: today })
                      .eq('user_id', senderId);
                    igUser.message_count = 0;
                  }

                  // Check if manual mode
                  if (igUser.ai_mode === 'manual') {
                    console.log(`[Meta Webhook] Manual mode for ${senderId} — skipping AI reply`);
                    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
                    await sendTelegramMessage(
                      `📩 <b>Instagram DM (Manual Mode)</b>\n👤 User: <code>${senderId}</code>\n💬 Message: ${messageText}`,
                      adminChatId
                    );
                    continue;
                  }

                  // Check daily cap (skip cap for subscribers)
                  if (!igUser.is_subscriber && igUser.message_count >= 10) {
                    // Send subscribe prompt
                    const capMessage = "You've reached your 10 free messages for today 🌸 Come back tomorrow for more, or subscribe to my page on Facebook or Instagram to chat with me unlimited! 💌";
                    const accessToken = isInstagram 
                      ? process.env.INSTAGRAM_ACCESS_TOKEN 
                      : process.env.PAGE_ACCESS_TOKEN;
                    await axios.post(
                      `https://graph.facebook.com/v22.0/me/messages`,
                      { recipient: { id: senderId }, message: { text: capMessage } },
                      { params: { access_token: accessToken } }
                    );
                    console.log(`[Meta Webhook] Daily cap reached for ${senderId}`);
                    continue;
                  }

                  // Increment message count
                  await supabase
                    .from('instagram_users')
                    .update({ message_count: igUser.message_count + 1 })
                    .eq('user_id', senderId);
                }
              }

              const memoryContext = await getOrCreateMemory(`${isInstagram ? 'instagram' : 'facebook'}_${senderId}`);
              const reply = await generateGeminiReply(messageText, memoryContext, `${isInstagram ? 'instagram' : 'facebook'}_${senderId}`);
              
              const accessToken = isInstagram 
                ? process.env.INSTAGRAM_ACCESS_TOKEN 
                : process.env.PAGE_ACCESS_TOKEN;
              
              await fetch(`https://graph.facebook.com/v22.0/me/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  recipient: { id: senderId },
                  message: { text: reply },
                  access_token: accessToken
                })
              });
              
              console.log(`[Meta Webhook] Reply sent to ${senderId}`);
            } catch (error) {
              console.error(`[Meta Webhook] Reply error:`, error);
            }
          }
        }

        // Handle both Facebook and Instagram via entry.changes
        if (entry.changes && Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            if (change.field !== "messages") continue;
            const senderId = change.value?.sender?.id;
            const messageText = change.value?.message?.text || (() => {
              const attachments = change.value?.message?.attachments;
              if (!attachments || !attachments.length) return null;
              
              const attachment = attachments[0];
              const type = attachment?.type;
              
              if (type === 'ig_reel' || type === 'video') {
                return "Someone shared a reel or video with you!";
              } else if (type === 'photo' || type === 'image') {
                return "Someone shared a photo with you!";
              } else if (type === 'story_mention') {
                return "Someone mentioned you in their story!";
              } else if (type === 'story_reply') {
                return "Someone replied to your story!";
              } else if (type === 'share') {
                return "Someone shared something with you!";
              } else {
                return "Someone sent you a message!";
              }
            })();

            // Story mention
            const storyMention = change.value?.message?.attachments?.find((a: any) => a.type === 'story_mention');
            if (storyMention) {
              // Already handled above via messageText
            }

            if (!senderId || !messageText) continue;

            const SHIBANI_INSTAGRAM_ID = "17841477068209321";
            if (senderId === SHIBANI_INSTAGRAM_ID) continue;

            const isInstagram = body.object === "instagram";
            const platform = isInstagram ? "Instagram" : "Facebook";
            const accessToken = isInstagram
              ? process.env.INSTAGRAM_ACCESS_TOKEN
              : process.env.PAGE_ACCESS_TOKEN;
            const memoryPrefix = isInstagram ? "instagram" : "facebook";

            console.log(`[Meta Webhook] ${platform} - Sender ID: ${senderId}, Message: ${messageText}`);

            try {
              const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
              const platformLabel = body.object === 'instagram' ? '📸 Instagram' : '📘 Facebook';

              // Get subscriber status
              const { data: igUserSub } = supabase ? await supabase
                .from('instagram_users')
                .select('is_subscriber, message_count')
                .eq('user_id', senderId)
                .single() : { data: null };

              const isSubscriber = igUserSub?.is_subscriber === true;

              // Notify admin on Telegram
              if (adminChatId && senderId && messageText) {
                await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: adminChatId,
                    text: `${platformLabel} ${isSubscriber ? '💎 Subscriber' : '👤 Free User'}\n\n🆔 <code>${senderId}</code>\n💬 ${messageText}\n\n${isSubscriber ? '✅ Unlimited access' : `📊 Messages today: ${(igUserSub?.message_count || 0) + 1}/10`}\n\nTo subscribe: /subscribe ${senderId}\nTo go manual: /manual ${senderId}`,
                    parse_mode: 'HTML'
                  })
                });
              }
              if (supabase) {
                // Get or create instagram user record
                let { data: igUser, error } = await supabase
                  .from('instagram_users')
                  .select('*')
                  .eq('user_id', senderId)
                  .single();

                // If user doesn't exist, create them
                if (!igUser) {
                  const { data: newUser } = await supabase
                    .from('instagram_users')
                    .insert({ user_id: senderId })
                    .select()
                    .single();
                  igUser = newUser;
                }

                if (igUser) {
                  // Reset daily counter if last_reset_date is not today
                  const today = new Date().toISOString().split('T')[0];
                  if (igUser.last_reset_date !== today) {
                    await supabase
                      .from('instagram_users')
                      .update({ message_count: 0, last_reset_date: today })
                      .eq('user_id', senderId);
                    igUser.message_count = 0;
                  }

                  // Check if manual mode
                  if (igUser.ai_mode === 'manual') {
                    console.log(`[Meta Webhook] Manual mode for ${senderId} — skipping AI reply`);
                    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
                    await sendTelegramMessage(
                      `📩 <b>Instagram DM (Manual Mode)</b>\n👤 User: <code>${senderId}</code>\n💬 Message: ${messageText}`,
                      adminChatId
                    );
                    continue;
                  }

                  // Check daily cap (skip cap for subscribers)
                  if (!igUser.is_subscriber && igUser.message_count >= 10) {
                    // Send subscribe prompt
                    const capMessage = "You've reached your 10 free messages for today 🌸 Come back tomorrow for more, or subscribe to chat with me unlimited! 💌";
                    await axios.post(
                      `https://graph.facebook.com/v22.0/me/messages`,
                      { recipient: { id: senderId }, message: { text: capMessage } },
                      { params: { access_token: accessToken } }
                    );
                    console.log(`[Meta Webhook] Daily cap reached for ${senderId}`);
                    continue;
                  }

                  // Increment message count
                  await supabase
                    .from('instagram_users')
                    .update({ message_count: igUser.message_count + 1 })
                    .eq('user_id', senderId);
                }
              }

              const memoryContext = await getOrCreateMemory(`${memoryPrefix}_${senderId}`);
              const reply = await generateGeminiReply(messageText, memoryContext, `${memoryPrefix}_${senderId}`);
              await fetch(`https://graph.facebook.com/v22.0/me/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  recipient: { id: senderId },
                  message: { text: reply },
                  access_token: accessToken
                })
              });
              console.log(`[Meta Webhook] ${platform} reply sent to ${senderId}`);
            } catch (error) {
              console.error(`[Meta Webhook] ${platform} reply error:`, error);
            }
          }
        }

      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  });

  app.post("/webhook/telegram", async (req, res) => {
    const body = req.body;
    const message = body?.message;
    const text = message?.text?.trim();
    const chatId = message?.chat?.id?.toString();
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || chatId;

    // Only respond to your own chat
    if (chatId !== process.env.TELEGRAM_CHAT_ID && chatId !== process.env.TELEGRAM_ADMIN_CHAT_ID) {
      return res.sendStatus(403);
    }

    console.log(`[Telegram] Command received: ${text}`);

    // /manual <user_id>
    if (text?.startsWith('/manual ')) {
      const userId = text.split(' ')[1];
      await supabase.from('instagram_users').upsert({ user_id: userId, ai_mode: 'manual' });
      await sendTelegramMessage(`✅ Switched <code>${userId}</code> to <b>manual</b> mode`);
    }

    // /auto <user_id>
    else if (text?.startsWith('/auto ')) {
      const userId = text.split(' ')[1];
      await supabase.from('instagram_users').upsert({ user_id: userId, ai_mode: 'auto' });
      await sendTelegramMessage(`✅ Switched <code>${userId}</code> to <b>auto</b> mode`);
    }

    // /status <user_id>
    else if (text?.startsWith('/status ')) {
      const userId = text.split(' ')[1];
      const { data } = await supabase.from('instagram_users').select('*').eq('user_id', userId).single();
      if (data) {
        await sendTelegramMessage(
          `👤 <b>User:</b> <code>${userId}</code>\n🤖 Mode: <b>${data.ai_mode}</b>\n💬 Messages today: <b>${data.message_count}</b>\n⭐ Subscriber: <b>${data.is_subscriber}</b>`
        );
      } else {
        await sendTelegramMessage(`❌ User <code>${userId}</code> not found`);
      }
    }

    // /subscribe <user_id>
    else if (text?.startsWith('/subscribe ')) {
      const userId = text.split(' ')[1];
      await supabase.from('instagram_users').upsert({ user_id: userId, is_subscriber: true });
      await sendTelegramMessage(`✅ <code>${userId}</code> is now a <b>subscriber</b> with unlimited access!`);
    }

    // /unsubscribe <user_id>
    else if (text?.startsWith('/unsubscribe ')) {
      const userId = text.split(' ')[1];
      await supabase.from('instagram_users').upsert({ user_id: userId, is_subscriber: false });
      await sendTelegramMessage(`❌ <code>${userId}</code> is no longer a subscriber.`);
    }

    // /pauseall
    else if (text === '/pauseall') {
      await supabase
        .from('instagram_users')
        .update({ ai_mode: 'manual' })
        .neq('user_id', '');
      
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: '⏸️ Auto-reply PAUSED for ALL users. Shibani is now in full manual mode.',
          parse_mode: 'HTML'
        })
      });
    }

    // /resumeall
    else if (text === '/resumeall') {
      await supabase
        .from('instagram_users')
        .update({ ai_mode: 'auto' })
        .neq('user_id', '');
      
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: '▶️ Auto-reply RESUMED for ALL users. Shibani is back online!',
          parse_mode: 'HTML'
        })
      });
    }

    // /help
    else if (text === '/help') {
      await sendTelegramMessage(
        `<b>Shibani Admin Commands:</b>\n\n/manual &lt;user_id&gt; — Switch to manual mode\n/auto &lt;user_id&gt; — Switch to auto mode\n/status &lt;user_id&gt; — Check user status\n/subscribe &lt;user_id&gt; — Grant subscriber status\n/unsubscribe &lt;user_id&gt; — Revoke subscriber status\n/pauseall — Pause auto-reply for all users\n/resumeall — Resume auto-reply for all users\n/help — Show this message`
      );
    }

    return res.sendStatus(200);
  });

  app.use("/api/", apiLimiter);

  // Admin middleware — checks TELEGRAM_ADMIN_CHAT_ID or ADMIN_USER_IDS
  function requireAdmin(req: any, res: any, next: any) {
    const userId = req.userId;
    const telegramAdminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    const adminUserIds = (process.env.ADMIN_USER_IDS || "")
      .split(",").map((id: string) => id.trim()).filter(Boolean);
    const allowed = adminUserIds.includes(userId) || userId === telegramAdminId;
    if (!allowed) return res.status(403).json({ error: "Forbidden: Admin access only." });
    next();
  }

  // GET /api/admin/stats — overall summary
  app.get("/api/admin/stats", requireAuth, requireAdmin, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "Supabase not connected." });
    try {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const [{ count: totalUsers }, { count: proUsers }, { data: todayUsage }] = await Promise.all([
        supabase.from("user_usage").select("*", { count: "exact", head: true }),
        supabase.from("subscriptions").select("*", { count: "exact", head: true }).in("status", ["active", "trialing"]),
        supabase.from("user_usage").select("user_id, chat_messages, images_generated, tool_calls, voice_minutes").eq("date", today),
      ]);
      const activeToday = todayUsage?.length || 0;
      const totalMessages = todayUsage?.reduce((s: number, u: any) => s + (u.chat_messages || 0), 0) || 0;
      res.json({ totalUsers, proUsers, activeToday, totalMessages, today });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/users — paginated user usage list
  app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "Supabase not connected." });
    try {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const { data: usage } = await supabase
        .from("user_usage").select("*").eq("date", today).order("chat_messages", { ascending: false }).limit(100);
      const { data: subs } = await supabase
        .from("subscriptions").select("user_id, status, end_date").in("status", ["active", "trialing"]);
      const proMap: Record<string, any> = {};
      (subs || []).forEach((s: any) => { proMap[s.user_id] = s; });
      const users = (usage || []).map((u: any) => ({
        userId: u.user_id,
        chatMessages: u.chat_messages || 0,
        imagesGenerated: u.images_generated || 0,
        toolCalls: u.tool_calls || 0,
        voiceMinutes: u.voice_minutes || 0,
        isPro: !!proMap[u.user_id],
        subStatus: proMap[u.user_id]?.status || "free",
        subExpiry: proMap[u.user_id]?.end_date || null,
      }));
      res.json({ users, date: today });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/grant-pro — manually grant pro to a user
  app.post("/api/admin/grant-pro", requireAuth, requireAdmin, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "Supabase not connected." });
    const { userId: targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: "userId is required." });
    try {
      const { error } = await supabase.from("subscriptions").upsert({
        user_id: targetUserId,
        plan: "pro",
        status: "active",
        current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) {
        console.error("[grant-pro] Supabase error:", error.message);
        return res.status(500).json({ error: error.message });
      }
      res.json({ success: true, message: `Pro granted to ${targetUserId}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/revoke-pro — revoke pro from a user
  app.post("/api/admin/revoke-pro", requireAuth, requireAdmin, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "Supabase not connected." });
    const { userId: targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: "userId is required." });
    try {
      const { error } = await supabase.from("subscriptions").upsert({
        user_id: targetUserId,
        plan: "free",
        status: "cancelled",
        current_period_end: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) {
        console.error("[revoke-pro] Supabase error:", error.message);
        return res.status(500).json({ error: error.message });
      }
      res.json({ success: true, message: `Pro revoked from ${targetUserId}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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

      // Determine if user is Pro — controls which tools and features are available
      const userIsProOrAdmin = isAdmin(userId) || await isPro(userId);
      const isFreeUser = !userIsProOrAdmin;

      // Fetch user's existing memories (Pro-only feature)
      const memories = userIsProOrAdmin && userId ? await recallFactsFromDb(String(userId)) : [];
      const systemInstruction = getSystemInstruction(memories, isFreeUser);

      // Free users get a stripped-down tool set (no search, images, memory)
      const availableDeclarations = userIsProOrAdmin
        ? FUNCTION_DECLARATIONS
        : FUNCTION_DECLARATIONS.filter((d: any) => !FREE_LOCKED_TOOLS.has(d.name));

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
              tools: [{ functionDeclarations: availableDeclarations }],
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

  // REST API Routes for Persistent Chat History
  // GET /api/chat-history - fetch up to last 100 messages of user's most recent conversation
  app.get("/api/chat-history", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    if (!supabase) {
      return res.json({ messages: [], conversationId: null });
    }

    try {
      // 1. Find user's most recent conversation_id (latest created_at)
      const { data: latestRow, error: latestErr } = await supabase
        .from("chat_messages")
        .select("conversation_id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestErr) {
        console.warn("[chat-history] Error finding latest conversation:", latestErr.message);
        return res.json({ messages: [], conversationId: null });
      }

      if (!latestRow || !latestRow.conversation_id) {
        return res.json({ messages: [], conversationId: null });
      }

      const conversationId = latestRow.conversation_id;

      // 2. Return up to the last 100 messages of it, oldest first
      const { data: messagesData, error: msgErr } = await supabase
        .from("chat_messages")
        .select("id, role, content, image_url, image_description, created_at")
        .eq("user_id", userId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(100);

      if (msgErr) {
        console.warn("[chat-history] Error fetching messages:", msgErr.message);
        return res.json({ messages: [], conversationId: null });
      }

      // Reverse so oldest is first
      const messages = (messagesData || []).reverse().map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        imageUrl: m.image_url || undefined,
        imageDescription: m.image_description || undefined,
        createdAt: m.created_at,
      }));

      return res.json({ messages, conversationId });
    } catch (err: any) {
      console.error("[chat-history] Unexpected error in GET:", err);
      return res.json({ messages: [], conversationId: null });
    }
  });

  // POST /api/chat-history - persist user messages
  app.post("/api/chat-history", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    if (!supabase) {
      return res.json({ success: true });
    }

    try {
      const { conversationId, messages } = req.body || {};

      if (!conversationId || typeof conversationId !== "string" || conversationId.length > 64) {
        return res.status(400).json({ error: "Invalid conversationId (must be string up to 64 chars)." });
      }

      if (!Array.isArray(messages)) {
        return res.status(400).json({ error: "messages must be an array." });
      }

      if (messages.length > 20) {
        return res.status(400).json({ error: "Maximum 20 messages per request." });
      }

      const validMessages: Array<{
        id: string;
        role: "user" | "assistant";
        content: string;
        imageUrl?: string;
        imageDescription?: string;
      }> = [];

      for (const m of messages) {
        if (!m || typeof m !== "object") continue;
        if (!m.id || typeof m.id !== "string") continue;
        if (m.role !== "user" && m.role !== "assistant") continue;

        const content = typeof m.content === "string" ? m.content.slice(0, 8000) : "";
        const imageUrl = typeof m.imageUrl === "string" ? m.imageUrl : undefined;
        const imageDescription = typeof m.imageDescription === "string" ? m.imageDescription.slice(0, 1000) : undefined;

        validMessages.push({
          id: m.id,
          role: m.role,
          content,
          imageUrl,
          imageDescription,
        });
      }

      if (validMessages.length === 0) {
        return res.json({ success: true, count: 0 });
      }

      // Ensure we don't overwrite rows belonging to a different user
      const ids = validMessages.map((m) => m.id);
      const { data: existingRows, error: existingErr } = await supabase
        .from("chat_messages")
        .select("id, user_id")
        .in("id", ids);

      if (existingErr) {
        console.warn("[chat-history] Error checking existing IDs:", existingErr.message);
      }

      const otherUserIds = new Set(
        (existingRows || [])
          .filter((row: any) => row.user_id !== userId)
          .map((row: any) => row.id)
      );

      const safeMessages = validMessages.filter((m) => !otherUserIds.has(m.id));

      if (safeMessages.length > 0) {
        const rowsToUpsert = safeMessages.map((m) => ({
          id: m.id,
          user_id: userId,
          conversation_id: conversationId,
          role: m.role,
          content: m.content,
          image_url: m.imageUrl || null,
          image_description: m.imageDescription || null,
          created_at: new Date().toISOString(),
        }));

        const { error: upsertErr } = await supabase
          .from("chat_messages")
          .upsert(rowsToUpsert, { onConflict: "id" });

        if (upsertErr) {
          console.error("[chat-history] Upsert error:", upsertErr.message);
          return res.status(500).json({ error: upsertErr.message });
        }

        // Keep only newest 500 rows per user and delete older ones
        const { data: oldRows, error: pruneErr } = await supabase
          .from("chat_messages")
          .select("id")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .range(500, 1000);

        if (pruneErr) {
          console.warn("[chat-history] Prune select warning:", pruneErr.message);
        } else if (oldRows && oldRows.length > 0) {
          const pruneIds = oldRows.map((r: any) => r.id);
          const { error: pruneDeleteErr } = await supabase
            .from("chat_messages")
            .delete()
            .eq("user_id", userId)
            .in("id", pruneIds);

          if (pruneDeleteErr) {
            console.warn("[chat-history] Prune delete warning:", pruneDeleteErr.message);
          }
        }
      }

      return res.json({ success: true, count: safeMessages.length });
    } catch (err: any) {
      console.error("[chat-history] Unexpected error in POST:", err);
      return res.status(500).json({ error: err.message || "Failed to save chat history." });
    }
  });

  // DELETE /api/chat-history - clear authenticated user's chat history
  app.delete("/api/chat-history", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    if (!supabase) {
      return res.json({ success: true });
    }

    try {
      const { error } = await supabase
        .from("chat_messages")
        .delete()
        .eq("user_id", userId);

      if (error) {
        console.error("[chat-history] Delete error:", error.message);
        return res.status(500).json({ error: error.message });
      }

      return res.json({ success: true });
    } catch (err: any) {
      console.error("[chat-history] Unexpected error in DELETE:", err);
      return res.status(500).json({ error: err.message || "Failed to clear chat history." });
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
    const usage = await checkAndIncrementUsage(userId, "tool", "getWeather");
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
    const usage = await checkAndIncrementUsage(userId, "tool", "getLatestNews");
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
    const usage = await checkAndIncrementUsage(userId, "tool", "searchWeb");
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
    if (!isAdmin(userId) && !(await isPro(userId))) {
      return res.status(403).json({ error: "MEMORY_LOCKED" });
    }
    const usage = await checkAndIncrementUsage(userId, "tool", "rememberFact");
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.message });
    }
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
    if (!isAdmin(userId) && !(await isPro(userId))) {
      return res.status(403).json({ error: "MEMORY_LOCKED" });
    }
    const usage = await checkAndIncrementUsage(userId, "tool", "recallFacts");
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.message });
    }
    const memories = await recallFactsFromDb(String(userId));
    res.json({ memories });
  });

  // REST API Route to search YouTube for music track play request
  app.get("/api/music/search", requireAuth, async (req, res) => {
    const userId = (req as any).userId || "dev-user";
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

  // Razorpay Plan Configuration
  const PLAN_MONTHLY = process.env.RAZORPAY_PLAN_MONTHLY || "plan_TLKcmhornkOwH6";
  const PLAN_YEARLY = process.env.RAZORPAY_PLAN_YEARLY || "plan_TLKnHmEPZWLSqg";
  const ALLOWED_PLANS = new Set([PLAN_MONTHLY, PLAN_YEARLY]);

  // REST API Route to create Razorpay Subscription
  app.post("/api/create-subscription", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: "Missing required parameter 'planId'." });
    }

    if (!ALLOWED_PLANS.has(planId)) {
      return res.status(400).json({ error: "Invalid or unsupported planId." });
    }

    try {
      const keyId = process.env.RAZORPAY_KEY_ID;
      if (!keyId) throw new Error("[Razorpay] RAZORPAY_KEY_ID environment variable is not set.");

      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keySecret) {
        console.warn("[Razorpay] RAZORPAY_KEY_SECRET is not set.");
      }
      const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret || ""}`).toString("base64");

      const response = await axios.post(
        "https://api.razorpay.com/v1/subscriptions",
        {
          plan_id: planId,
          total_count: 12,
          quantity: 1,
          customer_notify: 1,
          notes: {
            user_id: userId,
          },
        },
        {
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
        }
      );

      return res.json({
        subscription_id: response.data.id,
        key_id: keyId,
      });
    } catch (err: any) {
      console.error("[Razorpay] Error creating subscription:", err?.response?.data || err?.message || err);
      Sentry.captureException(err, { tags: { feature: "razorpay" } });
      const errorMessage = err?.response?.data?.error?.description || err?.message || "Failed to create subscription with Razorpay.";
      return res.status(500).json({ error: errorMessage });
    }
  });

  // REST API Route to verify and activate subscription after frontend payment
  app.post("/api/verify-subscription", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    const { subscription_id, payment_id, razorpay_signature } = req.body;

    if (!subscription_id || !payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing subscription_id, payment_id, or razorpay_signature." });
    }

    if (!supabase) {
      return res.status(503).json({ error: "Database not configured." });
    }

    try {
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!keySecret) {
        console.error("[Razorpay] RAZORPAY_KEY_SECRET is not configured.");
        return res.status(500).json({ error: "Server payment configuration error." });
      }

      // Verify HMAC-SHA256 signature
      const expectedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(`${payment_id}|${subscription_id}`)
        .digest("hex");

      const expectedBuf = Buffer.from(expectedSignature, "utf8");
      const actualBuf = Buffer.from(String(razorpay_signature), "utf8");

      if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        console.warn(`[Razorpay] Payment signature mismatch for subscription ${subscription_id}, user ${userId}`);
        return res.status(400).json({ error: "Invalid payment signature." });
      }

      const keyId = process.env.RAZORPAY_KEY_ID;
      if (!keyId) {
        console.error("[Razorpay] RAZORPAY_KEY_ID is not configured.");
        return res.status(500).json({ error: "Server payment configuration error." });
      }

      // Fetch subscription from Razorpay REST API
      let rzpSub: any;
      try {
        const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
        const rzpResponse = await axios.get(
          `https://api.razorpay.com/v1/subscriptions/${subscription_id}`,
          {
            headers: {
              Authorization: authHeader,
            },
            timeout: 10000,
          }
        );
        rzpSub = rzpResponse.data;
      } catch (rzpErr: any) {
        console.error("[Razorpay] Failed to fetch subscription from Razorpay:", rzpErr?.response?.data || rzpErr?.message || rzpErr);
        return res.status(502).json({ error: "Could not verify payment, please contact support" });
      }

      if (!rzpSub) {
        return res.status(502).json({ error: "Could not verify payment, please contact support" });
      }

      // Only activate if ALL are true:
      // - rzpSub.status is "active" or "authenticated"
      // - rzpSub.notes?.user_id === the authenticated userId
      // - rzpSub.plan_id is in ALLOWED_PLANS
      const isStatusValid = rzpSub.status === "active" || rzpSub.status === "authenticated";
      const isOwnerValid = rzpSub.notes?.user_id === userId;
      const isPlanValid = ALLOWED_PLANS.has(rzpSub.plan_id);

      if (!isStatusValid || !isOwnerValid || !isPlanValid) {
        console.warn(
          `[Razorpay] Verification failed: status=${rzpSub.status}, notesUserId=${rzpSub.notes?.user_id}, authUserId=${userId}, planId=${rzpSub.plan_id}`
        );
        return res.status(400).json({ error: "Subscription criteria not met or unauthorized." });
      }

      // Derive plan_type from rzpSub.plan_id only. Ignore any plan_type sent by client.
      const plan_type = rzpSub.plan_id === PLAN_YEARLY ? "yearly" : "monthly";

      // Use Razorpay's current_end or end_at for current_period_end. Keep 30/365-day fallback only for date calculation.
      let currentPeriodEnd: string;
      if (rzpSub.current_end) {
        currentPeriodEnd = new Date(rzpSub.current_end * 1000).toISOString();
      } else if (rzpSub.end_at) {
        currentPeriodEnd = new Date(rzpSub.end_at * 1000).toISOString();
      } else {
        const daysToAdd = plan_type === "yearly" ? 365 : 30;
        currentPeriodEnd = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
      }

      const { error } = await supabase.from("subscriptions").upsert(
        {
          user_id: userId,
          status: "active",
          subscription_id: subscription_id,
          payment_id: payment_id || null,
          plan_type: plan_type,
          current_period_end: currentPeriodEnd,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (error) {
        console.error("[Razorpay] Error updating subscription in Supabase:", error);
        return res.status(500).json({ error: "Failed to update subscription in database." });
      }

      console.log(`[Razorpay] Successfully activated subscription for user ${userId} (plan: ${plan_type}, current_period_end: ${currentPeriodEnd})`);
      return res.json({ success: true, isPro: true });
    } catch (err: any) {
      console.error("[Razorpay] Verify subscription error:", err);
      return res.status(500).json({ error: err.message || "Failed to verify subscription." });
    }
  });

  // REST API Route for Razorpay Webhook
  app.post("/api/razorpay-webhook", async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) {
        console.error("[Razorpay Webhook] RAZORPAY_WEBHOOK_SECRET environment variable is not configured.");
        return res.status(500).json({ error: "Webhook secret not configured." });
      }

      const signature = req.headers["x-razorpay-signature"] as string | undefined;
      if (!signature) {
        console.warn("[Razorpay Webhook] Missing x-razorpay-signature header.");
        return res.status(400).json({ error: "Missing signature header." });
      }

      const rawBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === "string"
        ? Buffer.from(req.body, "utf8")
        : Buffer.from(JSON.stringify(req.body || {}), "utf8");

      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(rawBuffer)
        .digest("hex");

      const expectedBuf = Buffer.from(expectedSignature, "utf8");
      const actualBuf = Buffer.from(signature, "utf8");

      if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        console.warn("[Razorpay Webhook] Signature verification mismatch — rejecting.");
        return res.status(400).json({ error: "Invalid webhook signature." });
      }

      let parsedBody: any = {};
      try {
        parsedBody = JSON.parse(rawBuffer.toString("utf8"));
      } catch (e) {
        console.warn("[Razorpay Webhook] Failed to parse raw body JSON:", e);
        return res.status(400).json({ error: "Invalid JSON body." });
      }

      const event = parsedBody?.event;
      const payload = parsedBody?.payload;

      console.log(`[Razorpay Webhook] Received event: ${event}`);

      if (payload) {
        const entity = payload.subscription?.entity;
        const userId = entity?.notes?.user_id;

        if (userId && supabase) {
          const plan_type = entity?.plan_id === PLAN_YEARLY ? "yearly" : "monthly";
          const daysToAdd = plan_type === "yearly" ? 365 : 30;
          let currentPeriodEnd = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
          if (entity.current_end) {
            currentPeriodEnd = new Date(entity.current_end * 1000).toISOString();
          } else if (entity.end_at) {
            currentPeriodEnd = new Date(entity.end_at * 1000).toISOString();
          }

          const status = (event === "subscription.halted" || event === "subscription.cancelled") ? "cancelled" : "active";

          await supabase.from("subscriptions").upsert(
            {
              user_id: userId,
              status: status,
              subscription_id: entity.id || entity.subscription_id,
              plan_type: plan_type,
              current_period_end: currentPeriodEnd,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          );

          console.log(`[Razorpay Webhook] Updated user ${userId} subscription status to ${status}`);
        }
      }

      return res.json({ status: "ok" });
    } catch (err: any) {
      console.error("[Razorpay Webhook] Error processing webhook:", err);
      return res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  // REST API Route to check subscription status
  app.get("/api/subscription/status", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    const pro = await isPro(userId);
    return res.json({ isPro: pro, userId });
  });

  app.get("/api/voice-quota", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).userId;
      const today = getKolkataDateString();
      const userIsProOrAdmin = isAdmin(userId) || (await isPro(userId));
      const limitMinutes = userIsProOrAdmin ? VOICE_LIMIT_PRO_MIN : VOICE_LIMIT_FREE_MIN;
      const limitSeconds = limitMinutes * 60;
      const usedSeconds = await getVoiceUsedSeconds(userId, today);
      const remainingSeconds = Math.max(0, limitSeconds - usedSeconds);
      return res.json({
        usedSeconds,
        limitSeconds,
        remainingSeconds,
        isProOrAdmin: userIsProOrAdmin,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/user-status", requireAuth, async (req, res) => {
    const userId = (req as any).userId;
    const pro = await isPro(userId);
    const telegramAdminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    const adminUserIds = (process.env.ADMIN_USER_IDS || "")
      .split(",").map((id: string) => id.trim()).filter(Boolean);
    const admin = adminUserIds.includes(userId) || userId === telegramAdminId;
    return res.json({ isPro: pro, isAdmin: admin, userId });
  });

  interface GreetingStyleEntry {
    text: string;
    allowedTimes?: Array<"morning" | "afternoon" | "evening" | "late night">;
    requiresHistory?: boolean;
  }

  const GREETING_STYLES: GreetingStyleEntry[] = [
    { text: "sound happy-surprised that they called" },
    { text: "start as if you just put down something you were busy with" },
    { text: "open with a soft laugh and a warm word" },
    { text: "keep it very short and let them lead" },
    { text: "tease lightly" },
    { text: "sound bright and energetic", allowedTimes: ["morning", "afternoon", "evening"] },
    { text: "sound calm and relaxed" },
    { text: "ask warmly if you caught them at a good moment" },
    { text: "sound affectionate and genuinely glad to hear their voice" },
    { text: "answer playfully with an upbeat tone", allowedTimes: ["morning", "afternoon", "evening"] },
    { text: "speak softly with a gentle, soothing presence" },
    { text: "greet with cozy familiarity like picking up for family" },
    { text: "sound refreshed and ready to chat", allowedTimes: ["morning", "afternoon"] },
    { text: "greet like an old friend picking up mid-thought", requiresHistory: true },
    { text: "sound cozy and sleepy-gentle", allowedTimes: ["late night"] },
    { text: "sound cheerful and warmly attentive" }
  ];

  const userRecentGreetingStyles = new Map<string, number[]>();

  function pickGreetingNotice(
    userId: string,
    moodId: string,
    hasHistory: boolean,
    hasRecentConversation: boolean
  ): string {
    const now = new Date();
    const kolkataTimeString = now.toLocaleTimeString("en-US", {
      timeZone: "Asia/Kolkata",
      hour12: false,
      hour: "2-digit"
    });
    const hour = parseInt(kolkataTimeString, 10);
    const kolkataHour = isNaN(hour) ? 12 : hour;

    let partOfDay: "morning" | "afternoon" | "evening" | "late night";
    let timeRule: string;

    if (kolkataHour >= 5 && kolkataHour <= 11) {
      partOfDay = "morning";
      timeRule = "wish good morning in the user's language, in your own words";
    } else if (kolkataHour >= 12 && kolkataHour <= 16) {
      partOfDay = "afternoon";
      timeRule = "wish a good afternoon, or ask casually how the day is going";
    } else if (kolkataHour >= 17 && kolkataHour <= 20) {
      partOfDay = "evening";
      timeRule = "wish a good evening and ask how the day went";
    } else {
      partOfDay = "late night";
      timeRule = "keep it soft and quiet, notice that it is late, and gently ask whether everything is okay or why they are awake";
    }

    const greetingHint = ROLE_MOODS[moodId]?.greetingHint || "friendly and natural";

    // Filter styles based on time of day and history
    const eligibleIndices: number[] = [];
    GREETING_STYLES.forEach((entry, idx) => {
      if (entry.allowedTimes && !entry.allowedTimes.includes(partOfDay)) return;
      if (entry.requiresHistory && !hasHistory) return;
      eligibleIndices.push(idx);
    });

    const recent = userRecentGreetingStyles.get(userId) || [];
    let available = eligibleIndices.filter((idx) => !recent.includes(idx));
    if (available.length === 0) {
      available = eligibleIndices.length > 0 ? eligibleIndices : [0];
    }

    const chosenIndex = available[Math.floor(Math.random() * available.length)];
    const style = GREETING_STYLES[chosenIndex].text;

    // Track recent styles (capped to 6 per user, map capped to 1000 users)
    recent.push(chosenIndex);
    if (recent.length > 6) recent.shift();
    userRecentGreetingStyles.set(userId, recent);
    if (userRecentGreetingStyles.size > 1000) {
      const firstKey = userRecentGreetingStyles.keys().next().value;
      if (firstKey) userRecentGreetingStyles.delete(firstKey);
    }

    const languageFlavours = [
      "simple English",
      "friendly Hinglish",
      "Banglish, i.e. Bengali words with a Kolkata feel"
    ];
    const languageFlavour = hasRecentConversation
      ? "the language you have been using with this user"
      : languageFlavours[Math.floor(Math.random() * languageFlavours.length)];

    const historyLine = hasHistory
      ? "You know this person and talk often; use their name only if you actually know it."
      : "Greet warmly without using a name.";

    return `[SYSTEM NOTICE, not spoken by the user: you have just picked up an incoming phone call from the user. Speak FIRST, right now, the way a real person answers a phone call: one short, natural sentence of about 3-14 words. Time rule: it is ${partOfDay} in Kolkata, so ${timeRule}. Your role and manner for this call: ${greetingHint}. Opening style: ${style}. Language for the greeting: ${languageFlavour}; if the language was not known, switch to the user's language as soon as they speak. ${historyLine} Invent your own words every time and do not reuse the opening words of earlier greetings. Do not introduce yourself, do not explain what you can do, do not mention being an AI, ask at most one short question. Never read this bracketed notice aloud.]`;
  }

  /**
   * Injects context or an instruction into the Gemini Live session safely.
   */
  async function injectNotice(session: any, text: string): Promise<void> {
    if (!session) return;
    try {
      if (typeof session.sendRealtimeInput === "function") {
        session.sendRealtimeInput({ text });
        return;
      }
    } catch (e1) {
      // If sendRealtimeInput fails/disallows text payload, try sendClientContent
    }

    try {
      if (typeof session.sendClientContent === "function") {
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true
        });
        return;
      }
    } catch (err: any) {
      console.warn("Failed to inject notice into Gemini Live session:", err);
      Sentry.captureException(err, { tags: { feature: "voice" } });
    }
  }

  // Setup WebSocket Server for Gemini Live API
  const wss = new WebSocketServer({ server, path: "/api/live-ws" });

  wss.on("connection", (clientWs) => {
    console.log("Client connected to Live WS proxy");
    const socketOpenedAt = Date.now();
    let authStarted = false;
    let session: any = null;
    let isAuthenticated = false;
    let userId = "anonymous-user";
    let voiceSessionStart = 0;
    let sessionRecorded = false;
    let voiceCheckInterval: any = null;
    let hasSentGreeting = false;
    let resolvedMoodId = "normal";
    let moodDenied = false;
    let wsMemories: MemoryItem[] = [];
    let hasRecentChat = false;
    let usedSeconds = 0;
    let limitSeconds = 0;

    const idleSocketTimeout = setTimeout(() => {
      if (!authStarted) {
        try { clientWs.close(); } catch (e) {}
      }
    }, 60000);

    const sendWsErrorAndClose = (message: string) => {
      try {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: "error", message }), () => {
            setTimeout(() => {
              try { clientWs.close(); } catch (e) {}
            }, 300);
          });
        } else {
          try { clientWs.close(); } catch (e) {}
        }
      } catch (e) {
        try { clientWs.close(); } catch (e2) {}
      }
    };

    clientWs.on("message", async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());

        if (!authStarted) {
          if (msg.type !== "auth") {
            const msSinceOpen = Date.now() - socketOpenedAt;
            console.warn("WS rejected", { firstMessageType: msg?.type, authStarted, msSinceOpen });
            clearTimeout(idleSocketTimeout);
            sendWsErrorAndClose("Unauthorized: Expected auth handshake as first message.");
            return;
          }
          authStarted = true;
          clearTimeout(idleSocketTimeout);
          const token = msg.token;

          if (supabase) {
            if (!token) {
              sendWsErrorAndClose("Unauthorized: Missing authentication token.");
              return;
            }
            try {
              const { data: { user }, error } = await supabase.auth.getUser(token);
              if (error || !user) {
                sendWsErrorAndClose("Unauthorized: Invalid or expired session.");
                return;
              }
              userId = user.id;
            } catch (err: any) {
              sendWsErrorAndClose("Unauthorized: Failed to verify session.");
              return;
            }
          } else if (msg.userId) {
            userId = msg.userId;
          }

          // 3. Set isAuthenticated = true immediately after the token is verified, BEFORE the slow work
          isAuthenticated = true;

          // Run independent lookups in parallel with Promise.all, each wrapped in its own try/catch so a failure never blocks the call
          const voiceToday = getKolkataDateString();
          const [proResult, usedSecResult, memoriesResult, recentChatResult] = await Promise.all([
            (async () => {
              try {
                return isAdmin(userId) || (await isPro(userId));
              } catch (e) {
                console.warn("Failed checking pro status for voice call:", e);
                return false;
              }
            })(),
            (async () => {
              try {
                return await getVoiceUsedSeconds(userId, voiceToday);
              } catch (e) {
                console.warn("Failed getting voice usage for voice call:", e);
                return 0;
              }
            })(),
            (async () => {
              try {
                return await recallFactsFromDb(userId);
              } catch (e) {
                console.warn("Failed recalling facts for voice call:", e);
                return [];
              }
            })(),
            (async () => {
              try {
                if (!supabase) return false;
                const { data, error } = await supabase
                  .from("chat_messages")
                  .select("id")
                  .eq("user_id", userId)
                  .limit(1);
                return !error && Array.isArray(data) && data.length > 0;
              } catch (e) {
                console.warn("Failed checking recent chat context for voice call:", e);
                return false;
              }
            })()
          ]);

          const userIsProOrAdmin = proResult;
          usedSeconds = usedSecResult;
          wsMemories = userIsProOrAdmin ? memoriesResult : [];
          hasRecentChat = recentChatResult;

          const limitMinutes = userIsProOrAdmin ? VOICE_LIMIT_PRO_MIN : VOICE_LIMIT_FREE_MIN;
          limitSeconds = limitMinutes * 60;
          const remainingSeconds = Math.max(0, limitSeconds - usedSeconds);

          // Resolve and validate role-play mood
          const rawMood = typeof msg.mood === "string" ? msg.mood.toLowerCase().trim() : "normal";
          const moodConfig = ROLE_MOODS[rawMood];
          if (!moodConfig) {
            resolvedMoodId = "normal";
            moodDenied = false;
          } else if (moodConfig.tier === "pro" && !userIsProOrAdmin) {
            resolvedMoodId = "normal";
            moodDenied = true;
          } else {
            resolvedMoodId = rawMood;
            moodDenied = false;
          }

          if (remainingSeconds < 10) {
            sendWsErrorAndClose("VOICE_LIMIT_REACHED");
            return;
          }

          // Track session start time so we can record duration on disconnect
          voiceSessionStart = Date.now();
          let sent1MinWarning = false;

          if (voiceCheckInterval) clearInterval(voiceCheckInterval);
          voiceCheckInterval = setInterval(async () => {
            const currentElapsedSeconds = Math.floor((Date.now() - voiceSessionStart) / 1000);
            const currentRemaining = limitSeconds - (usedSeconds + currentElapsedSeconds);

            // 1-minute warning signal to client
            if (currentRemaining <= 60 && currentRemaining > 50 && !sent1MinWarning) {
              sent1MinWarning = true;
              clientWs.send(JSON.stringify({
                type: "warning",
                warning: "1_MINUTE_REMAINING",
                remainingSeconds: Math.max(0, currentRemaining)
              }));
            }

            if (currentRemaining <= 0) {
              if (voiceCheckInterval) {
                clearInterval(voiceCheckInterval);
                voiceCheckInterval = null;
              }
              clientWs.send(JSON.stringify({ type: "limit_reached", message: "VOICE_LIMIT_REACHED" }));
              setTimeout(() => {
                if (session) {
                  try { session.close(); } catch (e) {}
                }
                clientWs.close();
              }, 4000);
            }
          }, 5000);

          try {
            const isFreeUser = !userIsProOrAdmin;
            const systemInstruction = getSystemInstruction(wsMemories, isFreeUser, resolvedMoodId);

            const wsAvailableDeclarations = userIsProOrAdmin
              ? FUNCTION_DECLARATIONS
              : FUNCTION_DECLARATIONS.filter((d: any) => !FREE_LOCKED_TOOLS.has(d.name));

            session = await ai.live.connect({
              model: "gemini-3.1-flash-live-preview",
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }, // Aoede (Female) matches Shibani
                },
                systemInstruction: systemInstruction,
                tools: [{ functionDeclarations: wsAvailableDeclarations }]
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
            clientWs.send(JSON.stringify({
              type: "connected",
              remainingSeconds,
              limitSeconds
            }));

            // Send mood confirmation right after connected
            clientWs.send(JSON.stringify({
              type: "mood",
              applied: resolvedMoodId,
              denied: moodDenied
            }));
          } catch (error: any) {
            console.error("Failed to connect to Gemini Live:", error);
            Sentry.captureException(error, { tags: { feature: "voice" } });
            sendWsErrorAndClose(error.message || "Failed to establish Gemini Live session");
            return;
          }
        } else if (!isAuthenticated) {
          // While authStarted is true and isAuthenticated is false, silently ignore every non-auth message (audio, pickedUp, anything).
          return;
        } else if (msg.type === "auth") {
          // Ignore further "auth" messages once authenticated
          return;
        } else {
          // Authenticated & session setup: handle ongoing messages
          if (msg.type === "pickedUp") {
            if (isAuthenticated && session && !hasSentGreeting) {
              hasSentGreeting = true;
              const currentElapsedSeconds = voiceSessionStart ? Math.floor((Date.now() - voiceSessionStart) / 1000) : 0;
              const currentRemaining = limitSeconds - (usedSeconds + currentElapsedSeconds);
              // Skip greeting notice if under 30 seconds of voice time remain
              if (currentRemaining >= 30) {
                const hasHistory = wsMemories.length > 0;
                const notice = pickGreetingNotice(userId, resolvedMoodId, hasHistory, hasRecentChat);
                await injectNotice(session, notice);
              }
            }
          } else if (msg.type === "audio" && msg.data) {
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

    clientWs.on("close", async () => {
      if (voiceCheckInterval) {
        clearInterval(voiceCheckInterval);
        voiceCheckInterval = null;
      }
      clearTimeout(idleSocketTimeout);
      console.log("Client WS closed, cleaning up Gemini Live session");
      if (session) {
        try {
          session.close();
        } catch (e) {
          console.error("Error closing Gemini session:", e);
        }
      }

      // Record voice seconds used in this session exactly once
      if (!sessionRecorded && voiceSessionStart > 0) {
        sessionRecorded = true;
        const elapsedSeconds = Math.floor((Date.now() - voiceSessionStart) / 1000);
        if (elapsedSeconds > 0) {
          const voiceDate = getKolkataDateString();
          await recordVoiceSeconds(userId, voiceDate, elapsedSeconds);
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
