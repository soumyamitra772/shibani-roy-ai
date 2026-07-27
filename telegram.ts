/**
 * Telegram Chatbot Integration for Shibani AI Companion
 * Handles Telegram Webhooks at /telegram/webhook
 */

import { GoogleGenAI } from "@google/genai";
import { SupabaseClient } from "@supabase/supabase-js";

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  chat: {
    id: number;
    type: string;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  date: number;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramHistoryItem {
  id?: number | string;
  telegram_user_id: string;
  role: string;
  message: string;
  created_at: string;
}

// In-memory fallback if Supabase is not configured or table is missing
const inMemoryTelegramHistory = new Map<string, TelegramHistoryItem[]>();

// In-memory rate limiter per-minute tracker: Map<telegram_user_id, timestamp[]>
const userMinuteTracker = new Map<string, number[]>();

// In-memory daily usage fallback tracker: Map<telegram_user_id, { date: string; count: number }>
const inMemoryDailyUsage = new Map<string, { date: string; count: number }>();

/**
 * Check and enforce per-minute rate limit (max 10 messages per minute per user)
 */
function checkPerMinuteRateLimit(telegramUserId: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxPerMinute = 10;

  const timestamps = (userMinuteTracker.get(telegramUserId) || []).filter((ts) => now - ts < windowMs);

  if (timestamps.length >= maxPerMinute) {
    return false; // Exceeded
  }

  timestamps.push(now);
  userMinuteTracker.set(telegramUserId, timestamps);
  return true; // Allowed
}

/**
 * Check daily rate limit (max 50 messages per day per user) using telegram_usage table
 */
async function checkDailyRateLimit(supabase: SupabaseClient | null, telegramUserId: string, today: string): Promise<boolean> {
  const maxPerDay = 50;

  // 1. Check in-memory fallback count first
  const mem = inMemoryDailyUsage.get(telegramUserId);
  if (mem && mem.date === today && mem.count >= maxPerDay) {
    return false; // Exceeded
  }

  // 2. Check Supabase table telegram_usage
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_usage")
        .select("*")
        .eq("telegram_user_id", telegramUserId)
        .eq("date", today)
        .maybeSingle();

      if (error) {
        if (error.code === "42P01") {
          console.warn(
            "[Telegram Bot] Table 'telegram_usage' does not exist in Supabase yet. Please run this SQL in your Supabase SQL editor:\n" +
              "CREATE TABLE telegram_usage (id SERIAL PRIMARY KEY, telegram_user_id TEXT, date TEXT, count INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW());"
          );
        } else {
          console.warn("[Telegram Bot] Supabase telegram_usage select error:", error.message || error);
        }
      } else if (data) {
        const count = data.count !== undefined ? data.count : (data.message_count !== undefined ? data.message_count : 0);
        if (count >= maxPerDay) {
          return false; // Exceeded
        }
      }
    } catch (err) {
      console.warn("[Telegram Bot] Error checking telegram_usage in Supabase:", err);
    }
  }

  return true; // Allowed
}

/**
 * Increment daily message count in telegram_usage table and in-memory tracker
 */
async function incrementDailyUsage(supabase: SupabaseClient | null, telegramUserId: string, today: string) {
  // Update in-memory tracker
  const mem = inMemoryDailyUsage.get(telegramUserId);
  if (!mem || mem.date !== today) {
    inMemoryDailyUsage.set(telegramUserId, { date: today, count: 1 });
  } else {
    mem.count += 1;
  }

  // Update Supabase telegram_usage table
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_usage")
        .select("id, count")
        .eq("telegram_user_id", telegramUserId)
        .eq("date", today)
        .maybeSingle();

      if (error) {
        if (error.code === "42P01") {
          // Table doesn't exist yet, already logged warning
          return;
        }
        console.warn("[Telegram Bot] Select telegram_usage error:", error.message || error);
        return;
      }

      if (data) {
        const currentCount = data.count || 0;
        await supabase
          .from("telegram_usage")
          .update({ count: currentCount + 1 })
          .eq("id", data.id);
      } else {
        await supabase
          .from("telegram_usage")
          .insert([{ telegram_user_id: telegramUserId, date: today, count: 1 }]);
      }
    } catch (err) {
      console.warn("[Telegram Bot] Exception updating telegram_usage:", err);
    }
  }
}

/**
 * Send typing action or other chat status to Telegram Chat via Telegram Bot API
 */
