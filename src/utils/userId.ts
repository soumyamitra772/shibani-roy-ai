let currentAuthUserId: string | null = null;
let currentAuthToken: string | null = null;

export function setAuthenticatedUser(userId: string | null, token: string | null) {
  currentAuthUserId = userId;
  currentAuthToken = token;
}

export function getAuthenticatedToken(): string | null {
  if (currentAuthToken) return currentAuthToken;
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = localStorage.getItem("shibani_supabase_auth_token");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.access_token) return parsed.access_token;
      if (parsed?.currentSession?.access_token) return parsed.currentSession.access_token;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith("sb-") || key.includes("supabase")) && key.endsWith("-auth-token")) {
        const val = localStorage.getItem(key);
        if (val) {
          const parsed = JSON.parse(val);
          if (parsed?.access_token) return parsed.access_token;
          if (parsed?.currentSession?.access_token) return parsed.currentSession.access_token;
        }
      }
    }
  } catch (err) {
    console.warn("Error reading auth token from localStorage", err);
  }
  return null;
}

/**
 * Utility to retrieve or generate a persistent anonymous user identifier.
 * Stored in localStorage so it persists across sessions.
 */
export function getOrCreateUserId(): string {
  if (currentAuthUserId) {
    return currentAuthUserId;
  }
  if (typeof window === "undefined" || !window.localStorage) {
    return "anonymous-user";
  }
  let userId = localStorage.getItem("shibani_user_id");
  if (!userId) {
    const rand = Math.random().toString(36).substring(2, 11);
    const ts = Date.now();
    userId = `shibani-user-${ts}-${rand}`;
    localStorage.setItem("shibani_user_id", userId);
  }
  return userId;
}
