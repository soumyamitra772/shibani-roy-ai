export type MoodId =
  | "normal"
  | "friend"
  | "wife"
  | "girlfriend"
  | "didi"
  | "coach"
  | "bhabi";

export type MoodTier = "free" | "pro";

export interface MoodConfig {
  id: MoodId;
  label: string;
  emoji: string;
  tier: MoodTier;
  tagline: string;
}

export const MOODS: MoodConfig[] = [
  {
    id: "normal",
    label: "Normal",
    emoji: "🙂",
    tier: "free",
    tagline: "Just Shibani"
  },
  {
    id: "friend",
    label: "Friend",
    emoji: "🤝",
    tier: "free",
    tagline: "Your best friend"
  },
  {
    id: "wife",
    label: "Wife",
    emoji: "💍",
    tier: "free",
    tagline: "Warm and caring"
  },
  {
    id: "girlfriend",
    label: "Girlfriend",
    emoji: "💕",
    tier: "pro",
    tagline: "Sweet and affectionate"
  },
  {
    id: "didi",
    label: "Didi",
    emoji: "🌸",
    tier: "pro",
    tagline: "Caring elder sister"
  },
  {
    id: "coach",
    label: "Coach",
    emoji: "💪",
    tier: "pro",
    tagline: "Keeps you on track"
  },
  {
    id: "bhabi",
    label: "Bhabi",
    emoji: "🌺",
    tier: "pro",
    tagline: "Fun, teasing sister-in-law"
  }
];

export const DEFAULT_MOOD_ID: MoodId = "normal";

export function getMoodById(id: string): MoodConfig {
  const found = MOODS.find((m) => m.id === id);
  return found || MOODS[0];
}
