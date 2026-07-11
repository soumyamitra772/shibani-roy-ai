/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { motion } from "motion/react";
import { Mic, MessageSquare, Radio, Github } from "lucide-react";
import { InteractionMode, AssistantState } from "../types";

interface HeaderProps {
  mode: InteractionMode;
  onModeChange: (mode: InteractionMode) => void;
  state: AssistantState;
}

export default function Header({ mode, onModeChange, state }: HeaderProps) {
  // Determine text status based on the current voice/websocket connection state
  const getStatusLabel = () => {
    switch (state) {
      case "disconnected":
        return { label: "Offline", color: "bg-gray-500", ping: false };
      case "connecting":
        return { label: "Connecting...", color: "bg-blue-400", ping: true };
      case "connected":
        return { label: "Connected", color: "bg-emerald-400", ping: true };
      case "listening":
        return { label: "Listening", color: "bg-pink-400", ping: true };
      case "thinking":
        return { label: "Thinking...", color: "bg-purple-400", ping: true };
      case "speaking":
        return { label: "Speaking", color: "bg-rose-400", ping: true };
      case "interrupted":
        return { label: "Interrupted", color: "bg-amber-400", ping: false };
      case "error":
        return { label: "Error", color: "bg-red-400", ping: false };
    }
  };

  const status = getStatusLabel();

  return (
    <header className="flex flex-col sm:flex-row items-center justify-between w-full max-w-5xl mx-auto py-5 px-6 rounded-3xl border border-white/5 bg-white/[0.02] backdrop-blur-md shadow-lg select-none gap-4">
      {/* Title & Brand */}
      <div className="flex flex-col text-center sm:text-left">
        <div className="flex items-center justify-center sm:justify-start gap-2.5">
          <h1 className="text-2xl font-bold font-sans tracking-tight bg-gradient-to-r from-white via-rose-100 to-pink-300 bg-clip-text text-transparent">
            Shibani Roy
          </h1>
          <span className="flex items-center gap-1 px-2 py-0.5 rounded border border-rose-500/10 bg-rose-500/5 font-mono text-[9px] text-rose-300 uppercase tracking-widest">
            AI Companion
          </span>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Created by <span className="font-medium text-gray-300 hover:text-rose-300 transition-colors">Soumya Mitra</span> (সৌম্য মিত্র)
        </p>
      </div>

      {/* Dynamic Status Display & Mode Toggle */}
      <div className="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto">
        {/* Connection status indicator */}
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/5 bg-white/5 shadow-sm text-xs text-gray-300 font-mono">
          <span className="relative flex h-2 w-2">
            {status.ping && (
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${status.color} opacity-75`} />
            )}
            <span className={`relative inline-flex rounded-full h-2 w-2 ${status.color}`} />
          </span>
          <span className="text-gray-400">Voice Link:</span>
          <span className="font-medium text-white">{status.label}</span>
        </div>

        {/* Slidable Switch for Interaction Modes */}
        <div className="relative flex items-center bg-black/50 border border-white/10 rounded-full p-1.5 max-w-xs shadow-inner">
          <button
            onClick={() => onModeChange("voice")}
            className={`relative z-10 flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold tracking-wide transition-all duration-300 cursor-pointer ${
              mode === "voice" ? "text-white" : "text-gray-400 hover:text-gray-300"
            }`}
          >
            <Mic className="w-3.5 h-3.5" />
            <span>Voice Mode</span>
          </button>
          
          <button
            onClick={() => onModeChange("chat")}
            className={`relative z-10 flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold tracking-wide transition-all duration-300 cursor-pointer ${
              mode === "chat" ? "text-white" : "text-gray-400 hover:text-gray-300"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Chat Mode</span>
          </button>

          {/* Sliding selector indicator background */}
          <motion.div
            layout
            transition={{ type: "spring", stiffness: 350, damping: 25 }}
            className="absolute top-1.5 bottom-1.5 left-1.5 rounded-full bg-gradient-to-r from-rose-500 to-pink-500 shadow-md -z-0"
            style={{
              width: mode === "voice" ? "106px" : "103px",
              x: mode === "voice" ? 0 : "106px",
            }}
          />
        </div>
      </div>
    </header>
  );
}
