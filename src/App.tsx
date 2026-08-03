/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MessageSquare, Sparkles, Volume2, ShieldCheck, Heart, AlertCircle, Info, X, Download, Loader2 } from "lucide-react";
import Header from "./components/Header";
import VoiceVisualizer from "./components/VoiceVisualizer";
import ChatWindow from "./components/ChatWindow";
import { useVoiceConnection } from "./hooks/useVoiceConnection";
import { Message, InteractionMode } from "./types";
import { ToolExecutor } from "./services/ToolExecutor";
import { MusicPlayer } from "./components/MusicPlayer";
import { setAuthenticatedUser } from "./utils/userId";
import { ThemeId, THEMES } from "./utils/themes";
import LoginScreen from "./components/LoginScreen";
import { supabase } from "./utils/supabaseClient";
import { getActiveAvatar, getAvatarPreference, saveAvatarPreference } from "./utils/avatarUtils";

interface UpgradeModalProps {
  session: any;
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

function UpgradeModal({ session, onClose, onSuccess, onError }: UpgradeModalProps) {
  const [selectedPlan, setSelectedPlan] = useState<"monthly" | "yearly">("yearly");
  const [loading, setLoading] = useState(false);

  const loadRazorpayScript = (): Promise<boolean> => {
    return new Promise((resolve) => {
      if ((window as any).Razorpay) {
        resolve(true);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  const handleUpgrade = async () => {
    setLoading(true);
    try {
      const isLoaded = await loadRazorpayScript();
      if (!isLoaded) {
        throw new Error("Failed to load Razorpay payment SDK. Please check network connection.");
      }

      const planId = selectedPlan === "monthly" ? "plan_TLKcmhornkOwH6" : "plan_TLKnHmEPZWLSqg";
      const token = session?.access_token;

      const response = await fetch("/api/create-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({ planId }),
      });

      const data = await response.json();

      if (!response.ok || !data.subscription_id) {
        throw new Error(data.error || "Failed to create Razorpay subscription.");
      }

      const options = {
        key: data.key_id || "rzp_live_TLLam8g5sMqLCx",
        subscription_id: data.subscription_id,
        name: "Shibani Roy AI",
        description: selectedPlan === "monthly" ? "Pro Monthly Subscription" : "Pro Yearly Subscription",
        image: "https://lkxxnumhlcdbqknmulmu.supabase.co/storage/v1/object/public/avatars/look-1.jpg",
        handler: async function (paymentResponse: any) {
          try {
            const verifyRes = await fetch("/api/verify-subscription", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: token ? `Bearer ${token}` : "",
              },
              body: JSON.stringify({
                subscription_id: paymentResponse.razorpay_subscription_id,
                payment_id: paymentResponse.razorpay_payment_id,
              }),
            });
            const verifyData = await verifyRes.json();
            if (verifyRes.ok && verifyData.success) {
              onSuccess();
              onClose();
            } else {
              onError("Payment captured, but database verification failed.");
            }
          } catch (err: any) {
            console.error("[Razorpay Verification Error]:", err);
            onSuccess();
            onClose();
          }
        },
        prefill: {
          email: session?.user?.email || "",
        },
        theme: {
          color: "#f43f5e",
        },
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.on("payment.failed", function (failResponse: any) {
        console.error("Payment failed:", failResponse.error);
        onError(failResponse.error?.description || "Payment failed or was cancelled.");
        setLoading(false);
      });

      rzp.open();
      setLoading(false);
    } catch (err: any) {
      console.error("[Razorpay Upgrade Error]:", err);
      onError(err.message || "An error occurred while setting up payment.");
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg rounded-3xl border border-rose-500/20 bg-neutral-900/90 backdrop-blur-xl p-6 sm:p-8 shadow-2xl text-white overflow-hidden flex flex-col gap-6"
      >
        {/* Ambient glow accent */}
        <div className="absolute -top-24 -right-24 w-48 h-48 rounded-full bg-rose-500/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-48 h-48 rounded-full bg-pink-500/20 blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-5 h-5 text-rose-400" />
              <h3 className="text-xl font-bold bg-gradient-to-r from-rose-300 via-pink-300 to-amber-200 bg-clip-text text-transparent">
                Unlock Pro Access ✨
              </h3>
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              You've reached your free limit. Upgrade to keep chatting with Shibani.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-white/10 text-gray-400 hover:text-white transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Plan options - side by side */}
        <div className="grid grid-cols-2 gap-3">
          {/* Monthly */}
          <div
            onClick={() => setSelectedPlan("monthly")}
            className={`relative p-4 rounded-2xl border cursor-pointer transition-all flex flex-col justify-between ${
              selectedPlan === "monthly"
                ? "border-rose-500 bg-rose-500/10 shadow-lg shadow-rose-500/10"
                : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
            }`}
          >
            <div>
              <div className="text-xs font-semibold text-gray-300">Monthly</div>
              <div className="text-lg font-bold text-white mt-1">₹349<span className="text-xs font-normal text-gray-400">/mo</span></div>
            </div>
            <p className="text-[11px] text-gray-400 mt-3 leading-tight">
              200 chats/day, 30 min voice/day, 1 image/day, 20 web searches/day, music & memory unlimited
            </p>
          </div>

          {/* Yearly */}
          <div
            onClick={() => setSelectedPlan("yearly")}
            className={`relative p-4 rounded-2xl border cursor-pointer transition-all flex flex-col justify-between ${
              selectedPlan === "yearly"
                ? "border-rose-500 bg-rose-500/10 shadow-lg shadow-rose-500/10"
                : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
            }`}
          >
            <span className="absolute -top-2.5 right-3 px-2 py-0.5 rounded-full bg-gradient-to-r from-rose-500 to-pink-500 text-[10px] font-bold text-white shadow-md">
              Save ₹1,189
            </span>
            <div>
              <div className="text-xs font-semibold text-gray-300">Yearly</div>
              <div className="text-lg font-bold text-white mt-1">₹2,999<span className="text-xs font-normal text-gray-400">/yr</span></div>
            </div>
            <p className="text-[11px] text-gray-400 mt-3 leading-tight">
              200 chats/day, 30 min voice/day, 1 image/day, 20 web searches/day, music & memory unlimited
            </p>
          </div>
        </div>

        {/* Action button & link */}
        <div className="flex flex-col gap-3 text-center">
          <button
            onClick={handleUpgrade}
            disabled={loading}
            className="w-full py-3 rounded-2xl bg-gradient-to-r from-rose-500 via-pink-500 to-rose-600 text-white font-semibold shadow-lg shadow-rose-500/25 hover:brightness-110 active:scale-[0.99] transition-all cursor-pointer text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Preparing Checkout...</span>
              </>
            ) : (
              <span>Upgrade to Pro</span>
            )}
          </button>
          <button
            onClick={onClose}
            className="text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer py-1"
          >
            Maybe Later
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = localStorage.getItem("shibani-theme");
    return (saved as ThemeId) || "classic";
  });
  const [mode, setMode] = useState<InteractionMode>("voice");
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  // Supabase Auth integration states via secure backend proxy
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // States for Shibani image generation
  const [latestVoiceImage, setLatestVoiceImage] = useState<{ url: string; prompt: string } | null>(null);
  const [isVoiceGeneratingImage, setIsVoiceGeneratingImage] = useState(false);
  const [isChatGeneratingImage, setIsChatGeneratingImage] = useState(false);

  // Avatar system state
  const [avatarPreference, setAvatarPreference] = useState<string>("auto");
  const [selectedMicId, setSelectedMicId] = useState<string>("");

  // Sync avatar preference to DB / LocalStorage when session changes
  useEffect(() => {
    let active = true;
    async function loadPreference() {
      const userId = session?.user?.id || null;
      const pref = await getAvatarPreference(userId);
      if (active) {
        setAvatarPreference(pref);
      }
    }
    loadPreference();
    return () => {
      active = false;
    };
  }, [session]);

  // Sync theme changes to localStorage
  useEffect(() => {
    localStorage.setItem("shibani-theme", theme);
  }, [theme]);

  // Auth Initialization and State Listeners using native Supabase SDK with proxy
  useEffect(() => {
    let active = true;

    async function initAuth() {
      try {
        const { data: { session: activeSession }, error } = await supabase.auth.getSession();
        
        if (error) {
          console.error("Error checking session:", error);
        }

        if (active && activeSession) {
          console.log("Restored active session on load:", activeSession.user?.email);
          setSession(activeSession);
          setAuthenticatedUser(activeSession.user.id, activeSession.access_token);
          await handleMigration(activeSession.user.id, activeSession.access_token);
        } else if (active) {
          setSession(null);
          setAuthenticatedUser(null, null);
        }
      } catch (err) {
        console.error("Auth initialization failed:", err);
      } finally {
        if (active) {
          setAuthLoading(false);
        }
      }
    }

    // Run session check on load
    initAuth();

    // Setup native onAuthStateChange listener to handle login, token refresh, and sign-out automatically
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, currentSession) => {
      console.log(`[Supabase Auth Event] ${event}`);
      if (!active) return;

      if (currentSession) {
        setSession(currentSession);
        setAuthenticatedUser(currentSession.user.id, currentSession.access_token);
        await handleMigration(currentSession.user.id, currentSession.access_token);
      } else {
        setSession(null);
        setAuthenticatedUser(null, null);
      }
      setAuthLoading(false);
    });

    return () => {
      active = false;
      if (subscription) {
        subscription.unsubscribe();
      }
    };
  }, []);

  const handleMigration = async (newUserId: string, accessToken: string) => {
    const oldAnonId = localStorage.getItem("shibani_user_id");
    const migrationDoneKey = `shibani_migrated_${newUserId}`;

    if (oldAnonId && !localStorage.getItem(migrationDoneKey) && accessToken) {
      try {
        const res = await fetch("/api/auth/migrate", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            anonymousId: oldAnonId
          })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            console.log(`[Migration] Successfully migrated ${data.count} memories from ${oldAnonId} to ${newUserId}`);
            localStorage.setItem(migrationDoneKey, "true");
            localStorage.removeItem("shibani_user_id");
            triggerNotification(
              data.count > 0 
                ? `Welcome back! Successfully migrated your ${data.count} saved memories.` 
                : "Welcome! Your private profile is ready.", 
              "success"
            );
          }
        }
      } catch (err) {
        console.error("Error executing memory migration:", err);
      }
    }
  };

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      triggerNotification("Signed out successfully.", "info");
    } catch (err) {
      console.error("Error signing out:", err);
      // Clean fallback if signOut fails
      setSession(null);
      setAuthenticatedUser(null, null);
      triggerNotification("Signed out with local fallback.", "info");
    }
  };

  // Trigger a self-fading overlay notification for tool executions
  const triggerNotification = (message: string, type: "success" | "error" | "info" = "success") => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // Listen for global custom notifications (e.g. rate limit / usage quota alerts)
  useEffect(() => {
    const handleCustomNotification = (e: any) => {
      if (e.detail?.message) {
        triggerNotification(e.detail.message, e.detail.type || "error");
      }
    };
    window.addEventListener("shibani-notification", handleCustomNotification);
    return () => window.removeEventListener("shibani-notification", handleCustomNotification);
  }, []);

  const handleAvatarPreferenceChange = async (newPref: string) => {
    setAvatarPreference(newPref);
    const userId = session?.user?.id || null;
    await saveAvatarPreference(userId, newPref);
    
    if (newPref === "auto") {
      triggerNotification("Enabled Shibani's daily auto-rotating look! 🔄", "success");
    } else {
      const lookNum = newPref.split("-")[1];
      triggerNotification(`Styled Shibani with Look ${lookNum}! 📸`, "success");
    }
  };

  const activeAvatarUrl = getActiveAvatar(avatarPreference);

  // Safe and native image downloader
  const handleDownloadImage = async (imageUrl: string, description: string) => {
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const a = document.createElement("a");
      a.href = blobUrl;
      const timestamp = Math.floor(Date.now() / 1000).toString().slice(-6);
      a.download = `shibani-${timestamp}.jpg`;
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 1000);
      triggerNotification("Image download started!", "success");
    } catch (err) {
      console.error("Error downloading image:", err);
      window.open(imageUrl, "_blank");
      triggerNotification("Opening image in new tab to download", "info");
    }
  };

  // Wire up the custom voice engine with expanded callbacks
  const {
    state,
    isMuted,
    volumesRef,
    connect,
    disconnect,
    toggleMute,
    stopPlayback,
  } = useVoiceConnection({
    selectedMicId,
    onVoiceError: (errorMsg) => {
      if (
        errorMsg === "VOICE_LIMIT_REACHED" ||
        errorMsg === "TOOL_LOCKED" ||
        errorMsg === "IMAGE_LOCKED" ||
        errorMsg === "CHAT_LIMIT_REACHED"
      ) {
        setShowUpgradeModal(true);
      } else if (
        errorMsg === "PRO_IMAGE_LIMIT_REACHED" ||
        errorMsg === "PRO_TOOL_LIMIT_REACHED" ||
        errorMsg === "PRO_CHAT_LIMIT_REACHED"
      ) {
        triggerNotification("Daily limit reached. Resets at midnight IST 🌙", "info");
      } else {
        triggerNotification(errorMsg, "error");
      }
    },
    onToolCallExecuting: (name, args) => {
      if (name === "generateImage") {
        setIsVoiceGeneratingImage(true);
      }
    },
    onToolCallCompleted: (name, result) => {
      if (name === "generateImage") {
        setIsVoiceGeneratingImage(false);
        if (result.success && result.output && result.output.url) {
          const promptDesc = result.output.prompt || "Shibani Roy";
          setLatestVoiceImage({
            url: result.output.url,
            prompt: promptDesc
          });
          
          // Inject generated photo into the persistent chat history
          const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          setChatMessages((prev) => [
            ...prev,
            {
              id: `image-${Math.random()}`,
              role: "assistant",
              content: "",
              timestamp: now,
              imageUrl: result.output.url,
              imageDescription: promptDesc
            }
          ]);
        }
      }
    },
    onToolCallExecuted: (logMessage) => {
      // Feed voice-mode tool logs into the chat history for seamless session integrity
      const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setChatMessages((prev) => [
        ...prev,
        {
          id: `tool-${Math.random()}`,
          role: "assistant",
          content: logMessage,
          timestamp: now,
          isToolCall: true,
          toolName: logMessage.includes("image") ? "generateImage" : logMessage.includes("Google") ? "searchGoogle" : logMessage.includes("YouTube") ? "openYouTube" : logMessage.includes("Maps") ? "openMaps" : "Browser Link"
        }
      ]);
      triggerNotification(logMessage, "success");
    }
  });

  // Greet user on first mount to establish Shibani's unique, charming personality
  useEffect(() => {
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setChatMessages([
      {
        id: "welcome-1",
        role: "assistant",
        content: "Hey there! I've been waiting for you. 💖 What's on your mind today? Let's talk about anything... or we can speak in Bengali or Hindi if you like! 😉",
        timestamp: now
      }
    ]);
  }, []);

  // Handle traditional chat input in Chat Mode
  const handleSendChatMessage = async (content: string) => {
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    
    // 1. Add user message to state
    const userMsg: Message = {
      id: `user-${Math.random()}`,
      role: "user",
      content,
      timestamp: now
    };
    
    let currentMessages = [...chatMessages, userMsg];
    setChatMessages(currentMessages);
    setChatLoading(true);

    try {
      let loopCount = 0;
      const maxLoops = 5;
      let continueLoop = true;

      while (continueLoop && loopCount < maxLoops) {
        loopCount++;
        continueLoop = false; // default to stop unless we get a functionCall

        // Dispatch REST call to our Express secure Gemini proxy with streaming support
        const token = session?.access_token || "";
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            ...(token ? { "Authorization": `Bearer ${token}` } : {})
          },
          body: JSON.stringify({
            messages: currentMessages.slice(-40).map(m => ({
              role: m.role,
              content: m.content,
              parts: m.parts,
              functionCalls: m.functionCalls,
              functionResponses: m.functionResponses
            }))
          })
        });

        if (!response.ok) {
          let errText = "";
          try {
            const errData = await response.json();
            errText = errData.error || errData.message;
          } catch (e) {}
          throw new Error(errText || "Failed to connect to Shibani. Check API server.");
        }

        const replyTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const assistantMessageId = `assistant-${Math.random()}`;

        // Add an empty assistant message that we will stream text into
        setChatMessages((prev) => [
          ...prev,
          {
            id: assistantMessageId,
            role: "assistant",
            content: "",
            timestamp: replyTime
          }
        ]);

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) {
          throw new Error("No response body reader available.");
        }

        let buffer = "";
        let accumulatedText = "";
        let functionCalls: any[] = [];
        let assistantParts: any[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          
          // SSE messages are separated by double newlines
          const lines = buffer.split("\n\n");
          // Save the last line if it's incomplete
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith("data: ")) {
              const rawData = trimmedLine.substring(6).trim();
              if (rawData === "[DONE]") {
                continue;
              }
              try {
                const parsed = JSON.parse(rawData);
                if (parsed.error) {
                  throw new Error(parsed.error);
                }
                if (parsed.text) {
                  accumulatedText += parsed.text;
                  // Update the assistant message in-place
                  setChatMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMessageId ? { ...m, content: accumulatedText } : m
                    )
                  );
                }
                if (parsed.functionCalls) {
                  functionCalls.push(...parsed.functionCalls);
                }
                if (parsed.parts) {
                  assistantParts.push(...parsed.parts);
                }
              } catch (e) {
                console.error("Error parsing stream line:", line, e);
              }
            }
          }
        }

        // Clean up placeholder if we got no text and we have function calls
        if (!accumulatedText) {
          setChatMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
        } else {
          // Store raw text parts for clean text message history too
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId 
                ? { 
                    ...m, 
                    parts: assistantParts.length > 0 ? assistantParts : [{ text: accumulatedText }] 
                  } 
                : m
            )
          );
          // Sync with local currentMessages variable
          currentMessages = currentMessages.map((m) =>
            m.id === assistantMessageId 
              ? { 
                  ...m, 
                  content: accumulatedText,
                  parts: assistantParts.length > 0 ? assistantParts : [{ text: accumulatedText }] 
                } 
              : m
          );
        }

        if (functionCalls.length > 0) {
          // We have function calls! We must execute them and continue the loop.
          continueLoop = true;

          // Execute all function calls in parallel
          // Execute all function calls in parallel
          const results = await Promise.all(
            functionCalls.map(async (call) => {
              if (call.name === "generateImage") {
                setIsChatGeneratingImage(true);
              }
              const result = await ToolExecutor.execute(call);
              if (call.name === "generateImage") {
                setIsChatGeneratingImage(false);
              }
              // Trigger a subtle in-app floating banner for tool executions or open upgrade modal on limits
              if (
                result.message === "TOOL_LOCKED" ||
                result.message === "IMAGE_LOCKED" ||
                result.message === "CHAT_LIMIT_REACHED"
              ) {
                setShowUpgradeModal(true);
              } else if (
                result.message === "PRO_IMAGE_LIMIT_REACHED" ||
                result.message === "PRO_TOOL_LIMIT_REACHED" ||
                result.message === "PRO_CHAT_LIMIT_REACHED"
              ) {
                triggerNotification("Daily limit reached. Resets at midnight IST 🌙", "info");
              } else {
                triggerNotification(result.message, result.success ? "success" : "error");
              }
              return result;
            })
          );

          // If any of the function calls generated an image, create a message bubble for it
          const imageMessages: Message[] = [];
          results.forEach((r, idx) => {
            if (functionCalls[idx].name === "generateImage" && r.success && r.output?.url) {
              imageMessages.push({
                id: `image-${Math.random()}`,
                role: "assistant",
                content: "",
                timestamp: replyTime,
                imageUrl: r.output.url,
                imageDescription: r.output.prompt || functionCalls[idx].args.description
              });
            }
          });

          // Append hidden system records of the function call & responses to the history
          const modelCallMsg: Message = {
            id: `model-call-${Math.random()}`,
            role: "assistant",
            content: "",
            timestamp: replyTime,
            parts: assistantParts.length > 0 ? assistantParts : functionCalls.map(fc => fc.rawPart || {
              functionCall: {
                id: fc.id,
                name: fc.name,
                args: fc.args,
                thought_signature: fc.thought_signature || fc.thoughtSignature,
                thoughtSignature: fc.thought_signature || fc.thoughtSignature
              }
            }),
            functionCalls,
            isHidden: true
          };

          const userRespMsg: Message = {
            id: `user-resp-${Math.random()}`,
            role: "user",
            content: "",
            timestamp: replyTime,
            parts: results.map((r, idx) => ({
              functionResponse: {
                name: functionCalls[idx].name,
                response: r.output
              }
            })),
            functionResponses: results.map((r, idx) => ({
              name: functionCalls[idx].name,
              response: r.output
            })),
            isHidden: true
          };

          // Update local React state and local variable for next API turn
          setChatMessages((prev) => [...prev, ...imageMessages, modelCallMsg, userRespMsg]);
          currentMessages = [...currentMessages, ...imageMessages, modelCallMsg, userRespMsg];
        }
      }

    } catch (error: any) {
      console.error("[Chat] Error sending message:", error);
      const msg = error.message || "";
      if (
        msg === "CHAT_LIMIT_REACHED" ||
        msg === "TOOL_LOCKED" ||
        msg === "IMAGE_LOCKED"
      ) {
        setShowUpgradeModal(true);
      } else if (
        msg === "PRO_IMAGE_LIMIT_REACHED" ||
        msg === "PRO_TOOL_LIMIT_REACHED" ||
        msg === "PRO_CHAT_LIMIT_REACHED"
      ) {
        triggerNotification("Daily limit reached. Resets at midnight IST 🌙", "info");
      } else {
        triggerNotification(msg || "Failed to contact chat server", "error");
      }
    } finally {
      setChatLoading(false);
    }
  };

  const handleClearHistory = () => {
    setChatMessages([]);
    triggerNotification("Chat history deleted.", "info");
  };

  const handleNewChat = () => {
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setChatMessages([
      {
        id: `welcome-${Math.random()}`,
        role: "assistant",
        content: "Hey again! Let's start a brand new topic. What are we planning next? 😏",
        timestamp: now
      }
    ]);
    triggerNotification("New chat started.", "info");
  };

  // Disconnect voice session if the user switches to chat mode to preserve bandwidth/connections
  const handleModeChange = (newMode: InteractionMode) => {
    if (newMode === "chat" && state !== "disconnected") {
      disconnect();
    }
    setMode(newMode);
  };

  if (authLoading) {
    return (
      <div className={`relative min-h-screen ${THEMES[theme].bgClass} text-white flex flex-col items-center justify-center font-sans overflow-hidden transition-colors duration-500`}>
        {/* Glowing background orbs */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none -z-20">
          {THEMES[theme].orbs.map((orbClass, index) => (
            <div
              key={index}
              className={`absolute rounded-full blur-[150px] animate-pulse ${orbClass}`}
              style={{ animationDuration: index === 0 ? "12s" : index === 1 ? "15s" : "20s" }}
            />
          ))}
        </div>
        <div className="text-center space-y-4">
          <div className="w-10 h-10 border-4 border-rose-500/30 border-t-rose-500 rounded-full animate-spin mx-auto" />
          <p className="text-xs font-mono tracking-widest uppercase text-gray-400">Loading Shibani Secure Workspace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative min-h-screen ${THEMES[theme].bgClass} text-white flex flex-col font-sans overflow-x-hidden transition-colors duration-500`}>
      
      {/* Premium glowing background orbs */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none -z-20">
        {THEMES[theme].orbs.map((orbClass, index) => (
          <div
            key={index}
            className={`absolute rounded-full blur-[150px] animate-pulse ${orbClass}`}
            style={{ animationDuration: index === 0 ? "12s" : index === 1 ? "15s" : "20s" }}
          />
        ))}
      </div>

      {/* Main Container */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 flex flex-col gap-6 justify-center">
        
        {/* Header Block */}
        <Header 
          mode={mode} 
          onModeChange={handleModeChange} 
          state={state} 
          theme={theme} 
          onThemeChange={setTheme} 
          session={session} 
          onLogout={handleLogout} 
          avatarPreference={avatarPreference}
          onAvatarPreferenceChange={handleAvatarPreferenceChange}
        />

        {!session ? (
          <LoginScreen theme={theme} />
        ) : (
          <>
            {/* Dynamic sliding panel layout */}
            <div className="flex-1 w-full max-w-4xl mx-auto flex flex-col justify-center min-h-[500px]">
              <AnimatePresence mode="wait">
                {mode === "voice" ? (
                  <motion.div
                    key="voice"
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -15 }}
                    transition={{ duration: 0.3 }}
                    className={`w-full ${latestVoiceImage ? "max-w-4xl" : "max-w-xl"} mx-auto grid grid-cols-1 md:grid-cols-12 gap-6 items-center`}
                  >
                    <div className={`${latestVoiceImage ? "md:col-span-6" : "md:col-span-12"} w-full transition-all duration-500`}>
                      <VoiceVisualizer
                        state={state}
                        volumesRef={volumesRef}
                        isMuted={isMuted}
                        onToggleMute={toggleMute}
                        onConnect={connect}
                        onDisconnect={disconnect}
                        theme={theme}
                        isGeneratingImage={isVoiceGeneratingImage}
                        avatarUrl={activeAvatarUrl}
                        onMicChange={setSelectedMicId}
                      />
                    </div>

                    {latestVoiceImage && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.9, x: 20 }}
                        animate={{ opacity: 1, scale: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.9, x: 20 }}
                        className="md:col-span-6 w-full"
                      >
                        {/* Beautiful generated image card */}
                        <div className={`relative flex flex-col p-6 rounded-3xl border ${THEMES[theme].borderColor} ${THEMES[theme].cardBg} backdrop-blur-xl shadow-2xl h-[480px] justify-between`}>
                          <div className="flex justify-between items-center mb-3">
                            <span className="text-xs tracking-wider font-mono uppercase text-rose-300">Shibani Shared a Photograph</span>
                            <button
                              onClick={() => setLatestVoiceImage(null)}
                              className="p-1 rounded-full hover:bg-white/10 text-gray-400 hover:text-white transition-colors cursor-pointer"
                              title="Close panel"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          
                          <div className="relative flex-1 rounded-2xl overflow-hidden border border-white/5 bg-black/40 flex items-center justify-center">
                            <img
                              src={latestVoiceImage.url}
                              alt={latestVoiceImage.prompt}
                              referrerPolicy="no-referrer"
                              className="max-h-full max-w-full object-contain rounded-xl"
                            />
                          </div>
                          
                          <div className="mt-4 flex flex-col gap-2">
                            <p className="text-xs text-gray-400 italic text-center line-clamp-2">
                              "{latestVoiceImage.prompt}"
                            </p>
                            <button
                              onClick={() => handleDownloadImage(latestVoiceImage.url, latestVoiceImage.prompt)}
                              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-rose-500 to-pink-500 text-white font-semibold hover:brightness-110 shadow-lg transition-all flex items-center justify-center gap-2 text-sm cursor-pointer"
                            >
                              <Download className="w-4 h-4" />
                              <span>Download Image</span>
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="chat"
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -15 }}
                    transition={{ duration: 0.3 }}
                    className="w-full"
                  >
                    <ChatWindow
                      messages={chatMessages}
                      onSendMessage={handleSendChatMessage}
                      isLoading={chatLoading}
                      onClearHistory={handleClearHistory}
                      onNewChat={handleNewChat}
                      theme={theme}
                      isGeneratingImage={isChatGeneratingImage}
                      avatarUrl={activeAvatarUrl}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Bento Trust & Capability Badges */}
            <div id="bento-trust-row" className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-4xl mx-auto select-none mt-4">
              <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-white/[0.01] hover:bg-white/[0.03] transition-all duration-300">
                <div className="p-2.5 rounded-xl bg-pink-500/10 text-pink-400">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">Full Privacy Safe</h4>
                  <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                    Your voice streaming and API keys are proxy-processed securely. No local storage leaks.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-white/[0.01] hover:bg-white/[0.03] transition-all duration-300">
                <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-400">
                  <Volume2 className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">Multilingual Voice</h4>
                  <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                    Fluent conversational detection across English, Hindi, Hinglish, Bengali, and Banglish.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-white/[0.01] hover:bg-white/[0.03] transition-all duration-300">
                <div className="p-2.5 rounded-xl bg-violet-500/10 text-violet-400">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">Function Calling</h4>
                  <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                    Control your browser seamlessly with integrated tools to open YouTube, Google Search, and Maps.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Floating Smart Media Player */}
      <MusicPlayer />

      {/* Upgrade Modal */}
      <AnimatePresence>
        {showUpgradeModal && (
          <UpgradeModal
            session={session}
            onClose={() => setShowUpgradeModal(false)}
            onSuccess={() => triggerNotification("Successfully upgraded to Pro! 🎉", "success")}
            onError={(msg) => triggerNotification(msg, "error")}
          />
        )}
      </AnimatePresence>

      {/* Floating System notifications */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4.5 py-3 rounded-2xl border bg-black/80 backdrop-blur-lg shadow-xl"
            style={{
              borderColor:
                notification.type === "success"
                  ? "rgba(16, 185, 129, 0.3)"
                  : notification.type === "error"
                  ? "rgba(239, 68, 68, 0.3)"
                  : "rgba(59, 130, 246, 0.3)",
            }}
          >
            {notification.type === "success" ? (
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : notification.type === "error" ? (
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
            ) : (
              <Info className="w-5 h-5 text-blue-400 shrink-0" />
            )}
            <span className="text-xs font-medium text-gray-100">{notification.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer Branding */}
      <footer className="py-6 text-center text-[11px] font-mono tracking-wider text-gray-500 select-none">
        SHIBANI ROY v3.1 • POWERED BY GEMINI LIVE API & EXPRESS • MADE WITH <Heart className="w-3 h-3 inline text-rose-500 fill-rose-500/30" /> FOR SOUMYA MITRA
      </footer>
    </div>
  );
}
