import { supabase } from "./supabaseClient";

/**
 * Calculates the day of the year (1 - 365/366) based on local time.
 */
export function getDayOfYear(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime() + (start.getTimezoneOffset() - now.getTimezoneOffset()) * 60 * 1000;
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

/**
 * Returns a deterministic avatar index (1 to 8) based on the current calendar day modulo 8.
 */
export function getDailyAvatarIndex(): number {
  const dayOfYear = getDayOfYear();
  // Modulo 8 gives 0 to 7, so we add 1 to get look-1 to look-8
  return (dayOfYear % 8) + 1;
}

export const AVATAR_BASE_URL = "https://lkxxnumhlcdbqknmulmu.supabase.co/storage/v1/object/public/avatars";

/**
 * Resolves the final path of the avatar based on the preference (e.g. "look-3" or "auto").
 */
export function getActiveAvatar(preference: string): string {
  if (preference && preference !== "auto" && preference !== "") {
    return `${AVATAR_BASE_URL}/${preference}.jpg`;
  }
  const index = getDailyAvatarIndex();
  return `${AVATAR_BASE_URL}/look-${index}.jpg`;
}

/**
 * Saves the user's avatar preference (e.g. "look-5" or "auto") to Supabase, 
 * with a automatic fallback to local storage.
 */
export async function saveAvatarPreference(userId: string | null, preference: string): Promise<void> {
  const key = `shibani_avatar_pref_${userId || "anon"}`;
  localStorage.setItem(key, preference);

  if (!userId || !supabase) return;

  try {
    const { error } = await supabase
      .from("shibani_preferences")
      .upsert({ 
        user_id: userId, 
        avatar_preference: preference, 
        updated_at: new Date().toISOString() 
      }, { onConflict: "user_id" });

    if (error) {
      if (error.code === "42P01") {
        console.warn(
          "Supabase 'shibani_preferences' table does not exist. Please create it in your Supabase SQL editor:\n" +
          "CREATE TABLE shibani_preferences (user_id TEXT PRIMARY KEY, avatar_preference TEXT, updated_at TIMESTAMPTZ);\n" +
          "Using localStorage fallback."
        );
      } else {
        console.error("Failed to save avatar preference to Supabase:", error);
      }
    }
  } catch (err) {
    console.error("Error saving avatar preference to Supabase:", err);
  }
}

/**
 * Loads the user's avatar preference from Supabase, falling back to local storage.
 */
export async function getAvatarPreference(userId: string | null): Promise<string> {
  const key = `shibani_avatar_pref_${userId || "anon"}`;
  const localPref = localStorage.getItem(key);

  if (!userId || !supabase) {
    return localPref || "auto";
  }

  try {
    const { data, error } = await supabase
      .from("shibani_preferences")
      .select("avatar_preference")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      if (error.code === "42P01") {
        console.warn("Supabase 'shibani_preferences' table does not exist. Using localStorage fallback.");
      } else {
        console.error("Failed to load avatar preference from Supabase:", error);
      }
      return localPref || "auto";
    }

    if (data && data.avatar_preference) {
      localStorage.setItem(key, data.avatar_preference);
      return data.avatar_preference;
    }
  } catch (err) {
    console.error("Error loading avatar preference from Supabase:", err);
  }

  return localPref || "auto";
}
