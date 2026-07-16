import { createClient } from "@supabase/supabase-js";

// Retrieve the Supabase URL and Publishable (anon) Key from client-side env variables.
const supabaseUrl = (((import.meta as any).env?.VITE_SUPABASE_URL as string) || "").trim().replace(/\/+$/, "");
const supabaseAnonKey = (((import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY as string) || "").trim();

// Initialize the native Supabase client for safe direct client-side requests
export const supabase = createClient(supabaseUrl || "https://placeholder.supabase.co", supabaseAnonKey || "placeholder-key", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "shibani_supabase_auth_token", // Unique storage key for Supabase auth
  },
});