export async function sendChatAction(botToken: string, chatId: number | string, action: string = "typing") {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action: action,
      }),
    });
  } catch (err) {
    console.error(`[Telegram Bot] Error sending chat action '${action}' to chat ${chatId}:`, err);
  }
}

/**
 * Extract response text safely from Gemini API response across different SDK structures/getters
 */
function extractGeminiText(response: any): string | undefined {
  if (!response) return undefined;

  // 1. Direct text property or method on response
  if (typeof response.text === "string" && response.text.trim().length > 0) {
    return response.text.trim();
  }
  if (typeof response.text === "function") {
    try {
      const fnText = response.text();
      if (typeof fnText === "string" && fnText.trim().length > 0) {
        return fnText.trim();
      }
    } catch (e) {
      // ignore
    }
  }

  // 2. Check wrapped response object (e.g. response.response)
  if (response.response) {
    const wrappedText = extractGeminiText(response.response);
    if (wrappedText) return wrappedText;
  }

  // 3. Inspect candidates array
  const candidates = response.candidates || response.response?.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    for (const candidate of candidates) {
      if (!candidate) continue;

      // candidate.text property or method
      if (typeof candidate.text === "string" && candidate.text.trim().length > 0) {
        return candidate.text.trim();
      }
      if (typeof candidate.text === "function") {
        try {
          const fnText = candidate.text();
          if (typeof fnText === "string" && fnText.trim().length > 0) {
            return fnText.trim();
          }
        } catch (e) {}
      }

      // candidate.content
      const content = candidate.content;
      if (typeof content === "string" && content.trim().length > 0) {
        return content.trim();
      }

      if (content && typeof content === "object") {
        // candidate.content.parts array
        if (Array.isArray(content.parts) && content.parts.length > 0) {
          // Prefer parts that are non-thought text if available
          const nonThoughtParts = content.parts.filter(
            (p: any) => p && !p.thought && typeof p.text === "string" && p.text.trim().length > 0
          );
          if (nonThoughtParts.length > 0) {
            const joined = nonThoughtParts.map((p: any) => p.text).join("").trim();
            if (joined.length > 0) return joined;
          }

          // Fallback to all parts with text
          const allParts = content.parts
            .map((p: any) => {
              if (typeof p === "string") return p;
              if (!p) return "";
              if (typeof p.text === "string") return p.text;
              if (typeof p.text === "function") {
                try {
                  return p.text();
                } catch (e) {
                  return "";
                }
              }
              return "";
            })
            .filter((t: string) => t.length > 0)
            .join("")
            .trim();

          if (allParts.length > 0) {
            return allParts;
          }
        }

        // candidate.content.text
        if (typeof content.text === "string" && content.text.trim().length > 0) {
          return content.text.trim();
        }
      }
    }
  }

  // 4. Recursive search for any non-empty 'text' property in response
  try {
    const textPieces: string[] = [];
    const searchObj = (obj: any, depth = 0) => {
      if (!obj || depth > 6) return;
      if (typeof obj !== "object") return;

      for (const key of Object.keys(obj)) {
        if (key === "text") {
          const val = obj[key];
          if (typeof val === "string" && val.trim().length > 0) {
            textPieces.push(val.trim());
          } else if (typeof val === "function") {
            try {
              const res = val();
              if (typeof res === "string" && res.trim().length > 0) {
                textPieces.push(res.trim());
              }
            } catch (e) {}
          }
        } else if (typeof obj[key] === "object" && obj[key] !== null) {
          searchObj(obj[key], depth + 1);
        }
      }
    };
    searchObj(response);
    if (textPieces.length > 0) {
      return textPieces.join("\n").trim();
    }
  } catch (e) {
    // ignore
  }

  return undefined;
}

/**
 * Send text message back to Telegram Chat via Telegram Bot API
 */
