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
 * Load last 20 chat messages for a Telegram user
 */
async function loadTelegramHistory(supabase: SupabaseClient | null, telegramUserId: string): Promise<TelegramHistoryItem[]> {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_chat_history")
        .select("*")
        .eq("telegram_user_id", telegramUserId)
        .order("created_at", { ascending: false })
        .limit(20);

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
        return (inMemoryTelegramHistory.get(telegramUserId) || []).slice(-20);
      }

      // Reverse to chronological order (oldest first)
      return (data || []).reverse();
    } catch (err) {
      console.warn("[Telegram Bot] Error reading from Supabase, using in-memory fallback:", err);
      return (inMemoryTelegramHistory.get(telegramUserId) || []).slice(-20);
    }
  }

  return (inMemoryTelegramHistory.get(telegramUserId) || []).slice(-20);
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
    // 1. Get Telegram User ID & load last 20 messages from telegram_chat_history
    const history = await loadTelegramHistory(supabase, telegramUserId);

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
    const sanitizedContents: any[] = [];
    for (const turn of contents) {
      if (!turn.parts || !turn.parts[0]?.text) continue;
      if (sanitizedContents.length > 0 && sanitizedContents[sanitizedContents.length - 1].role === turn.role) {
        sanitizedContents[sanitizedContents.length - 1].parts[0].text += "\n" + turn.parts[0].text;
      } else {
        sanitizedContents.push({ role: turn.role, parts: [{ text: turn.parts[0].text }] });
      }
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

    // Send typing action indicator to Telegram
    await sendChatAction(botToken, chatId, "typing");

    // 4. Send messages + Shibani system prompt to Gemini
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: sanitizedContents,
      config: {
        systemInstruction,
        temperature: 0.85,
      },
    });

    const replyText = response.text ? response.text.trim() : "I'm right here! What's on your mind today? 😊";

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
    console.error("[Telegram Bot] Error processing message:", err);
    await sendTelegramMessage(
      botToken,
      chatId,
      "Oops, I had a quick hiccup processing your message! Please try sending it again in a moment. 😊"
    );
  }
}
