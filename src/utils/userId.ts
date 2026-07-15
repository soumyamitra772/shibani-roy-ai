let currentAuthUserId: string | null = null;
let currentAuthToken: string | null = null;

export function setAuthenticatedUser(userId: string | null, token: string | null) {
  currentAuthUserId = userId;
  currentAuthToken = token;
}

export function getAuthenticatedToken(): string | null {
  return currentAuthToken;
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
