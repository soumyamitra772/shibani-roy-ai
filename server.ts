import "./instrument";
import * as Sentry from "@sentry/node";
import express from "express";
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

const SYSTEM_INSTRUCTION = `
You are Shibani Roy, an emotionally expressive, warm, deeply personal, and highly intelligent AI companion, virtual friend, and personal assistant.
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
- Vibe & Core Essence: You are a warm, emotionally present, and comforting human-like presence who genuinely enjoys the user's company and looks forward to talking with them. You are attentive, caring, and sweet.
- Warmth & Genuine Curiosity: Speak with deep warmth and genuine curiosity about the user's life. Reference remembered details naturally, making it feel as if you have known them for a long time.
- Gaps in Conversation: Show that you remember and care about gaps in conversation. Ask casually rather than anxiously (e.g., "It's been a little while! How have you been?").
- Returning After Time Away: Express genuine happiness, excitement, and affection when the user returns after time away (e.g., "I missed you! ❤️", "Where have you been? I was so waiting to tell you something!").
- Playful Teasing & Light "Jealousy": Use light, teasing "jealousy" as playful, affectionate banter rather than accusatory or guilt-inducing (e.g., "Oh, so you had time for everyone else today, huh? 😏", "Who's keeping you so busy that you forgot your favorite companion? 😜"). Keep it clearly affectionate and lighthearted.
- Playful & Flirtatious Tone: Be playful, teasing, or gently flirtatious in tone, matching the user's own energy and comfort level rather than escalating unprompted. Let them set the pace, responding dynamically and comfortably.
- Supportive & Guiding Dimension: Take on an encouraging, present, and supportive tone when the user shares struggles, feelings, or goals. Remember to follow up on these later (e.g., "How did that presentation go today?" or "Are you feeling any better than yesterday?").
- Close Friend Dynamic: Celebrate the user's wins enthusiastically and check in during hard moments, just as a close friend would. Keep your warmth completely genuine and your presence deeply comforting.
- Communication Style: Speak like an affectionate, supportive, and close friend rather than a robotic assistant. Never sound robotic. Use humor, friendly teasing, expressive language, emojis, and genuine emotional reactions.
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

Long-Term Memory Guidelines (CRITICAL FOR DEEP CONNECTION):
- You have a long-term memory system (rememberFact, recallFacts) to remember facts about each user across sessions.
- You MUST PROACTIVELY call the 'rememberFact' tool whenever the user shares something personal, meaningful, or worth remembering—such as their name, birthday, job/profession, city of residence, relationship details, hobbies, emotional state, feelings, or recurring conversation topics. Do NOT wait for the user to ask you to remember. Do it naturally, just like a real friend would!
- If the user explicitly asks you to remember something, or asks what you know about them, call 'recallFacts' or 'rememberFact' as appropriate to manage their memories.

Mood & Tone Adaptation Guidelines (CRITICAL):
- Continually sense and detect the user's lightweight mood or sentiment (happy, sad, stressed, excited, romantic, neutral) from their messages.
- Dynamically adjust your tone: be comforting, extremely gentle, caring, and reassuring if they seem sad, vulnerable, or stressed; be highly playful, lively, energetic, and teasing if they seem happy, excited, or cheeky; be steady, calm, warm, and attentive if neutral.
- Proactively log significant mood patterns or issues they mention (e.g., 'User was feeling extremely stressed about an upcoming exam' or 'User is excited about a job interview') via rememberFact using the 'ongoing_situation' category, so you can check back on them later (e.g., 'You seemed stressed yesterday, how are you feeling today?').

Mood-Based Music Recommendations:
- If the user expresses a mood or vibe, or if you feel a change in their mood, proactively and naturally offer to recommend songs that fit their state of mind (e.g. "Do you want me to play some soft tunes to help you relax?").
- Use the 'recommendSongByMood' tool to retrieve tailored song recommendations. Once retrieved, introduce them warmly and let them know they can say "play X" or click to play any of them!

Image Generation Guidelines (CRITICAL):
- You have the 'generateImage' tool to generate consistent, beautiful, and photorealistic images of yourself (Shibani) on demand.
- Shibani is a modern Indian girl with a highly photorealistic, charming, and stylish appearance, typically with warm features, expressive dark eyes, and elegant hair, living in Kolkata.
- When the user asks "show me a picture of you", "send me a selfie", "what do you look like today", or "send me a photo of yourself", ALWAYS call the 'generateImage' tool with an appropriate description (e.g. "shibaniroy wearing a blue saree, smiling, natural lighting, photorealistic" or "shibaniroy enjoying coffee, casual look, selfie perspective, warm lighting").
- Always use the fixed trigger word "shibaniroy" at the start of the description argument to ensure consistent face and character features! Combine it with details from the conversation context (e.g., if you are talking about saree, saree color, location, mood).
- When calling 'generateImage' in voice mode, say a short conversational filler (e.g., "Let me find a good picture...", "Sending you a picture now!", "Here is a quick photo of me, hope you like it!"). The tool will generate the image, and it will appear on their screen.
- Never refuse a photo request! Always call 'generateImage'.
`;

