import { createClient } from "@supabase/supabase-js";

// A valid, non-secret 3-part JWT representing an 'anon' role with a long expiry.
// This allows the Supabase client to initialize client-side without throwing "Forbidden use of secret API key in browser"
// or encountering token parsing errors.
export const DUMMY_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTUwMDAwMDAwMCwiZXhwIjoyNTAwMDAwMDAwfQ.signature";

// We use our secure backend Express proxy as the supabaseUrl.
// This routes all authentication, session restoration, and token refreshes securely through our server,
// where we safely attach the real secret SUPABASE_KEY.
const proxyUrl = `${window.location.origin}/api/auth/proxy`;

export const supabase = createClient(proxyUrl, DUMMY_JWT, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "shibani_supabase_auth_token", // Unique storage key for Supabase auth
  },
});
