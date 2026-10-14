import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Mic,
  MessageSquare,
  Palette,
  LogOut,
  Camera,
  Sparkles,
  ShieldCheck,
  ChevronDown,
  Check,
  X
} from "lucide-react";
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
  isPro?: boolean;
  onUpgradeClick?: () => void;
  isAdmin?: boolean;
  onAdminClick?: () => void;
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
  onAvatarPreferenceChange,
  isPro = false,
  onUpgradeClick,
  isAdmin = false,
  onAdminClick,
}: HeaderProps) {
  const [showLooks, setShowLooks] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNoSessionThemeOpen, setIsNoSessionThemeOpen] = useState(false);

  const profileRef = useRef<HTMLDivElement>(null);
  const noSessionThemeRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside clicks or Escape key
  useEffect(() => {
    function handleClickOutside(event: MouseEvent | TouchEvent) {
      const target = event.target as Node;
      if (profileRef.current && !profileRef.current.contains(target)) {
        setIsProfileOpen(false);
      }
      if (noSessionThemeRef.current && !noSessionThemeRef.current.contains(target)) {
        setIsNoSessionThemeOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsProfileOpen(false);
        setIsNoSessionThemeOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Close Looks panel on Escape key
  useEffect(() => {
    if (!showLooks) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowLooks(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showLooks]);

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

  // User initial for profile circle
  const userEmail = session?.user?.email || "";
  const userInitial = (userEmail[0] || "S").toUpperCase();

  // Voice status chip visibility: show only when mode === "voice" OR state !== "disconnected"
  const showVoiceStatus = mode === "voice" || state !== "disconnected";

  return (
    <div className="flex flex-col gap-3 w-full max-w-5xl mx-auto">
      <header className="flex flex-col w-full py-3.5 px-4 sm:px-6 rounded-3xl border border-white/5 bg-white/[0.02] backdrop-blur-md shadow-lg select-none gap-3">
        {/* ROW 1: Always one line, on mobile too */}
        <div className="flex items-center justify-between w-full gap-2 sm:gap-4">
          {/* Left: Brand & Badges */}
          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <h1 className="text-xl sm:text-2xl font-bold font-sans tracking-tight bg-gradient-to-r from-white via-rose-100 to-pink-200 bg-clip-text text-transparent">
              Shibani Roy
            </h1>
            {isPro ? (
              <button
                onClick={onUpgradeClick}
                className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-500/20 to-yellow-500/20 border border-amber-500/40 text-amber-300 font-mono text-[9px] font-bold uppercase tracking-wider shadow-[0_0_10px_rgba(245,158,11,0.2)] hover:bg-amber-500/30 hover:scale-105 transition-all cursor-pointer"
                title="View Pro Subscription Details"
              >
                ⭐ Pro
              </button>
            ) : (
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded border ${activeTheme.badgeClass} font-mono text-[9px] uppercase tracking-widest`}>
                AI Companion
              </span>
            )}
          </div>

          {/* Right: Actions in strict order */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* 1. For logged-in FREE users only: Upgrade to Pro ⭐ */}
            {session && !isPro && onUpgradeClick && (
              <button
                onClick={onUpgradeClick}
                className="flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-full bg-gradient-to-r from-amber-400 via-amber-500 to-yellow-500 hover:from-amber-300 hover:to-yellow-400 text-black font-bold text-xs shadow-md shadow-amber-500/20 hover:scale-[1.03] active:scale-95 transition-all duration-300 cursor-pointer font-sans shrink-0"
                title="Upgrade to Pro Access"
              >
                <Sparkles className="w-3.5 h-3.5 fill-black text-black" />
                <span className="sm:hidden">Pro</span>
                <span className="hidden sm:inline">Upgrade to Pro ⭐</span>
              </button>
            )}

            {/* 2. Compact voice status chip: colored dot + label on sm+ (no "Voice Link:" prefix) */}
            {showVoiceStatus && (
              <div
                className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 rounded-full border border-white/5 bg-white/5 shadow-sm text-xs text-gray-300 font-mono shrink-0"
                title={`Voice link: ${status?.label || "Offline"}`}
              >
                <span className="relative flex h-2 w-2 shrink-0">
                  {status && status.ping && (
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${status.color} opacity-75`} />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${status?.color || "bg-gray-500"}`} />
                </span>
                <span className="font-medium text-white hidden sm:inline">
                  {status?.label || "Offline"}
                </span>
              </div>
            )}

            {/* 3. Profile button (only when session exists): round 36px with initial */}
            {session && (
              <div className="relative shrink-0" ref={profileRef}>
                <button
                  onClick={() => setIsProfileOpen((prev) => !prev)}
                  className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-white shadow-md border border-white/20 hover:scale-105 active:scale-95 transition-all cursor-pointer bg-gradient-to-r ${activeTheme.accentGradient}`}
                  title="Profile & Settings"
                  aria-expanded={isProfileOpen}
                >
                  <span>{userInitial}</span>
                </button>

                {/* Profile Dropdown Menu */}
                <AnimatePresence>
                  {isProfileOpen && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95, y: -4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: -4 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 top-full mt-2 w-72 sm:w-80 rounded-2xl border border-white/10 bg-[#12111a]/95 backdrop-blur-xl shadow-2xl p-3 z-50 flex flex-col gap-2.5 text-xs text-gray-200"
                    >
                      {/* User Info Header */}
                      <div className="flex items-center gap-2.5 pb-2.5 border-b border-white/10">
                        <div
                          className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-white shrink-0 bg-gradient-to-r ${activeTheme.accentGradient}`}
                        >
                          {userInitial}
                        </div>
                        <div className="flex flex-col min-w-0 flex-1">
                          <p className="font-semibold text-white truncate text-xs">
                            {userEmail || "Logged In User"}
                          </p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {isPro ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-mono text-[10px] font-semibold border border-amber-500/30">
                                ⭐ Pro Active
                              </span>
                            ) : (
                              <span className="text-[11px] text-gray-400">
                                Free Plan
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Pro / Subscription Action */}
                      {onUpgradeClick && (
                        <button
                          onClick={() => {
                            setIsProfileOpen(false);
                            onUpgradeClick();
                          }}
                          className={`flex items-center justify-between w-full px-3 py-2 rounded-xl transition-all cursor-pointer font-medium ${
                            isPro
                              ? "bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/25"
                              : "bg-gradient-to-r from-amber-500/20 to-yellow-500/20 hover:from-amber-500/30 hover:to-yellow-500/30 text-amber-200 border border-amber-500/30"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-amber-400" />
                            <span>{isPro ? "Pro Plan Details" : "Upgrade to Pro"}</span>
                          </div>
                          <span className="text-amber-400 font-bold">⭐</span>
                        </button>
                      )}

                      {/* Theme Selector */}
                      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/5 border border-white/5">
                        <div className="flex items-center gap-2 text-gray-300">
                          <Palette className="w-4 h-4 text-rose-400" />
                          <span className="font-medium">Theme</span>
                        </div>
                        <select
                          value={theme}
                          onChange={(e) => onThemeChange(e.target.value as ThemeId)}
                          className="bg-[#1c1b26] border border-white/10 rounded-lg text-white text-xs px-2.5 py-1 focus:outline-none cursor-pointer"
                        >
                          {Object.values(THEMES).map((t) => (
                            <option key={t.id} value={t.id} className="bg-[#12111a] text-white">
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Avatar Looks Picker Toggle */}
                      <button
                        onClick={() => {
                          setIsProfileOpen(false);
                          setShowLooks((prev) => !prev);
                        }}
                        className={`flex items-center justify-between w-full px-3 py-2 rounded-xl border transition-all cursor-pointer ${
                          showLooks
                            ? "bg-rose-500/20 border-rose-500/40 text-rose-300"
                            : "bg-white/5 border-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Camera className="w-4 h-4 text-rose-400" />
                          <span className="font-medium">Avatar Looks</span>
                        </div>
                        <span className="text-[10px] font-mono text-gray-400">
                          {avatarPreference === "auto" || !avatarPreference ? "Auto 🔄" : avatarPreference.toUpperCase()}
                        </span>
                      </button>

                      {/* Admin Panel (if user is admin) */}
                      {isAdmin && onAdminClick && (
                        <button
                          onClick={() => {
                            setIsProfileOpen(false);
                            onAdminClick();
                          }}
                          className="flex items-center gap-2 w-full px-3 py-2 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/25 text-purple-300 transition-all cursor-pointer font-medium"
                        >
                          <ShieldCheck className="w-4 h-4 text-purple-400" />
                          <span>Admin Panel</span>
                        </button>
                      )}

                      {/* Log Out */}
                      <div className="pt-1 border-t border-white/10">
                        <button
                          onClick={() => {
                            setIsProfileOpen(false);
                            onLogout();
                          }}
                          className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-red-300 hover:bg-red-500/15 border border-transparent hover:border-red-500/25 transition-all cursor-pointer font-medium"
                        >
                          <LogOut className="w-4 h-4 text-red-400" />
                          <span>Log Out</span>
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* 4. When there is NO session: small round Palette button opening theme list */}
            {!session && (
              <div className="relative shrink-0" ref={noSessionThemeRef}>
                <button
                  onClick={() => setIsNoSessionThemeOpen((prev) => !prev)}
                  className="w-9 h-9 rounded-full flex items-center justify-center border border-white/10 bg-white/5 hover:bg-white/10 text-rose-400 hover:text-white transition-all cursor-pointer"
                  title="Change Theme"
                  aria-expanded={isNoSessionThemeOpen}
                >
                  <Palette className="w-4 h-4" />
                </button>

                <AnimatePresence>
                  {isNoSessionThemeOpen && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95, y: -4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: -4 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 top-full mt-2 w-48 rounded-2xl border border-white/10 bg-[#12111a]/95 backdrop-blur-xl shadow-2xl p-2 z-50 flex flex-col gap-1 text-xs"
                    >
                      <div className="px-2 py-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                        Select Theme
                      </div>
                      {Object.values(THEMES).map((t) => (
                        <button
                          key={t.id}
                          onClick={() => {
                            onThemeChange(t.id);
                            setIsNoSessionThemeOpen(false);
                          }}
                          className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition cursor-pointer ${
                            theme === t.id
                              ? "bg-white/15 text-white font-semibold"
                              : "text-gray-300 hover:bg-white/5 hover:text-white"
                          }`}
                        >
                          <span>{t.name}</span>
                          {theme === t.id && <Check className="w-3.5 h-3.5 text-rose-400" />}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>

        {/* ROW 2: Voice Mode / Chat Mode slider centered, full width up to max-w-xs */}
        <div className="flex justify-center w-full pt-1">
          <div className="relative flex items-center bg-black/50 border border-white/10 rounded-full p-1.5 w-full max-w-xs shadow-inner">
            <button
              onClick={() => onModeChange("voice")}
              className={`relative z-10 flex-1 flex items-center justify-center gap-2 py-2 rounded-full text-xs font-semibold tracking-wide transition-all duration-300 cursor-pointer ${
                mode === "voice" ? "text-white" : "text-gray-400 hover:text-gray-300"
              }`}
            >
              <Mic className="w-3.5 h-3.5" />
              <span>Voice Mode</span>
            </button>

            <button
              onClick={() => onModeChange("chat")}
              className={`relative z-10 flex-1 flex items-center justify-center gap-2 py-2 rounded-full text-xs font-semibold tracking-wide transition-all duration-300 cursor-pointer ${
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
              className={`absolute top-1.5 bottom-1.5 rounded-full bg-gradient-to-r ${activeTheme.accentGradient} shadow-md -z-0`}
              style={{
                left: mode === "voice" ? "6px" : "calc(50% + 2px)",
                width: "calc(50% - 8px)",
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
            <div className="flex items-start sm:items-center justify-between gap-3 border-b border-white/5 pb-3">
              <div className="min-w-0 pr-2">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Camera className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>Choose Shibani's Look</span>
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  Select a specific avatar look or let her look rotate automatically every day.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => onAvatarPreferenceChange("auto")}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all duration-300 cursor-pointer whitespace-nowrap ${
                    avatarPreference === "auto" || avatarPreference === ""
                      ? "bg-gradient-to-r from-rose-500 to-pink-500 text-white border-transparent shadow-lg shadow-rose-500/20"
                      : "border-white/10 bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  Auto-Rotate: {avatarPreference === "auto" || avatarPreference === "" ? "ON 🔄" : "OFF ⏸️"}
                </button>
                <button
                  onClick={() => setShowLooks(false)}
                  aria-label="Close looks panel"
                  title="Close"
                  className="w-9 h-9 rounded-full flex items-center justify-center border border-white/10 bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-all cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-4 sm:grid-cols-8 gap-4 py-2">
              {Array.from({ length: 8 }).map((_, i) => {
                const lookNum = i + 1;
                const lookId = `look-${lookNum}`;
                const isSelected = avatarPreference === lookId;
                const imgSrc = `https://lkxxnumhlcdbqknmulmu.supabase.co/storage/v1/object/public/avatars/${lookId}.jpg`;

                return (
                  <button
                    key={lookId}
                    onClick={() => onAvatarPreferenceChange(lookId)}
                    className="flex flex-col items-center gap-1.5 group cursor-pointer focus:outline-none"
                  >
                    <div
                      className={`relative w-14 h-14 rounded-2xl overflow-hidden border-2 transition-all duration-300 ${
                        isSelected
                          ? "border-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.6)] scale-105"
                          : "border-white/10 group-hover:border-rose-500/50 group-hover:scale-102"
                      }`}
                    >
                      <img
                        src={imgSrc}
                        alt={`Look ${lookNum}`}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src =
                            "https://lkxxnumhlcdbqknmulmu.supabase.co/storage/v1/object/public/avatars/look-1.jpg";
                        }}
                      />
                      {isSelected && (
                        <div className="absolute inset-0 bg-rose-500/20 flex items-center justify-center">
                          <div className="bg-rose-500 text-white rounded-full p-0.5 text-[8px] font-bold shadow-md">
                            ✓
                          </div>
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-[10px] font-mono transition-colors ${
                        isSelected
                          ? "text-rose-400 font-bold"
                          : "text-gray-400 group-hover:text-gray-300"
                      }`}
                    >
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
