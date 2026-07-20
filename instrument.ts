import dotenv from "dotenv";
dotenv.config();

import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env.SENTRY_DSN || "https://951818a85e812187062a41ea72da3065@o4511766686924800.ingest.us.sentry.io/4511766720151552";

function redactSensitiveData(obj: any, visited = new Set<any>()): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj !== "object") {
    if (typeof obj === "string") {
      // 1. Redact email addresses using regex
      let scrubbed = obj.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL_REDACTED]");
      
      // 2. Redact any occurrences of actual secret environment variables
      const secrets = [
        process.env.GEMINI_API_KEY,
        process.env.SUPABASE_KEY,
        process.env.FAL_API_KEY,
        process.env.SENTRY_DSN,
      ];
      for (const secret of secrets) {
        if (secret && secret.trim().length > 5) {
          const escaped = secret.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          scrubbed = scrubbed.replace(new RegExp(escaped, 'g'), "[SECRET_REDACTED]");
        }
      }
      return scrubbed;
    }
    return obj;
  }

  // Prevent infinite loops on self-referential structures
  if (visited.has(obj)) {
    return "[CIRCULAR_REFERENCE]";
  }
  visited.add(obj);

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitiveData(item, visited));
  }

  // Handle objects
  const redacted: any = {};
  const sensitiveKeys = [
    "authorization", "token", "password", "key", "secret", "email", 
    "fact", "description", "message", "query", "q", "userid", "user_id",
    "prompt", "category", "inlineData"
  ];
  
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitiveKey = sensitiveKeys.some(sk => lowerKey.includes(sk));
    
    if (isSensitiveKey) {
      if (typeof val === "string") {
        redacted[key] = "[REDACTED]";
      } else if (val && typeof val === "object") {
        redacted[key] = "[REDACTED_OBJECT]";
      } else {
        redacted[key] = "[REDACTED]";
      }
    } else {
      redacted[key] = redactSensitiveData(val, visited);
    }
  }
  
  visited.delete(obj);
  return redacted;
}

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 1.0,
    environment: process.env.NODE_ENV || "development",
    beforeSend(event) {
      // Walk and scrub the event structure to ensure no sensitive parameters/messages leak to Sentry
      return redactSensitiveData(event);
    },
  });
  console.log("[Sentry] Sentry initialization complete for Express backend.");
} else {
  console.warn("[Sentry] SENTRY_DSN is not configured. Sentry monitoring is disabled.");
}

export { Sentry };
