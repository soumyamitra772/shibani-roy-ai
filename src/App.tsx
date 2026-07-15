/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MessageSquare, Sparkles, Volume2, ShieldCheck, Heart, AlertCircle, Info, X, Download } from "lucide-react";
import Header from "./components/Header";
import VoiceVisualizer from "./components/VoiceVisualizer";
import ChatWindow from "./components/ChatWindow";
import { useVoiceConnection } from "./hooks/useVoiceConnection";
import { Message, InteractionMode } from "./types";
import { ToolExecutor } from "./services/ToolExecutor";
import { MusicPlayer } from "./components/MusicPlayer";
import { getOrCreateUserId } from "./utils/userId";
import { ThemeId, THEMES } from "./utils/themes";

export default function App() {
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = localStorage.getItem("shibani-theme");
    return (saved as ThemeId) || "classic";
  });
  const [mode, setMode] = useState<InteractionMode>("voice");
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  // States for Shibani image generation
  const [latestVoiceImage, setLatestVoiceImage] = useState<{ url: string; prompt: string } | null>(null);
  const [isVoiceGeneratingImage, setIsVoiceGeneratingImage] = useState(false);
  const [isChatGeneratingImage, setIsChatGeneratingImage] = useState(false);

  // Sync theme changes to localStorage
  useEffect(() => {
    localStorage.setItem("shibani-theme", theme);
  }, [theme]);

  // Trigger a self-fading overlay notification for tool executions
  const triggerNotification = (message: string, type: "success" | "error" | "info" = "success") => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

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
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: getOrCreateUserId(),
            messages: currentMessages.map(m => ({
              role: m.role,
              content: m.content,
              parts: m.parts,
              functionCalls: m.functionCalls,
              functionResponses: m.functionResponses
            }))
          })
        });

        if (!response.ok) {
          throw new Error("Failed to connect to Shibani. Check API server.");
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
              // Trigger a subtle in-app floating banner for tool executions
              triggerNotification(result.message, result.success ? "success" : "error");
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
      triggerNotification(error.message || "Failed to contact chat server", "error");
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
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 flex flex-col gap-6">
        
        {/* Header Block */}
        <Header mode={mode} onModeChange={handleModeChange} state={state} theme={theme} onThemeChange={setTheme} />

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
      </main>

      {/* Floating Smart Media Player */}
      <MusicPlayer />

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
