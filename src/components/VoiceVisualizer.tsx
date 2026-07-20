/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MicOff, PhoneOff, Radio, Sparkles, Camera } from "lucide-react";
import { AssistantState } from "../types";
import { ThemeId, THEMES } from "../utils/themes";

interface VoiceVisualizerProps {
  state: AssistantState;
  volumesRef: React.RefObject<{ mic: number; speaker: number }>;
  isMuted: boolean;
  onToggleMute: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  theme: ThemeId;
  isGeneratingImage?: boolean;
  avatarUrl: string;
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
}: VoiceVisualizerProps) {
  const [bars, setBars] = useState<number[]>(Array(24).fill(10));

  // Update visualizer equalizer bars based on audio volumes and active state
  useEffect(() => {
    let animationFrameId: number;
    
    const updateBars = () => {
      const volumes = volumesRef.current || { mic: 0, speaker: 0 };
      const volume = state === "speaking" ? volumes.speaker : state === "listening" ? volumes.mic : 0;
      
      setBars((prev) =>
        prev.map((_, i) => {
          // Base height
          let base = 8;
          // React to volume
          if (volume > 0.01) {
            const factor = Math.sin((i / prev.length) * Math.PI) * 80;
            base = Math.max(10, volume * factor + Math.random() * 15);
          } else if (state === "speaking") {
            // Simulated jitter when speaking but volume is low
            base = 15 + Math.random() * 25 * Math.sin(i * 0.5);
          } else if (state === "thinking") {
            // Idle scanning motion
            const time = Date.now() * 0.005;
            base = 12 + Math.sin(time + i * 0.4) * 10;
          } else if (state === "listening") {
            // Tiny ambient rustle
            base = 10 + Math.random() * 8;
          }
          
          // Clamp height between 6 and 90
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
        desc: "Capturing a picture... 📸"
      };
    }
    switch (state) {
      case "disconnected":
        return {
          glow: "rgba(156, 163, 175, 0.2)",
          ring: "border-gray-600/30",
          gradient: "from-gray-500/10 to-gray-700/10",
          text: "text-gray-400",
          desc: "Ready to connect to Shibani"
        };
      case "connecting":
        return {
          glow: "rgba(59, 130, 246, 0.4)",
          ring: "border-blue-500/30",
          gradient: "from-blue-500/10 to-indigo-500/10 animate-pulse",
          text: "text-blue-400",
          desc: "Establishing secure connection..."
        };
      case "connected":
        return {
          glow: "rgba(16, 185, 129, 0.3)",
          ring: "border-emerald-500/30",
          gradient: "from-emerald-500/10 to-teal-500/10",
          text: "text-emerald-400",
          desc: "Connected with Shibani Roy"
        };
      case "listening":
        return {
          glow: "rgba(236, 72, 153, 0.5)",
          ring: "border-pink-500/40 animate-pulse",
          gradient: "from-pink-500/10 to-rose-500/10",
          text: "text-pink-400",
          desc: "Go ahead, speak to her..."
        };
      case "thinking":
        return {
          glow: "rgba(139, 92, 246, 0.5)",
          ring: "border-violet-500/40 animate-ping",
          gradient: "from-violet-500/15 to-purple-500/15",
          text: "text-purple-400 font-medium animate-pulse",
          desc: "Shibani is styling her thoughts..."
        };
      case "speaking":
        return {
          glow: "rgba(244, 63, 94, 0.6)",
          ring: "border-rose-500/50",
          gradient: "from-rose-500/20 to-pink-500/20",
          text: "text-rose-400 font-medium",
          desc: "Shibani is talking..."
        };
      case "interrupted":
        return {
          glow: "rgba(245, 158, 11, 0.4)",
          ring: "border-amber-500/40",
          gradient: "from-amber-500/15 to-orange-500/15",
          text: "text-amber-400",
          desc: "Interrupted"
        };
      case "error":
        return {
          glow: "rgba(239, 68, 68, 0.4)",
          ring: "border-red-500/40",
          gradient: "from-red-500/10 to-rose-950/20",
          text: "text-red-400 font-medium",
          desc: "Connection failed. Retrying..."
        };
    }
  };

  const colors = getStateColors();
  const activeTheme = THEMES[theme];

  return (
    <div id="voice-visualizer-card" className={`relative flex flex-col items-center justify-between h-[480px] p-6 rounded-3xl border ${activeTheme.borderColor} ${activeTheme.cardBg} backdrop-blur-xl shadow-2xl overflow-hidden group`}>
      
      {/* Background glow overlay */}
      <div
        className="absolute inset-0 -z-10 transition-all duration-1000 ease-in-out blur-[80px] opacity-40"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${colors.glow}, transparent 60%)`,
        }}
      />

      {/* Decorative top badge */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/5 bg-white/5 backdrop-blur-md">
        <Radio className={`w-3.5 h-3.5 ${state !== "disconnected" ? "text-rose-500 animate-pulse" : "text-gray-500"}`} />
        <span className="text-xs tracking-wider font-mono uppercase text-gray-300">
          Voice Engine v3.1
        </span>
      </div>

      {/* Main Avatar Orb */}
      <div className="relative flex items-center justify-center w-52 h-52 my-4">
        {/* State rings */}
        <AnimatePresence>
          {state !== "disconnected" && (
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{
                scale: state === "speaking" ? [1, 1.15, 1] : state === "thinking" ? [1, 1.08, 1] : 1,
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

        {/* Inner Glowing Core */}
        <motion.div
          animate={{
            scale: state === "speaking" ? 1.12 : state === "listening" ? 1.05 : [1, 1.04, 1],
          }}
          transition={{
            duration: state === "disconnected" ? 5 : 3,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          style={{
            boxShadow: `0 0 40px 10px ${colors.glow}`,
          }}
          className={`relative flex items-center justify-center w-40 h-40 rounded-full bg-gradient-to-tr ${colors.gradient} border border-white/10 overflow-hidden shadow-inner cursor-pointer`}
          onClick={state === "disconnected" ? onConnect : undefined}
        >
          {/* Base Avatar Image filling the entire core */}
          <img
            src={avatarUrl}
            alt="Shibani Roy"
            referrerPolicy="no-referrer"
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
              state === "disconnected" ? "opacity-35 hover:opacity-50" : "opacity-85"
            }`}
            onError={(e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.src = "https://lkxxnumhlcdbqknmulmu.supabase.co/storage/v1/object/public/avatars/look-1.jpg";
            }}
          />

          {/* Dark Overlay for non-speaking states to focus on status icon */}
          {state !== "speaking" && state !== "listening" && (
            <div className="absolute inset-0 bg-black/30 backdrop-blur-[0.5px]" />
          )}

          {/* Pulsing neon particles or sparkles */}
          {state === "thinking" && (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
              className="absolute inset-0 opacity-40 bg-[radial-gradient(circle_at_50%_120%,rgba(139,92,246,0.5),transparent)]"
            />
          )}

          {/* State indicators centered over the avatar */}
          <div className="z-10 flex flex-col items-center justify-center text-center">
            {isGeneratingImage ? (
              <motion.div
                animate={{ scale: [1, 1.15, 1], rotate: [0, 5, -5, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              >
                <Camera className="w-12 h-12 text-purple-400 drop-shadow-[0_2px_10px_rgba(168,85,247,0.5)]" />
              </motion.div>
            ) : state === "disconnected" ? (
              <PhoneOff className="w-12 h-12 text-white/80 group-hover:text-rose-400 transition-colors duration-300 drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]" />
            ) : state === "thinking" ? (
              <Sparkles className="w-12 h-12 text-purple-300 animate-spin drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]" />
            ) : null}
          </div>
        </motion.div>
      </div>

      {/* State Text & Feedback */}
      <div className="text-center h-14 flex flex-col justify-center select-none">
        <h3 className={`text-lg font-medium tracking-tight ${colors.text} transition-colors duration-300`}>
          {colors.desc}
        </h3>
        {state === "speaking" && (
          <p className="text-xs text-rose-300/60 font-mono mt-1">
            24kHz PCM Stereo Output
          </p>
        )}
        {state === "listening" && (
          <p className="text-xs text-pink-300/60 font-mono mt-1">
            16kHz PCM Mono Input
          </p>
        )}
      </div>

      {/* Equalizer Waveform display */}
      <div id="equalizer-waveform" className="flex items-end justify-center gap-[3px] w-full max-w-sm h-14 px-4 select-none">
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

      {/* Controller Buttons Tray */}
      <div id="controls-tray" className="flex items-center gap-4 w-full justify-center pt-2">
        {state === "disconnected" ? (
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={onConnect}
            className={`flex items-center gap-2.5 px-6 py-3 rounded-full bg-gradient-to-r ${activeTheme.accentGradient} text-white font-medium shadow-lg hover:brightness-110 transition-all duration-300 cursor-pointer`}
          >
            <Mic className="w-5 h-5" />
            <span>Connect Voice</span>
          </motion.button>
        ) : (
          <div className="flex items-center gap-4">
            {/* Toggle Mute / Microhpone Button */}
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={onToggleMute}
              className={`p-3.5 rounded-full border transition-all duration-300 cursor-pointer ${
                isMuted
                  ? "bg-red-500/20 border-red-500/30 text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.2)]"
                  : "bg-white/5 border-white/10 text-white hover:bg-white/10"
              }`}
              title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </motion.button>

            {/* Disconnect Call Button */}
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={onDisconnect}
              className="p-3.5 rounded-full bg-red-600 border border-red-500/20 text-white shadow-[0_4px_15px_rgba(220,38,38,0.4)] hover:bg-red-500 hover:shadow-[0_4px_25px_rgba(220,38,38,0.6)] transition-all duration-300 cursor-pointer"
              title="Disconnect Voice Session"
            >
              <PhoneOff className="w-5 h-5" />
            </motion.button>
          </div>
        )}
      </div>
    </div>
  );
}
