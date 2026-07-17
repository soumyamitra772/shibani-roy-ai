/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Send, Trash2, RefreshCw, Copy, Check, MessageSquare, Sparkles, Download, Camera } from "lucide-react";
import { Message } from "../types";
import Markdown from "./Markdown";
import { ThemeId, THEMES } from "../utils/themes";

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  isLoading: boolean;
  onClearHistory: () => void;
  onNewChat: () => void;
  theme: ThemeId;
  isGeneratingImage?: boolean;
  avatarUrl: string;
}

const CONVERSATION_STARTERS = [
  "How's your day going? 😊",
  "Play me something upbeat! 🎵",
  "Tell me something interesting 💡",
  "I need to vent for a bit... 🥺",
  "How is the weather in Kolkata today? ⛅",
  "Tease me! Let's see your witty side 😜",
  "Bolo kemon acho? 😊 Let's chat in Bengali",
  "Hinglish me baat karein? 😏",
  "Suggest a cozy acoustic song for my mood 🍃",
  "Tell me a deep secret 🤫",
  "Suggest a relaxing track for stress relief 🧘‍♀️",
  "What's your favorite memory of us so far? 💕"
];

export default function ChatWindow({
  messages,
  onSendMessage,
  isLoading,
  onClearHistory,
  onNewChat,
  theme,
  isGeneratingImage = false,
  avatarUrl,
}: ChatWindowProps) {
  const [input, setInput] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [starters, setStarters] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    } catch (err) {
      console.error("Error downloading image:", err);
      window.open(imageUrl, "_blank");
    }
  };

  // Generate a random selection of 5 starters
  const rotateStarters = () => {
    const shuffled = [...CONVERSATION_STARTERS].sort(() => 0.5 - Math.random());
    setStarters(shuffled.slice(0, 5));
  };

  // Rotate starters when component mounts or messages change to empty
  useEffect(() => {
    rotateStarters();
  }, [messages.length]);

  // Auto scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    onSendMessage(input.trim());
    setInput("");
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const activeTheme = THEMES[theme];

  return (
    <div id="chat-window-card" className={`flex flex-col h-[520px] rounded-3xl border ${activeTheme.borderColor} ${activeTheme.cardBg} backdrop-blur-xl shadow-2xl overflow-hidden`}>
      {/* Top Controller Tray */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-white/5 select-none">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full border border-rose-500/20 overflow-hidden shadow-md shrink-0">
            <img src={avatarUrl} alt="Shibani" className="w-full h-full object-cover" />
          </div>
          <h2 className="text-md font-semibold text-white tracking-wide">
            Chat with Shibani Roy
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {/* New Chat Button */}
          <button
            onClick={onNewChat}
            className="p-2 rounded-lg border border-white/5 bg-white/5 hover:bg-white/10 text-gray-300 transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-medium"
            title="Start New Conversation"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">New Chat</span>
          </button>
          
          {/* Delete History Button */}
          <button
            onClick={onClearHistory}
            className="p-2 rounded-lg border border-red-500/10 bg-red-500/5 hover:bg-red-500/15 text-red-400 hover:text-red-300 transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-medium"
            title="Clear Chat History"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Clear History</span>
          </button>
        </div>
      </div>

      {/* Message List area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        {(() => {
          const visibleMessages = messages.filter(msg => !msg.isHidden);
          if (visibleMessages.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-full text-center p-6 space-y-4">
                <div className="w-20 h-20 rounded-full border border-rose-500/20 flex items-center justify-center p-0.5 bg-gradient-to-tr from-rose-500 to-pink-500 shadow-lg overflow-hidden">
                  <div className="w-full h-full rounded-full overflow-hidden bg-[#12101a]">
                    <img src={avatarUrl} alt="Shibani" className="w-full h-full object-cover" />
                  </div>
                </div>
                <div>
                  <h3 className="text-lg font-medium text-white">Ask Shibani anything</h3>
                  <p className="text-sm text-gray-400 mt-1 max-w-sm">
                    Say hello, tease her, test her multilingual skills, or ask her to search the web!
                  </p>
                </div>
              </div>
            );
          }
          return visibleMessages.map((msg) => {
            const isAssistant = msg.role === "assistant";
            return (
              <div
                key={msg.id}
                className={`flex ${isAssistant ? "justify-start" : "justify-end"} items-start gap-2.5 group`}
              >
                {isAssistant && (
                  <div className="flex-shrink-0 w-8 h-8 rounded-full border border-rose-500/20 overflow-hidden mt-1 shadow-md">
                    <img
                      src={avatarUrl}
                      alt="Shibani"
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                )}
                <div className={`relative max-w-[85%] sm:max-w-[75%] rounded-2xl p-4 shadow-lg transition-all duration-300 ${
                  isAssistant
                    ? msg.isToolCall
                      ? "bg-violet-950/40 border border-violet-500/20 text-violet-100 rounded-tl-none"
                      : "bg-gradient-to-br from-rose-950/50 to-pink-950/30 border border-rose-500/15 text-gray-100 rounded-tl-none"
                    : "bg-white/5 border border-white/10 text-white rounded-tr-none"
                }`}>
                  
                  {/* Tool Call Header */}
                  {isAssistant && msg.isToolCall && (
                    <div className="flex items-center gap-1.5 mb-2 text-violet-300 text-xs font-mono select-none">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500"></span>
                      </span>
                      <span>SYSTEM CALL: {msg.toolName}</span>
                    </div>
                  )}

                  {/* Message body */}
                  <div className="pr-6">
                    {msg.imageUrl ? (
                      <div className="mb-1">
                        <div className="relative rounded-xl overflow-hidden border border-white/10 bg-black/30 shadow-inner max-w-full">
                          <img
                            src={msg.imageUrl}
                            alt={msg.imageDescription || "Shibani Roy"}
                            referrerPolicy="no-referrer"
                            className="w-full h-auto max-h-[300px] object-cover rounded-xl"
                          />
                        </div>
                        <div className="mt-2 flex justify-end">
                          <button
                            type="button"
                            onClick={() => handleDownloadImage(msg.imageUrl!, msg.imageDescription || "shibani")}
                            className="px-2.5 py-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 hover:bg-rose-500 text-rose-300 hover:text-white transition-all duration-300 flex items-center gap-1.5 text-[11px] font-semibold cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Download Image</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <Markdown content={msg.content} />
                    )}
                  </div>

                  {/* Timestamp & Copy triggers */}
                  <div className="mt-2 flex items-center justify-between text-[10px] text-gray-400/70 select-none">
                    <span>{msg.timestamp}</span>
                    <button
                      onClick={() => handleCopy(msg.id, msg.content)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/5 text-gray-400 hover:text-white transition-all cursor-pointer"
                      title="Copy Message"
                    >
                      {copiedId === msg.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          });
        })()}

        {/* Dynamic Image Generation Loading State */}
        {isGeneratingImage && (
          <div className="flex justify-start">
            <div className="bg-gradient-to-br from-violet-950/40 to-fuchsia-950/20 border border-violet-500/10 rounded-2xl rounded-tl-none p-4 flex items-center space-x-1.5 select-none shadow-lg">
              <span className="text-xs text-violet-300 font-mono mr-1.5 animate-pulse">Shibani is rendering a photo... 📸</span>
              <span className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "0ms" }}></span>
              <span className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "150ms" }}></span>
              <span className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "300ms" }}></span>
            </div>
          </div>
        )}

        {/* Dynamic Typing Indicator */}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gradient-to-br from-rose-950/40 to-pink-950/20 border border-rose-500/10 rounded-2xl rounded-tl-none p-4 flex items-center space-x-1.5 select-none shadow-lg">
              <span className="text-xs text-rose-300 font-mono mr-1.5">Shibani is writing</span>
              <span className="w-2 h-2 rounded-full bg-rose-400/80 animate-bounce" style={{ animationDelay: "0ms" }}></span>
              <span className="w-2 h-2 rounded-full bg-rose-400/80 animate-bounce" style={{ animationDelay: "150ms" }}></span>
              <span className="w-2 h-2 rounded-full bg-rose-400/80 animate-bounce" style={{ animationDelay: "300ms" }}></span>
            </div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>

      {/* Quick reply tags */}
      {messages.length === 0 && (
        <div className="px-6 py-3 select-none border-t border-white/5 bg-black/20">
          <p className="text-center text-[10px] uppercase tracking-widest text-gray-500 mb-2 font-mono">Suggested Conversations</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {starters.map((reply, i) => (
              <button
                key={i}
                onClick={() => onSendMessage(reply)}
                className="px-3.5 py-1.5 rounded-full text-xs font-medium border border-white/5 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white transition-all cursor-pointer shadow-sm"
              >
                {reply}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input area */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-white/5 bg-white/5">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isLoading ? "Shibani is typing..." : "Type a message to Shibani Roy..."}
            disabled={isLoading}
            className={`flex-1 px-4 py-3 rounded-xl border border-white/10 bg-black/50 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-1 focus:ring-white/20 transition-all disabled:opacity-50`}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className={`p-3 rounded-xl bg-gradient-to-r ${THEMES[theme].accentGradient} text-white hover:brightness-110 disabled:opacity-40 disabled:hover:shadow-none disabled:hover:brightness-100 transition-all cursor-pointer flex items-center justify-center shrink-0`}
            title="Send Message"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