export async function sendTelegramMessage(botToken: string, chatId: number | string, text: string) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Telegram Bot] Error sending message to chat ${chatId}:`, response.status, errText);
    }
  } catch (err) {
    console.error(`[Telegram Bot] Network error sending message to Telegram:`, err);
  }
}

/**
 * Load last 5 chat messages for a Telegram user
 */
async function loadTelegramHistory(supabase: SupabaseClient | null, telegramUserId: string): Promise<TelegramHistoryItem[]> {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_chat_history")
        .select("*")
        .eq("telegram_user_id", telegramUserId)
        .order("created_at", { ascending: false })
        .limit(5);

      if (error) {
        if (error.code === "42P01") {
          console.warn(
            "[Telegram Bot] Table 'telegram_chat_history' does not exist in Supabase yet. Please run this SQL in your Supabase SQL editor:\n" +
            "CREATE TABLE telegram_chat_history (id SERIAL PRIMARY KEY, telegram_user_id TEXT, role TEXT, message TEXT, created_at TIMESTAMPTZ DEFAULT NOW());\n" +
            "Falling back to in-memory history storage."
          );
        } else {
          console.warn("[Telegram Bot] Supabase select error:", error.message || error);
        }
        return (inMemoryTelegramHistory.get(telegramUserId) || []).slice(-5);
      }

      // Reverse to chronological order (oldest first)
      return (data || []).reverse();
    } catch (err) {
      console.warn("[Telegram Bot] Error reading from Supabase, using in-memory fallback:", err);
      return (inMemoryTelegramHistory.get(telegramUserId) || []).slice(-5);
    }
  }

  return (inMemoryTelegramHistory.get(telegramUserId) || []).slice(-5);
}

/**
 * Save a message turn to history
 */
async function saveTelegramMessage(
  supabase: SupabaseClient | null,
  telegramUserId: string,
  role: "user" | "model" | "assistant",
  message: string
) {
  const item: TelegramHistoryItem = {
    telegram_user_id: telegramUserId,
    role: role === "assistant" ? "model" : role,
    message,
    created_at: new Date().toISOString(),
  };

  if (supabase) {
    try {
      const { error } = await supabase.from("telegram_chat_history").insert([item]);
      if (error) {
        if (error.code === "42P01") {
          console.warn("[Telegram Bot] Table 'telegram_chat_history' missing. Saved to in-memory fallback.");
        } else {
          console.warn("[Telegram Bot] Supabase insert warning:", error.message || error);
        }
        const existing = inMemoryTelegramHistory.get(telegramUserId) || [];
        existing.push(item);
        inMemoryTelegramHistory.set(telegramUserId, existing);
      }
    } catch (err) {
      console.warn("[Telegram Bot] Insert exception:", err);
      const existing = inMemoryTelegramHistory.get(telegramUserId) || [];
      existing.push(item);
      inMemoryTelegramHistory.set(telegramUserId, existing);
    }
  } else {
    const existing = inMemoryTelegramHistory.get(telegramUserId) || [];
    existing.push(item);
    inMemoryTelegramHistory.set(telegramUserId, existing);
  }
}

/**
 * Trim older messages for a Telegram user so only the latest 50 messages remain
 */
async function trimOldTelegramMessages(supabase: SupabaseClient | null, telegramUserId: string) {
  // Trim in-memory history if present
  if (inMemoryTelegramHistory.has(telegramUserId)) {
    const list = inMemoryTelegramHistory.get(telegramUserId) || [];
    if (list.length > 50) {
      inMemoryTelegramHistory.set(telegramUserId, list.slice(-50));
    }
  }

  // Trim Supabase table
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_chat_history")
        .select("id")
        .eq("telegram_user_id", telegramUserId)
        .order("created_at", { ascending: false });

      if (!error && data && data.length > 50) {
        const idsToDelete = data.slice(50).map((row) => row.id);
        if (idsToDelete.length > 0) {
          await supabase
            .from("telegram_chat_history")
            .delete()
            .in("id", idsToDelete);
        }
      }
    } catch (err) {
      console.warn("[Telegram Bot] Error trimming old messages in Supabase:", err);
    }
  }
}

/**
 * Delete chat history for a Telegram user
 */
async function clearTelegramHistory(supabase: SupabaseClient | null, telegramUserId: string): Promise<boolean> {
  inMemoryTelegramHistory.delete(telegramUserId);

  if (supabase) {
    try {
      const { error } = await supabase
        .from("telegram_chat_history")
        .delete()
        .eq("telegram_user_id", telegramUserId);

      if (error && error.code !== "42P01") {
        console.warn("[Telegram Bot] Supabase delete warning:", error.message || error);
      }
    } catch (err) {
      console.warn("[Telegram Bot] Supabase delete exception:", err);
    }
  }
  return true;
}

/**
 * Handle Webhook Update from Telegram
 */
export async function handleTelegramWebhook(
  req: any,
  res: any,
  ai: GoogleGenAI,
  supabase: SupabaseClient | null,
  getSystemInstructionFn: () => string
) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn("[Telegram Bot] TELEGRAM_BOT_TOKEN environment variable is not configured.");
    return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN environment variable is not configured." });
  }

  const update: TelegramUpdate = req.body;
  console.log("========================================");
  console.log("[WEBHOOK RECEIVED]");
  console.log("Time:", new Date().toISOString());
  console.log("Update ID:", update.update_id);
  console.log("Message ID:", update.message?.message_id);
  console.log("Chat ID:", update.message?.chat?.id);
  console.log("Telegram User ID:", update.message?.from?.id);
  console.log("Text:", update.message?.text);
  console.log("========================================");
  const msg = update?.message || update?.edited_message;

  // Always return HTTP 200 OK immediately so Telegram webhook does not retry
  res.status(200).json({ ok: true });

  if (!msg || !msg.chat) {
    return;
  }

  const chatId = msg.chat.id;
  const telegramUserId = String(msg.from?.id || chatId);
  const text = (msg.text || "").trim();

  if (!text) {
    // Non-text message (sticker, image, audio, etc.)
    await sendTelegramMessage(
      botToken,
      chatId,
      "I currently only support text messages on Telegram! Send me a message and let's talk. 😊"
    );
    return;
  }

  // Reject any message longer than 2000 characters before calling Gemini
  if (text.length > 2000) {
    await sendTelegramMessage(
      botToken,
      chatId,
      "⚠️ Your message is too long (maximum 2000 characters). Please send a shorter message."
    );
    return;
  }

  // Handle Telegram Commands
  if (text === "/start") {
    const welcomeText = "Hey there! I'm Shibani Roy, your virtual friend and AI companion. 😊 Great to connect with you on Telegram! How are you doing today?";
    await sendTelegramMessage(botToken, chatId, welcomeText);
    return;
  }

  if (text === "/help") {
    const helpText =
      "I'm Shibani Roy! Here is how you can talk to me on Telegram:\n\n" +
      "• Just type any message to start chatting!\n" +
      "• /start - Start a new conversation\n" +
      "• /help - Display this help message\n" +
      "• /clear - Clear your chat history with me\n\n" +
      "You can chat with me in English, Hindi, Bengali, Hinglish, or Banglish! 😊";
    await sendTelegramMessage(botToken, chatId, helpText);
    return;
  }

  if (text === "/clear") {
    await clearTelegramHistory(supabase, telegramUserId);
    const clearText = "Your chat history has been cleared! Let me know what's on your mind today. 😊";
    await sendTelegramMessage(botToken, chatId, clearText);
    return;
  }

  // Enforce per-minute rate limit (10 messages per minute per telegram_user_id)
  if (!checkPerMinuteRateLimit(telegramUserId)) {
    await sendTelegramMessage(
      botToken,
      chatId,
      "⚠️ You're sending messages too quickly. Please wait a minute and try again."
    );
    return;
  }

  // Enforce daily rate limit (50 messages per day per telegram_user_id)
  const today = new Date().toISOString().split("T")[0];
  const isDailyAllowed = await checkDailyRateLimit(supabase, telegramUserId, today);
  if (!isDailyAllowed) {
    await sendTelegramMessage(
      botToken,
      chatId,
      "💕 You've reached today's free limit of 50 messages. Please come back tomorrow to continue chatting with me."
    );
    return;
  }

  try {
    // 1. Get Telegram User ID & load last 5 messages from telegram_chat_history
    const rawHistory = await loadTelegramHistory(supabase, telegramUserId);
    const history = rawHistory.slice(-5);

    // 2. Format contents for Gemini
    const contents: any[] = history.map((item) => ({
      role: item.role === "assistant" ? "model" : item.role,
      parts: [{ text: item.message }],
    }));

    // Add current user message
    contents.push({
      role: "user",
      parts: [{ text }],
    });

    // Sanitize & optimize turns to alternate user and model roles
    let sanitizedContents: any[] = [];
    for (const turn of contents) {
      if (!turn.parts || !turn.parts[0]?.text) continue;
      if (sanitizedContents.length > 0 && sanitizedContents[sanitizedContents.length - 1].role === turn.role) {
        sanitizedContents[sanitizedContents.length - 1].parts[0].text += "\n" + turn.parts[0].text;
      } else {
        sanitizedContents.push({ role: turn.role, parts: [{ text: turn.parts[0].text }] });
      }
    }

    // Ensure contents do not exceed 5 messages total
    if (sanitizedContents.length > 5) {
      sanitizedContents = sanitizedContents.slice(-5);
    }

    // Ensure turn sequence starts with 'user'
    while (sanitizedContents.length > 0 && sanitizedContents[0].role !== "user") {
      sanitizedContents.shift();
    }

    if (sanitizedContents.length === 0) {
      sanitizedContents.push({ role: "user", parts: [{ text }] });
    }

    // 3. System prompt with Shibani personality
    const systemInstruction = getSystemInstructionFn();

    // Calculate prompt size & message counts
    const historyMessageCount = history.length;
    const contentsTextLength = sanitizedContents.reduce((acc, turn) => acc + (turn.parts?.[0]?.text?.length || 0), 0);
    const totalPromptSize = systemInstruction.length + contentsTextLength;

    // Send typing action indicator to Telegram
    await sendChatAction(botToken, chatId, "typing");

    // 4. Send messages + Shibani system prompt to Gemini
    console.log("========================================");
    console.log("[Telegram Bot] GEMINI REQUEST");
    console.log("Time:", new Date().toISOString());
    console.log("Telegram User ID:", telegramUserId);
    console.log("Chat ID:", chatId);
    console.log("Message:", text);
    console.log("Model:", "gemini-3.6-flash");
    console.log("History Message Count:", historyMessageCount);
    console.log("Total Prompt Size:", totalPromptSize, "characters");
    console.log("========================================");

    // Calculate prompt composition metrics
    const sysChars = systemInstruction.length;
    const sysTokens = Math.ceil(sysChars / 4);

    const historyChars = history.reduce((acc, item) => acc + (item.message?.length || 0), 0);
    const historyTokens = Math.ceil(historyChars / 4);

    const userMsgChars = text.length;
    const userMsgTokens = Math.ceil(userMsgChars / 4);

    const totalChars = sysChars + historyChars + userMsgChars;
    const totalTokens = sysTokens + historyTokens + userMsgTokens;

    console.log("----------------------------------------");
    console.log("SYSTEM PROMPT");
    console.log(`Characters: ${sysChars}`);
    console.log(`Estimated Tokens: ${sysTokens}`);
    console.log("");
    console.log("CHAT HISTORY");
    console.log(`Characters: ${historyChars}`);
    console.log(`Estimated Tokens: ${historyTokens}`);
    console.log("");
    console.log("CURRENT USER MESSAGE");
    console.log(`Characters: ${userMsgChars}`);
    console.log(`Estimated Tokens: ${userMsgTokens}`);
    console.log("");
    console.log("TOTAL");
    console.log(`Characters: ${totalChars}`);
    console.log(`Estimated Tokens: ${totalTokens}`);
    console.log("----------------------------------------");

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: sanitizedContents,
      config: {
        systemInstruction,
        temperature: 0.85,
      },
    });

    console.log("===== RAW GEMINI RESPONSE =====");
    console.dir(response, { depth: null });
    console.log("===============================");

    console.log("===== RESPONSE.TEXT =====");
    console.log(response.text);
    console.log("=========================");

    const promptTokenCount = response.usageMetadata?.promptTokenCount ?? "N/A";
    console.log("[Telegram Bot] Gemini response received successfully.");
    console.log("Prompt Token Count:", promptTokenCount);
    console.log("History Message Count:", historyMessageCount);
    console.log("Total Prompt Size:", totalPromptSize, "characters");

    // Extract text from Gemini response using robust extraction helper
    let replyText = extractGeminiText(response);

    if (!replyText) {
      console.error("[Telegram Bot] Gemini returned no text in response. Full response object:", JSON.stringify(response, null, 2));
      replyText = "I'm sorry, I couldn't generate a reply.";
    }

    // Increment daily usage count only after successful Gemini response
    await incrementDailyUsage(supabase, telegramUserId, today);

    // 5. Save user message & Shibani reply to telegram_chat_history
    await saveTelegramMessage(supabase, telegramUserId, "user", text);
    await saveTelegramMessage(supabase, telegramUserId, "model", replyText);

    // Automatically delete older messages so only the latest 50 messages per Telegram user remain
    await trimOldTelegramMessages(supabase, telegramUserId);

    // 6. Reply to user on Telegram
    await sendTelegramMessage(botToken, chatId, replyText);

  } catch (err: any) {
    console.error("========================================");
    console.error("[Telegram Bot] GEMINI ERROR");
    console.error("Time:", new Date().toISOString());
    console.error("Telegram User ID:", telegramUserId);
    console.error("Chat ID:", chatId);
    console.error("Message:", text);
    console.error("Error:", err);
    console.error("Message:", err?.message);
    console.error("Status:", err?.status);
    console.error("Stack:", err?.stack);
    console.error("========================================");
    await sendTelegramMessage(
      botToken,
      chatId,
      "Oops, I had a quick hiccup processing your message! Please try sending it again in a moment. 😊"
    );
  }
}
