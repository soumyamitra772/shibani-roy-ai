/**
 * Theme Customization Configuration for Shibani Roy App
 */

export type ThemeId = "classic" | "sunset" | "midnight" | "pastel";

export interface ThemeConfig {
  id: ThemeId;
  name: string;
  bgClass: string;
  textClass: string;
  cardBg: string;
  borderColor: string;
  accentGradient: string;
  orbs: string[]; // tailwind color classes for background gradient orbs
  badgeClass: string;
}

export const THEMES: Record<ThemeId, ThemeConfig> = {
  classic: {
    id: "classic",
    name: "Classic Space",
    bgClass: "bg-[#09090b]",
    textClass: "text-white",
    cardBg: "bg-black/40 border-white/10",
    borderColor: "border-white/10",
    accentGradient: "from-rose-500 to-pink-500",
    orbs: [
      "bg-rose-500/10 w-[600px] h-[600px] top-[-10%] left-[-10%]",
      "bg-violet-600/10 w-[700px] h-[700px] bottom-[-10%] right-[-10%]",
      "bg-pink-600/5 w-[500px] h-[500px] top-[40%] left-[30%]"
    ],
    badgeClass: "border-rose-500/10 bg-rose-500/5 text-rose-300"
  },
  sunset: {
    id: "sunset",
    name: "Golden Sunset",
    bgClass: "bg-[#160b0d]",
    textClass: "text-amber-50",
    cardBg: "bg-orange-950/20 border-amber-500/15",
    borderColor: "border-amber-500/15",
    accentGradient: "from-amber-500 to-rose-500",
    orbs: [
      "bg-orange-500/10 w-[600px] h-[600px] top-[-10%] left-[-10%]",
      "bg-red-600/10 w-[700px] h-[700px] bottom-[-10%] right-[-10%]",
      "bg-amber-600/5 w-[500px] h-[500px] top-[40%] left-[30%]"
    ],
    badgeClass: "border-amber-500/10 bg-amber-500/5 text-amber-300"
  },
  midnight: {
    id: "midnight",
    name: "Midnight Indigo",
    bgClass: "bg-[#020512]",
    textClass: "text-blue-50",
    cardBg: "bg-blue-950/25 border-indigo-500/20",
    borderColor: "border-indigo-500/20",
    accentGradient: "from-blue-500 via-indigo-500 to-purple-500",
    orbs: [
      "bg-blue-600/15 w-[650px] h-[650px] top-[-10%] left-[-10%]",
      "bg-indigo-600/15 w-[750px] h-[750px] bottom-[-10%] right-[-10%]",
      "bg-cyan-500/5 w-[550px] h-[550px] top-[40%] left-[30%]"
    ],
    badgeClass: "border-indigo-500/10 bg-indigo-500/5 text-indigo-300"
  },
  pastel: {
    id: "pastel",
    name: "Pastel Dream",
    bgClass: "bg-[#0f0e15]",
    textClass: "text-purple-50",
    cardBg: "bg-purple-950/20 border-purple-400/20",
    borderColor: "border-purple-400/20",
    accentGradient: "from-purple-400 to-pink-400",
    orbs: [
      "bg-purple-400/10 w-[600px] h-[600px] top-[-10%] left-[-10%]",
      "bg-pink-400/10 w-[700px] h-[700px] bottom-[-10%] right-[-10%]",
      "bg-indigo-400/5 w-[500px] h-[500px] top-[40%] left-[30%]"
    ],
    badgeClass: "border-purple-400/10 bg-purple-400/5 text-purple-300"
  }
};
