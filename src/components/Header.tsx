import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MessageSquare, Radio, Github, Palette, LogOut, Camera } from "lucide-react";
import { InteractionMode, AssistantState } from "../types";
import { ThemeId, THEMES } from "../utils/themes";

interface HeaderProps {
  mode: InteractionMode;
  onModeChange: (mode: InteractionMode) => void;
  state: AssistantState;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  session: any;
  onLogout: () => void;
  avatarPreference: string;
  onAvatarPreferenceChange: (pref: string) => void;
}

export default function Header({ 
  mode, 
  onModeChange, 
  state, 
  theme, 
  onThemeChange, 
  session, 
  onLogout,
  avatarPreference,
  onAvatarPreferenceChange
}: HeaderProps) {
  const [showLooks, setShowLooks] = useState(false);

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
  const activeTheme = THEMES[theme];

  return (
    <div className="flex flex-col gap-4 w-full max-w-5xl mx-auto">
      <header className="flex flex-col sm:flex-row items-center justify-between w-full py-5 px-6 rounded-3xl border border-white/5 bg-white/[0.02] backdrop-blur-md shadow-lg select-none gap-4">
        {/* Title & Brand */}
        <div className="flex flex-col text-center sm:text-left">
          <div className="flex items-center justify-center sm:justify-start gap-2.5">
            <h1 className="text-2xl font-bold font-sans tracking-tight bg-gradient-to-r from-white via-rose-100 to-pink-200 bg-clip-text text-transparent">
              Shibani Roy
            </h1>
            <span className={`flex items-center gap-1 px-2 py-0.5 rounded border ${activeTheme.badgeClass} font-mono text-[9px] uppercase tracking-widest`}>
              AI Companion
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Created by <span className="font-medium text-gray-300 hover:text-rose-300 transition-colors">Soumya Mitra</span> (সৌম্য মিত্র)
          </p>
        </div>

        {/* Dynamic Status Display & Mode Toggle */}
        <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          {/* Theme Select Dropdown */}
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/5 bg-white/5 shadow-sm text-xs text-gray-300 font-mono">
            <Palette className="w-3.5 h-3.5 text-rose-400" />
            <span className="text-gray-400 hidden sm:inline">Theme:</span>
            <select
              value={theme}
              onChange={(e) => onThemeChange(e.target.value as ThemeId)}
              className="bg-transparent border-none text-white text-xs font-semibold focus:outline-none focus:ring-0 cursor-pointer pr-1"
            >
              {Object.values(THEMES).map((t) => (
                <option key={t.id} value={t.id} className="bg-[#0f0e15] text-white font-sans text-xs">
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {/* Choose Look Button */}
          {session && (
            <button
              onClick={() => setShowLooks(!showLooks)}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full border transition-all duration-300 cursor-pointer text-xs font-mono ${
                showLooks 
                  ? "bg-rose-500/20 border-rose-500/40 text-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.2)]" 
                  : "border-white/5 bg-white/5 text-gray-300 hover:bg-white/10"
              }`}
              title="Choose Shibani's Look"
            >
              <Camera className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
              <span>Looks</span>
            </button>
          )}

          {/* Connection status indicator */}
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/5 bg-white/5 shadow-sm text-xs text-gray-300 font-mono">
            <span className="relative flex h-2 w-2">
              {status && status.ping && (
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${status.color} opacity-75`} />
              )}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${status?.color || "bg-gray-500"}`} />
            </span>
            <span className="text-gray-400">Voice Link:</span>
            <span className="font-medium text-white">{status?.label || "Offline"}</span>
          </div>

          {/* Logout Button */}
          {session && (
            <button
              onClick={onLogout}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-red-500/20 bg-red-500/5 hover:bg-red-500/15 shadow-sm text-xs text-red-300 font-mono transition-all duration-300 cursor-pointer hover:text-white"
              title="Sign out of your account"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="font-semibold">Log Out</span>
            </button>
          )}

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
              className={`absolute top-1.5 bottom-1.5 left-1.5 rounded-full bg-gradient-to-r ${activeTheme.accentGradient} shadow-md -z-0`}
              style={{
                width: mode === "voice" ? "106px" : "103px",
                x: mode === "voice" ? 0 : "106px",
              }}
            />
          </div>
        </div>
      </header>

      {/* Collapsible Avatar Looks Picker */}
      <AnimatePresence>
        {showLooks && session && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className={`w-full p-5 rounded-3xl border ${activeTheme.borderColor} ${activeTheme.cardBg} backdrop-blur-xl shadow-2xl overflow-hidden flex flex-col gap-4`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/5 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Camera className="w-4 h-4 text-rose-400" />
                  Choose Shibani's Look
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  Select a specific avatar look or let her look rotate automatically every day.
                </p>
              </div>
              <button
                onClick={() => onAvatarPreferenceChange("auto")}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all duration-300 cursor-pointer ${
                  avatarPreference === "auto" || avatarPreference === ""
                    ? "bg-gradient-to-r from-rose-500 to-pink-500 text-white border-transparent shadow-lg shadow-rose-500/20"
                    : "border-white/10 bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white"
                }`}
              >
                Auto-Rotate: {avatarPreference === "auto" || avatarPreference === "" ? "ON 🔄" : "OFF ⏸️"}
              </button>
            </div>

            <div className="grid grid-cols-4 sm:grid-cols-8 gap-4 py-2">
              {Array.from({ length: 8 }).map((_, i) => {
                const lookNum = i + 1;
                const lookId = `look-${lookNum}`;
                const isSelected = avatarPreference === lookId;
                const imgSrc = `/assets/avatar/${lookId}.jpg`;

                return (
                  <button
                    key={lookId}
                    onClick={() => onAvatarPreferenceChange(lookId)}
                    className="flex flex-col items-center gap-1.5 group cursor-pointer focus:outline-none"
                  >
                    <div className={`relative w-14 h-14 rounded-2xl overflow-hidden border-2 transition-all duration-300 ${
                      isSelected 
                        ? "border-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.6)] scale-105" 
                        : "border-white/10 group-hover:border-rose-500/50 group-hover:scale-102"
                    }`}>
                      <img
                        src={imgSrc}
                        alt={`Look ${lookNum}`}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          // Fail-safe: if image hasn't loaded or isn't present, show a high quality fallback
                          (e.target as HTMLImageElement).src = `https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80`;
                        }}
                      />
                      {isSelected && (
                        <div className="absolute inset-0 bg-rose-500/20 flex items-center justify-center">
                          <div className="bg-rose-500 text-white rounded-full p-0.5 text-[8px] font-bold shadow-md">✓</div>
                        </div>
                      )}
                    </div>
                    <span className={`text-[10px] font-mono transition-colors ${isSelected ? "text-rose-400 font-bold" : "text-gray-400 group-hover:text-gray-300"}`}>
                      Look {lookNum}
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