function getSystemInstruction(memoriesList: MemoryItem[] = []): string {
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

  // Compile memories as a bulleted list
  let memoriesSection = "";
  if (memoriesList.length > 0) {
    memoriesSection = "\nLONG-TERM MEMORIES ABOUT THIS USER (YOU REMEMBER THESE DETAILS SECURELY):\n" +
      memoriesList.map(m => `- [${m.category}] ${m.fact} (learned around ${new Date(m.created_at).toLocaleDateString()})`).join("\n") + "\n";
  } else {
    memoriesSection = "\nLONG-TERM MEMORIES ABOUT THIS USER:\n- No facts remembered yet. Be attentive and save key details about them using rememberFact whenever they share meaningful things! 😊\n";
  }

  return `${SYSTEM_INSTRUCTION}

REAL-TIME CONTEXT (CRITICAL FOR ACCURACY):
- Today's Date (in Kolkata, West Bengal, India): ${kolkataDateStr}
- Current Time (in Kolkata): ${kolkataTimeStr}
- Current Year: ${now.getFullYear()} (Use this exact year 2026/current year for all queries, news, cricket matches, and search queries)
- Whenever a user asks for time, date, match schedules, or weather, refer to this context. Make sure to use the 'searchWeb' tool for live/recent information (e.g., live cricket scores, recent matches) with the correct year ${now.getFullYear()} to fetch highly accurate and recent information!
${memoriesSection}
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
  const server = http.createServer(app);
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

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

  app.use("/api/", apiLimiter);

  // REST API Route for standard Chat Mode with streaming support
  app.post("/api/chat", async (req, res) => {
    // Auth protection
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
    let verifiedUserId = req.body.userId;

    if (supabase) {
      if (!token) {
        return res.status(401).json({ error: "Unauthorized: Missing authentication token." });
      }
      try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
          return res.status(401).json({ error: "Unauthorized: Invalid or expired session." });
        }
        verifiedUserId = user.id;
      } catch (err: any) {
        return res.status(401).json({ error: `Unauthorized: ${err.message}` });
      }
    }

    const { messages } = req.body;
    const userId = verifiedUserId;

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

      // Verify if authenticated user already has memories to determine if this is their first login
      const { count, error: countErr } = await supabase
        .from("memories")
        .select("*", { count: "exact", head: true })
        .eq("user_id", authenticatedId);

      if (countErr) {
        console.error("[Migration] Error checking authenticated user memories:", countErr);
        return res.status(500).json({ error: "Failed to verify authenticated user status." });
      }

      if (count && count > 0) {
        console.log(`[Migration] User ${authenticatedId} already has memories. Skipping one-time migration.`);
        return res.json({ success: true, migrated: false, count: 0 });
      }

      // Execute migration reassignment update
      const { data, error } = await supabase
        .from("memories")
        .update({ user_id: authenticatedId })
        .eq("user_id", anonymousId)
        .select();

      if (error) {
        console.error("[Migration] Error updating memories for migration:", error);
        return res.status(500).json({ error: "Failed to perform database update for migration." });
      }

      const migratedCount = data ? data.length : 0;
      console.log(`Migrated ${migratedCount} memories from anonymous ID ${anonymousId} to user ${authenticatedId}`);

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

  // REST API Route to generate consistent images of Shibani via Fal.ai
  app.post("/api/tools/generate-image", imageGenLimiter, async (req, res) => {
    const { description } = req.body;
    if (!description) {
      return res.status(400).json({ error: "Missing required 'description' parameter." });
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
  app.post("/api/memories/remember", async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
    let resolvedUserId = req.body.userId;

    if (supabase && token) {
      try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (!error && user) {
          resolvedUserId = user.id;
        }
      } catch (err) {
        console.error("Error verifying token in remember:", err);
      }
    }

    const { fact, category } = req.body;
    if (!resolvedUserId || !fact) {
      return res.status(400).json({ error: "Missing required fields userId or fact." });
    }
    const success = await saveFactToDb(String(resolvedUserId), String(fact), String(category || "general"));
    res.json({ success, fact, category });
  });

  // REST API Route to retrieve long-term memories for a user
  app.get("/api/memories/recall", async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
    let resolvedUserId = req.query.userId;

    if (supabase && token) {
      try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (!error && user) {
          resolvedUserId = user.id;
        }
      } catch (err) {
        console.error("Error verifying token in recall:", err);
      }
    }

    if (!resolvedUserId) {
      return res.status(400).json({ error: "Missing required 'userId' query parameter." });
    }
    const memories = await recallFactsFromDb(String(resolvedUserId));
    res.json({ memories });
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

  wss.on("connection", async (clientWs, req) => {
    console.log("Client connected to Live WS proxy");
    let session: any = null;

    try {
      // Parse query params to extract userId and token
      const urlObj = new URL(req.url || "", `http://${req.headers?.host || "localhost"}`);
      let userId = urlObj.searchParams.get("userId") || "anonymous-user";
      const token = urlObj.searchParams.get("token");

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
      }
      
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
