/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MessageSquare, Sparkles, Volume2, ShieldCheck, Heart, AlertCircle, Info } from "lucide-react";
import Header from "./components/Header";
import VoiceVisualizer from "./components/VoiceVisualizer";
import ChatWindow from "./components/ChatWindow";
import { useVoiceConnection } from "./hooks/useVoiceConnection";
import { Message, InteractionMode } from "./types";
import { ToolExecutor } from "./services/ToolExecutor";
import { MusicPlayer } from "./components/MusicPlayer";

export default function App() {
  const [mode, setMode] = useState<InteractionMode>("voice");
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  // Trigger a self-fading overlay notification for tool executions
  const triggerNotification = (message: string, type: "success" | "error" | "info" = "success") => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // Wire up the custom voice engine
  const {
    state,
    isMuted,
    volumesRef,
    connect,
    disconnect,
    toggleMute,
    stopPlayback,
  } = useVoiceConnection({
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
          toolName: logMessage.includes("Google") ? "searchGoogle" : logMessage.includes("YouTube") ? "openYouTube" : logMessage.includes("Maps") ? "openMaps" : "Browser Link"
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
    
    const updatedMessages = [...chatMessages, userMsg];
    setChatMessages(updatedMessages);
    setChatLoading(true);

    try {
      // 2. Dispatch REST call to our Express secure Gemini proxy with streaming support
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedMessages.map(m => ({ role: m.role, content: m.content }))
        })
      });

      if (!response.ok) {
        throw new Error("Failed to connect to Shibani. Check API server.");
      }

      const replyTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const assistantMessageId = `assistant-${Math.random()}`;

      // 3. Add an empty assistant message that we will stream text into
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
            } catch (e) {
              console.error("Error parsing stream line:", line, e);
            }
          }
        }
      }

      // 4. Execute client-side tool calls if Gemini requested them
      if (functionCalls.length > 0) {
        for (const call of functionCalls) {
          const result = await ToolExecutor.execute(call);
          
          // Append log to conversation history
          setChatMessages((prev) => [
            ...prev,
            {
              id: `tool-${Math.random()}`,
              role: "assistant",
              content: result.message,
              timestamp: replyTime,
              isToolCall: true,
              toolName: call.name
            }
          ]);

          triggerNotification(result.message, result.success ? "success" : "error");
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
    <div className="relative min-h-screen bg-[#09090b] text-white flex flex-col font-sans overflow-x-hidden">
      
      {/* Premium glowing background orbs */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none -z-20">
        <div className="absolute top-[-10%] left-[-10%] w-[600px] h-[600px] rounded-full bg-rose-500/10 blur-[150px] animate-pulse" style={{ animationDuration: "12s" }} />
        <div className="absolute bottom-[-10%] right-[-10%] w-[700px] h-[700px] rounded-full bg-violet-600/10 blur-[180px] animate-pulse" style={{ animationDuration: "15s" }} />
        <div className="absolute top-[40%] left-[30%] w-[500px] h-[500px] rounded-full bg-pink-600/5 blur-[160px] animate-pulse" style={{ animationDuration: "20s" }} />
      </div>

      {/* Main Container */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 flex flex-col gap-6">
        
        {/* Header Block */}
        <Header mode={mode} onModeChange={handleModeChange} state={state} />

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
                className="w-full max-w-xl mx-auto"
              >
                <VoiceVisualizer
                  state={state}
                  volumesRef={volumesRef}
                  isMuted={isMuted}
                  onToggleMute={toggleMute}
                  onConnect={connect}
                  onDisconnect={disconnect}
                />
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
