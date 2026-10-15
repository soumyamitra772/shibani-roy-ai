/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MicOff, Phone, PhoneOff, Camera, Sparkles, Lock, ChevronDown } from "lucide-react";
import { AssistantState } from "../types";
import { ThemeId, THEMES } from "../utils/themes";
import { CallPhase, FailureReason } from "../hooks/useVoiceConnection";
import { MOODS, MoodId, getMoodById } from "../utils/moods";
import MoodPicker from "./MoodPicker";

interface VoiceVisualizerProps {
  state: AssistantState;
  volumesRef: React.RefObject<{ mic: number; speaker: number }>;
  isMuted: boolean;
  onToggleMute: () => void;
  onConnect: () => void;
  onDisconnect: (isUserHangup?: boolean) => void;
  theme: ThemeId;
  isGeneratingImage?: boolean;
  avatarUrl: string;
  onMicChange?: (deviceId: string) => void;
  callPhase?: CallPhase;
  failureReason?: FailureReason;
  isCallDropped?: boolean;
  remainingSeconds?: number | null;
  limitSeconds?: number | null;
  is1MinWarningActive?: boolean;
  isSilenceHangup?: boolean;
  isQuotaHangup?: boolean;
  isPro?: boolean;
  selectedMood?: MoodId;
  onSelectMood?: (moodId: MoodId) => void;
  onLockedMoodClick?: (moodId: MoodId) => void;
  onUpgrade?: () => void;
}

