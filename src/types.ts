/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type AssistantState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  isToolCall?: boolean;
  toolName?: string;
}

export type InteractionMode = "voice" | "chat";

export interface ToolCallPayload {
  id: string;
  name: string;
  args: any;
}

export interface WebSocketEvent {
  type: "connected" | "disconnected" | "audio" | "interrupted" | "toolCall" | "error";
  data?: string;
  message?: string;
  toolCall?: ToolCallPayload;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  duration: number; // in seconds
  videoId?: string; // YouTube video ID
  spotifyUri?: string; // Spotify URI
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTrack: Track | null;
  progress: number; // in seconds
  volume: number; // 0 to 100
  isMuted: boolean;
  isShuffle: boolean;
  isRepeat: boolean;
  playlist: Track[];
  currentIndex: number;
  provider: "youtube" | "spotify";
}
