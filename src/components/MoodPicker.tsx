/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { X, Check, Lock } from "lucide-react";
import { MOODS, MoodId } from "../utils/moods";
import { ThemeId, THEMES } from "../utils/themes";

interface MoodPickerProps {
  isOpen: boolean;
  onClose: () => void;
  selectedMood: MoodId;
  onSelectMood: (moodId: MoodId) => void;
  onLockedMoodClick: (moodId: MoodId) => void;
  isPro?: boolean;
  theme: ThemeId;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function MoodPicker({
  isOpen,
  onClose,
  selectedMood,
  onSelectMood,
  onLockedMoodClick,
  isPro = false,
  theme,
  triggerRef,
}: MoodPickerProps) {
  const activeTheme = THEMES[theme];
  const dialogRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();

  // Handle Escape key to close dialog and return focus
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        triggerRef?.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, triggerRef]);

  const handleClose = () => {
    onClose();
    triggerRef?.current?.focus();
  };

  const handleMoodClick = (moodId: MoodId, isLocked: boolean) => {
    if (isLocked) {
      handleClose();
      onLockedMoodClick(moodId);
      return;
    }

    // Check if 18+ adult confirmation is required for Wife or Girlfriend
    if (moodId === "wife" || moodId === "girlfriend") {
      let adultOk = false;
      try {
        adultOk = localStorage.getItem("shibani_adult_ok") === "1";
      } catch (e) {}

      if (!adultOk) {
        // Trigger 18+ prompt without closing picker so it stays open if cancelled
        onSelectMood(moodId);
        return;
      }
    }

    onSelectMood(moodId);
    handleClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          {/* Dimmed Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.15 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm"
            aria-hidden="true"
          />

          {/* Modal / Bottom Sheet */}
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mood-picker-title"
            aria-describedby="mood-picker-desc"
            initial={
              shouldReduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: 30, scale: 0.98 }
            }
            animate={
              shouldReduceMotion
                ? { opacity: 1 }
                : { opacity: 1, y: 0, scale: 1 }
            }
            exit={
              shouldReduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: 20, scale: 0.98 }
            }
            transition={{ duration: shouldReduceMotion ? 0 : 0.18, ease: "easeOut" }}
            className="relative z-10 w-full max-h-[80vh] sm:max-w-sm rounded-t-3xl sm:rounded-3xl border-t sm:border border-white/10 bg-neutral-900/95 backdrop-blur-xl shadow-2xl p-5 sm:p-6 flex flex-col gap-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between pb-1 border-b border-white/5">
              <div>
                <h3
                  id="mood-picker-title"
                  className="text-base sm:text-lg font-bold text-white tracking-tight"
                >
                  Role-play mood
                </h3>
                <p
                  id="mood-picker-desc"
                  className="text-xs text-neutral-400 mt-0.5 leading-relaxed"
                >
                  How should Shibani talk to you on this call?
                </p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                title="Close"
                className="p-1.5 rounded-full hover:bg-white/10 text-neutral-400 hover:text-white transition-colors cursor-pointer shrink-0 ml-2"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Moods List */}
            <div
              role="radiogroup"
              aria-label="Role-play moods"
              className="flex flex-col gap-2 overflow-y-auto no-scrollbar max-h-[60vh] pr-0.5"
            >
              {MOODS.map((mood) => {
                const isSelected = selectedMood === mood.id;
                const isLocked = mood.tier === "pro" && !isPro;

                return (
                  <button
                    key={mood.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => handleMoodClick(mood.id, isLocked)}
                    className={`min-h-[56px] w-full flex items-center justify-between p-3.5 rounded-2xl border transition-all cursor-pointer text-left ${
                      isSelected
                        ? `bg-gradient-to-r ${activeTheme.accentGradient} text-white shadow-md border-white/20`
                        : "bg-white/5 hover:bg-white/10 text-neutral-200 border-white/5 hover:border-white/15"
                    }`}
                  >
                    {/* Left: Emoji + Label + Tagline */}
                    <div className="flex items-center gap-3 min-w-0 pr-2">
                      <span className="text-2xl shrink-0 select-none">
                        {mood.emoji}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold tracking-tight text-white flex items-center gap-1.5">
                          <span>{mood.label}</span>
                        </div>
                        <div
                          className={`text-xs truncate ${
                            isSelected ? "text-white/80" : "text-neutral-400"
                          }`}
                        >
                          {mood.tagline}
                        </div>
                      </div>
                    </div>

                    {/* Right: Checkmark or PRO Lock */}
                    <div className="shrink-0 ml-2 flex items-center">
                      {isSelected && (
                        <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                          <Check className="w-4 h-4 text-white" />
                        </div>
                      )}
                      {isLocked && (
                        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300">
                          <Lock className="w-3 h-3 text-amber-400" />
                          <span className="text-[10px] font-bold tracking-wider">
                            PRO
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