export default function VoiceVisualizer({
  state,
  volumesRef,
  isMuted,
  onToggleMute,
  onConnect,
  onDisconnect,
  theme,
  isGeneratingImage = false,
  avatarUrl,
  onMicChange,
  callPhase = state === "connecting" ? "ringing" : state === "disconnected" ? "idle" : "active",
  failureReason = null,
  isCallDropped = false,
  remainingSeconds = null,
  limitSeconds = null,
  is1MinWarningActive = false,
  isSilenceHangup = false,
  isQuotaHangup = false,
  isPro = false,
  selectedMood = "normal",
  onSelectMood,
  onLockedMoodClick,
  onUpgrade,
}: VoiceVisualizerProps) {
  const [bars, setBars] = useState<number[]>(Array(24).fill(10));
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>("");
  const [isMoodPickerOpen, setIsMoodPickerOpen] = useState(false);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);

  // Close picker when selectedMood successfully changes
  const prevMoodRef = useRef(selectedMood);
  useEffect(() => {
    if (prevMoodRef.current !== selectedMood) {
      prevMoodRef.current = selectedMood;
      setIsMoodPickerOpen(false);
    }
  }, [selectedMood]);

  // Call Duration Timer
  const [timerText, setTimerText] = useState("00:00");
  const activeStartTimestampRef = useRef<number>(0);
  const finalDurationRef = useRef<string>("00:00");

  useEffect(() => {
    let intervalId: any = null;

    if (callPhase === "active") {
      if (activeStartTimestampRef.current === 0) {
        activeStartTimestampRef.current = Date.now();
      }

      const updateTimer = () => {
        const elapsedSec = Math.floor((Date.now() - activeStartTimestampRef.current) / 1000);
        const hours = Math.floor(elapsedSec / 3600);
        const minutes = Math.floor((elapsedSec % 3600) / 60);
        const seconds = elapsedSec % 60;

        const pad = (n: number) => n.toString().padStart(2, "0");
        let formatted = `${pad(minutes)}:${pad(seconds)}`;
        if (hours > 0) {
          formatted = `${hours}:${pad(minutes)}:${pad(seconds)}`;
        }
        setTimerText(formatted);
        finalDurationRef.current = formatted;
      };

      updateTimer();
      intervalId = setInterval(updateTimer, 250);
    } else if (callPhase === "idle" || callPhase === "ringing") {
      activeStartTimestampRef.current = 0;
      setTimerText("00:00");
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [callPhase]);

  const refreshMics = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(all.filter((d) => d.kind === "audioinput"));
    } catch (e) {}
  }, []);

  useEffect(() => {
    refreshMics();
  }, [refreshMics]);

  // Update visualizer equalizer bars based on audio volumes and active state
  useEffect(() => {
    let animationFrameId: number;

    const updateBars = () => {
      const volumes = volumesRef.current || { mic: 0, speaker: 0 };
      const volume =
        state === "speaking" ? volumes.speaker : state === "listening" ? volumes.mic : 0;

      setBars((prev) =>
        prev.map((_, i) => {
          let base = 8;
          if (volume > 0.01) {
            const factor = Math.sin((i / prev.length) * Math.PI) * 80;
            base = Math.max(10, volume * factor + Math.random() * 15);
          } else if (state === "speaking") {
            base = 15 + Math.random() * 25 * Math.sin(i * 0.5);
          } else if (state === "thinking") {
            const time = Date.now() * 0.005;
            base = 12 + Math.sin(time + i * 0.4) * 10;
          } else if (state === "listening") {
            base = 10 + Math.random() * 8;
          }

          return Math.min(90, Math.max(6, base));
        })
      );

      animationFrameId = requestAnimationFrame(updateBars);
    };

    updateBars();
    return () => cancelAnimationFrame(animationFrameId);
  }, [state, volumesRef]);

  // Determine color theme based on current state
  const getStateColors = () => {
    if (isGeneratingImage) {
      return {
        glow: "rgba(139, 92, 246, 0.6)",
        ring: "border-purple-500/50 animate-pulse",
        gradient: "from-purple-500/15 to-violet-500/15 animate-pulse",
        text: "text-purple-400 font-semibold animate-pulse",
        desc: "Capturing a picture... 📸",
      };
    }
    switch (state) {
      case "disconnected":
        return {
          glow: "rgba(156, 163, 175, 0.2)",
          ring: "border-gray-600/30",
          gradient: "from-gray-500/10 to-gray-700/10",
          text: "text-gray-400",
          desc: "Ready to connect to Shibani",
        };
      case "connecting":
        return {
          glow: "rgba(244, 63, 94, 0.4)",
          ring: "border-rose-500/40",
          gradient: "from-rose-500/15 to-pink-500/15",
          text: "text-rose-400",
          desc: "Calling...",
        };
      case "connected":
        return {
          glow: "rgba(16, 185, 129, 0.3)",
          ring: "border-emerald-500/30",
          gradient: "from-emerald-500/10 to-teal-500/10",
          text: "text-emerald-400",
          desc: "Connected with Shibani Roy",
        };
      case "listening":
        return {
          glow: "rgba(236, 72, 153, 0.5)",
          ring: "border-pink-500/40 animate-pulse",
          gradient: "from-pink-500/10 to-rose-500/10",
          text: "text-pink-400",
          desc: "Go ahead, speak to her...",
        };
      case "thinking":
        return {
          glow: "rgba(139, 92, 246, 0.5)",
          ring: "border-violet-500/40 animate-ping",
          gradient: "from-violet-500/15 to-purple-500/15",
          text: "text-purple-400 font-medium animate-pulse",
          desc: "Shibani is styling her thoughts...",
        };
      case "speaking":
        return {
          glow: "rgba(244, 63, 94, 0.6)",
          ring: "border-rose-500/50",
          gradient: "from-rose-500/20 to-pink-500/20",
          text: "text-rose-400 font-medium",
          desc: "Shibani is talking...",
        };
      case "interrupted":
        return {
          glow: "rgba(245, 158, 11, 0.4)",
          ring: "border-amber-500/40",
          gradient: "from-amber-500/15 to-orange-500/15",
          text: "text-amber-400",
          desc: "Interrupted",
        };
      case "error":
        return {
          glow: "rgba(239, 68, 68, 0.4)",
          ring: "border-red-500/40",
          gradient: "from-red-500/10 to-rose-950/20",
          text: "text-red-400 font-medium",
          desc: "Connection failed",
        };
    }
  };

  const colors = getStateColors();
  const activeTheme = THEMES[theme];
  const currentMood = getMoodById(selectedMood);
  const isDuringCall = callPhase === "ringing" || callPhase === "active";

  return (
    <div
      id="voice-visualizer-card"
      className={`relative flex flex-col items-center justify-between min-h-[500px] h-auto p-6 rounded-3xl border ${activeTheme.borderColor} ${activeTheme.cardBg} backdrop-blur-xl shadow-2xl overflow-hidden group`}
    >
      {/* Background glow overlay */}
      <div
        className="absolute inset-0 -z-10 transition-all duration-1000 ease-in-out blur-[80px] opacity-40 pointer-events-none"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${colors.glow}, transparent 60%)`,
        }}
      />

      {/* Top Header: Shibani Roy & Live Phase Status */}
      <div className="flex flex-col items-center justify-center text-center">
        <h2 className="text-base font-semibold tracking-tight text-white font-sans">
          Shibani Roy{isDuringCall && selectedMood !== "normal" ? ` · ${currentMood.label}` : ""}
        </h2>
        <div
          aria-live="polite"
          className="flex items-center justify-center gap-1.5 min-h-[22px] mt-0.5 text-xs font-mono select-none"
        >
          {callPhase === "idle" && (
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-gray-400">Tap to call</span>
              {remainingSeconds !== null && remainingSeconds !== undefined && (
                <span className="text-[11px] font-sans text-neutral-400 font-normal">
                  {Math.floor(remainingSeconds / 60)}:{Math.floor(remainingSeconds % 60).toString().padStart(2, "0")} remaining today
                </span>
              )}
            </div>
          )}

          {callPhase === "ringing" && (
            <span className="text-rose-300 font-medium flex items-center">
              Calling
              <span className="inline-flex w-5 text-left ml-0.5">
                <span className="animate-pulse">.</span>
                <span className="animate-pulse [animation-delay:200ms]">.</span>
                <span className="animate-pulse [animation-delay:400ms]">.</span>
              </span>
            </span>
          )}

          {callPhase === "active" && (
            <div className="flex flex-col items-center gap-0.5">
              <div className="flex items-center gap-2 text-xs font-mono select-none">
                <span className="flex items-center gap-1.5 text-emerald-400 font-semibold tabular-nums">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>{timerText}</span>
                </span>
                {remainingSeconds !== null && remainingSeconds !== undefined && (
                  <>
                    <span className="text-white/20 select-none">•</span>
                    <span
                      className={`tabular-nums transition-colors duration-300 ${
                        remainingSeconds <= 60
                          ? "text-amber-400 font-bold animate-pulse"
                          : "text-emerald-300/80 font-medium"
                      }`}
                      title="Daily voice time remaining"
                    >
                      {Math.floor(remainingSeconds / 60)}:{Math.floor(remainingSeconds % 60).toString().padStart(2, "0")} left
                    </span>
                  </>
                )}
              </div>
              {(is1MinWarningActive || (remainingSeconds !== null && remainingSeconds !== undefined && remainingSeconds <= 60 && remainingSeconds > 0)) && (
                <span className="text-[10px] text-amber-300 font-sans font-medium flex items-center gap-1 animate-pulse">
                  <span>⚠️</span> 1 min remaining
                </span>
              )}
            </div>
          )}

          {callPhase === "ended" && (
            <span className="text-gray-300 font-medium tabular-nums">
              {isQuotaHangup
                ? "Daily voice limit reached · Call ended"
                : isSilenceHangup
                ? "Call ended after 1 min silence"
                : isCallDropped
                ? "Call dropped"
                : `Call ended · ${finalDurationRef.current}`}
            </span>
          )}

          {callPhase === "failed" && (
            <span className="text-red-400 font-medium flex items-center gap-1">
              {failureReason === "mic"
                ? "Microphone blocked"
                : failureReason === "limit"
                ? "Daily voice minutes used"
                : "Call failed"}
            </span>
          )}
        </div>
      </div>

      {/* Main Avatar Orb */}
      <div className="relative flex items-center justify-center w-52 h-52 my-2">
        {/* Ringing: 3 expanding ripple rings pulsing outward from avatar */}
        {callPhase === "ringing" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none -z-10">
            <div
              className="absolute w-44 h-44 rounded-full border border-rose-500/40 motion-safe:animate-ping opacity-35 motion-reduce:opacity-60 motion-reduce:animate-none"
              style={{ animationDuration: "2.4s" }}
            />
            <div
              className="absolute w-52 h-52 rounded-full border border-rose-400/30 motion-safe:animate-pulse opacity-45 motion-reduce:opacity-40 motion-reduce:animate-none"
              style={{ animationDuration: "2s" }}
            />
            <div
              className="absolute w-60 h-60 rounded-full border border-rose-400/20 opacity-30 motion-reduce:opacity-20"
            />
          </div>
        )}

        {/* State rings for active session */}
        <AnimatePresence>
          {callPhase === "active" && (
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{
                scale:
                  state === "speaking" ? [1, 1.15, 1] : state === "thinking" ? [1, 1.08, 1] : 1,
                opacity: 0.25,
              }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{
                duration: state === "thinking" ? 1.5 : 2.5,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              className={`absolute inset-0 rounded-full border-2 ${colors.ring} -z-10`}
            />
          )}
        </AnimatePresence>

        {/* Inner Glowing Core with Avatar */}
        <motion.div
          animate={{
            scale:
              state === "speaking"
                ? 1.12
                : state === "listening"
                ? 1.05
                : [1, 1.04, 1],
          }}
          transition={{
            duration: callPhase === "idle" ? 5 : 3,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          style={{
            boxShadow: `0 0 40px 10px ${colors.glow}`,
          }}
          className={`relative flex items-center justify-center w-40 h-40 rounded-full bg-gradient-to-tr ${colors.gradient} border border-white/10 overflow-hidden shadow-inner cursor-pointer`}
          onClick={callPhase === "idle" || callPhase === "failed" ? onConnect : undefined}
          title={callPhase === "idle" || callPhase === "failed" ? "Call Shibani" : undefined}
        >
          {/* Base Avatar Image filling the entire core */}
          <img
            src={avatarUrl}
            alt="Shibani Roy"
            referrerPolicy="no-referrer"
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
              callPhase === "idle"
                ? "opacity-65 hover:opacity-85"
                : callPhase === "ringing"
                ? "opacity-75"
                : "opacity-90"
            }`}
            onError={(e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.src =
                "https://lkxxnumhlcdbqknmulmu.supabase.co/storage/v1/object/public/avatars/look-1.jpg";
            }}
          />

          {/* Dark Overlay for non-speaking states */}
          {state !== "speaking" && state !== "listening" && callPhase !== "idle" && (
            <div className="absolute inset-0 bg-black/30 backdrop-blur-[0.5px]" />
          )}

          {/* Pulsing neon particles or sparkles during thinking */}
          {state === "thinking" && (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
              className="absolute inset-0 opacity-40 bg-[radial-gradient(circle_at_50%_120%,rgba(139,92,246,0.5),transparent)]"
            />
          )}

          {/* State indicator overlay icon (No crossed-out phone in idle) */}
          <div className="z-10 flex flex-col items-center justify-center text-center">
            {isGeneratingImage ? (
              <motion.div
                animate={{ scale: [1, 1.15, 1], rotate: [0, 5, -5, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              >
                <Camera className="w-12 h-12 text-purple-400 drop-shadow-[0_2px_10px_rgba(168,85,247,0.5)]" />
              </motion.div>
            ) : state === "thinking" ? (
              <Sparkles className="w-12 h-12 text-purple-300 animate-spin drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]" />
            ) : null}
          </div>
        </motion.div>
      </div>

      {/* Active Conversation Status (Developer sample rate text removed) */}
      <div className="text-center h-8 flex flex-col justify-center select-none">
        {callPhase === "active" && (
          <h3 className={`text-sm font-medium tracking-tight ${colors.text} transition-colors duration-300`}>
            {colors.desc}
          </h3>
        )}
      </div>

      {/* Equalizer Waveform display */}
      <div
        id="equalizer-waveform"
        className="flex items-end justify-center gap-[3px] w-full max-w-sm h-12 px-4 select-none"
      >
        {bars.map((height, i) => (
          <motion.div
            key={i}
            animate={{ height: `${height}%` }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className={`w-1 rounded-full transition-colors duration-300 ${
              state === "speaking"
                ? "bg-rose-500/80 shadow-[0_0_10px_rgba(244,63,94,0.5)]"
                : state === "listening"
                ? "bg-pink-500/80 shadow-[0_0_10px_rgba(236,72,153,0.5)]"
                : state === "thinking"
                ? "bg-violet-500/60"
                : "bg-white/10"
            }`}
          />
        ))}
      </div>

      {/* Microphone Selector (only shown when idle) */}
      {callPhase === "idle" && (
        <div className="flex flex-col gap-1 w-full max-w-xs mx-auto mb-2">
          <label className="text-xs text-neutral-400 font-medium">Microphone</label>
          <div className="flex gap-2">
            <select
              value={selectedMicId}
              onChange={(e) => {
                setSelectedMicId(e.target.value);
                onMicChange?.(e.target.value);
              }}
              className="flex-1 bg-neutral-900 border border-neutral-700 text-white text-xs rounded-lg px-2.5 py-1.5 focus:outline-none"
            >
              <option value="">Auto-detect (recommended)</option>
              {micDevices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
            <button
              onClick={refreshMics}
              title="Refresh mic list"
              className="px-2.5 py-1.5 text-neutral-400 hover:text-white border border-neutral-700 bg-neutral-900 rounded-lg cursor-pointer"
            >
              ↺
            </button>
          </div>
          <p className="text-[10px] text-neutral-500">
            Using Bluetooth? Select built-in mic if audio has echo.
          </p>
        </div>
      )}

      {/* Role-Play Mood Button (only while no call is active: idle, ended or failed) */}
      {(callPhase === "idle" || callPhase === "ended" || callPhase === "failed") && (
        <div className="w-full max-w-xs mx-auto flex justify-center my-2 z-10">
          <button
            ref={triggerButtonRef}
            type="button"
            onClick={() => setIsMoodPickerOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={isMoodPickerOpen}
            className={`min-h-[44px] px-5 py-2.5 rounded-full border text-xs font-medium flex items-center justify-between gap-3 transition-all shadow-sm cursor-pointer ${
              selectedMood !== "normal"
                ? `bg-gradient-to-r ${activeTheme.accentGradient} text-white border-white/20 shadow-md hover:brightness-110`
                : "bg-neutral-900 border-neutral-700 text-neutral-200 hover:text-white hover:border-neutral-600"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-base leading-none select-none">{currentMood.emoji}</span>
              <span className="font-semibold tracking-tight">Role-play: {currentMood.label}</span>
            </div>
            <ChevronDown className="w-4 h-4 opacity-70 shrink-0" />
          </button>
        </div>
      )}

      {/* Controller Buttons Tray */}
      <div id="controls-tray" className="flex items-center gap-4 w-full justify-center pt-1">
        {callPhase === "idle" ? (
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={onConnect}
            className={`flex items-center gap-2.5 px-6 py-3 rounded-full bg-gradient-to-r ${activeTheme.accentGradient} text-white font-medium shadow-lg hover:brightness-110 transition-all duration-300 cursor-pointer`}
          >
            <Phone className="w-5 h-5" />
            <span>Call Shibani</span>
          </motion.button>
        ) : callPhase === "failed" ? (
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={onConnect}
            className={`flex items-center gap-2.5 px-6 py-3 rounded-full bg-gradient-to-r ${activeTheme.accentGradient} text-white font-medium shadow-lg hover:brightness-110 transition-all duration-300 cursor-pointer`}
          >
            <Phone className="w-5 h-5" />
            <span>Call again</span>
          </motion.button>
        ) : (
          <div className="flex items-center gap-4">
            {/* Toggle Mute Button: disabled while ringing */}
            <motion.button
              whileHover={callPhase === "ringing" ? undefined : { scale: 1.1 }}
              whileTap={callPhase === "ringing" ? undefined : { scale: 0.9 }}
              onClick={callPhase === "ringing" ? undefined : onToggleMute}
              disabled={callPhase === "ringing"}
              className={`p-3.5 rounded-full border transition-all duration-300 ${
                callPhase === "ringing"
                  ? "bg-white/5 border-white/5 text-gray-500 opacity-40 cursor-not-allowed"
                  : isMuted
                  ? "bg-red-500/20 border-red-500/30 text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.2)] cursor-pointer"
                  : "bg-white/5 border-white/10 text-white hover:bg-white/10 cursor-pointer"
              }`}
              title={
                callPhase === "ringing"
                  ? "Mute unavailable while calling"
                  : isMuted
                  ? "Unmute Microphone"
                  : "Mute Microphone"
              }
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </motion.button>

            {/* Hang Up Button: visible and enabled during ringing and active */}
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => onDisconnect(true)}
              className="p-3.5 rounded-full bg-red-600 border border-red-500/20 text-white shadow-[0_4px_15px_rgba(220,38,38,0.4)] hover:bg-red-500 hover:shadow-[0_4px_25px_rgba(220,38,38,0.6)] transition-all duration-300 cursor-pointer"
              title="Hang up"
            >
              <PhoneOff className="w-5 h-5" />
            </motion.button>
          </div>
        )}
      </div>

      {/* Role-Play Mood Picker Modal */}
      <MoodPicker
        isOpen={isMoodPickerOpen}
        onClose={() => setIsMoodPickerOpen(false)}
        selectedMood={selectedMood}
        onSelectMood={(moodId) => {
          onSelectMood?.(moodId);
        }}
        onLockedMoodClick={(moodId) => {
          if (onLockedMoodClick) {
            onLockedMoodClick(moodId);
          } else {
            onUpgrade?.();
          }
        }}
        isPro={isPro}
        theme={theme}
        triggerRef={triggerButtonRef}
      />
    </div>
  );
}
