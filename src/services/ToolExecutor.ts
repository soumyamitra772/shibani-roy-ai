/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolCallPayload, Track } from "../types";
import { MusicControlCenter } from "./MusicControlCenter";

export interface ToolExecutionResult {
  success: boolean;
  message: string;
  output: any;
}

export class ToolExecutor {
  /**
   * Executes a client-side or server-proxy tool action requested by Gemini asynchronously.
   */
  static async execute(toolCall: ToolCallPayload): Promise<ToolExecutionResult> {
    const { name, args } = toolCall;
    console.log(`[ToolExecutor] Executing async: ${name}`, args);

    try {
      switch (name) {
        // --- WEB INTELLIGENCE & SEARCH TOOLS ---
        case "getWeather": {
          const location = args.location;
          if (!location) {
            throw new Error("Missing required 'location' parameter.");
          }
          const response = await fetch(`/api/tools/weather?location=${encodeURIComponent(location)}`);
          if (!response.ok) {
            throw new Error(`Failed to fetch weather for ${location}`);
          }
          const data = await response.json();
          if (!data.success) {
            throw new Error(data.error || "Weather api error");
          }
          
          let summary = "";
          if (data.current) {
            summary = `${location}: ${data.current.temp_C}°C (${data.current.condition}), Humidity: ${data.current.humidity}, Wind: ${data.current.wind_speed}`;
          } else {
            summary = data.summary || `Weather details loaded for ${location}.`;
          }

          return {
            success: true,
            message: `Fetched live weather for ${location}: ${summary}`,
            output: data
          };
        }

        case "getLatestNews": {
          const category = args.category || "general";
          const response = await fetch(`/api/tools/news?category=${encodeURIComponent(category)}`);
          if (!response.ok) {
            throw new Error(`Failed to fetch news category ${category}`);
          }
          const data = await response.json();
          if (!data.success) {
            throw new Error(data.error || "News api error");
          }

          const headlines = data.news.map((item: any) => `* ${item.title} (${item.source})`).join("\n");
          return {
            success: true,
            message: `Retrieved latest ${category} news:\n${headlines}`,
            output: data
          };
        }

        case "searchWeb": {
          const query = args.query;
          if (!query) {
            throw new Error("Missing required 'query' parameter.");
          }
          const response = await fetch(`/api/tools/search?query=${encodeURIComponent(query)}`);
          if (!response.ok) {
            throw new Error(`Search failed for query "${query}"`);
          }
          const data = await response.json();
          if (!data.success) {
            throw new Error(data.error || "Web search error");
          }

          const summary = data.results.map((r: any) => `* ${r.title}: ${r.snippet}`).join("\n");
          return {
            success: true,
            message: `Web search results for "${query}":\n${summary}`,
            output: data
          };
        }

        // --- MUSIC ASSISTANT TOOLS ---
        case "playMusic": {
          const trackName = args.trackName;
          if (!trackName) {
            throw new Error("Missing required 'trackName' parameter.");
          }
          const artistName = args.artistName || "";
          const query = `${trackName} ${artistName}`.trim();

          // Resolve music request to a playable YouTube stream via our backend resolver
          const response = await fetch(`/api/music/search?q=${encodeURIComponent(query)}`);
          if (!response.ok) {
            throw new Error(`Could not find track "${query}" on YouTube.`);
          }
          const track: Track = await response.json();

          // Push track to MusicControlCenter
          MusicControlCenter.play(track);

          return {
            success: true,
            message: `Playing "${track.title}" on the built-in media player!`,
            output: { success: true, track }
          };
        }

        case "pauseMusic": {
          MusicControlCenter.pause();
          return {
            success: true,
            message: "Paused music playback.",
            output: { success: true }
          };
        }

        case "resumeMusic": {
          MusicControlCenter.resume();
          return {
            success: true,
            message: "Resumed music playback.",
            output: { success: true }
          };
        }

        case "nextTrack": {
          MusicControlCenter.next();
          return {
            success: true,
            message: "Skipped to the next track.",
            output: { success: true }
          };
        }

        case "previousTrack": {
          MusicControlCenter.previous();
          return {
            success: true,
            message: "Went back to the previous track.",
            output: { success: true }
          };
        }

        case "setVolume": {
          const level = typeof args.level === "number" ? args.level : parseInt(args.level, 10);
          if (isNaN(level)) {
            throw new Error("Invalid volume level. Must be a number.");
          }
          MusicControlCenter.setVolume(level);
          return {
            success: true,
            message: `Volume adjusted to ${level}%.`,
            output: { success: true, level }
          };
        }

        case "setPlaybackState": {
          if (typeof args.shuffle === "boolean") {
            const state = MusicControlCenter.getState();
            if (state.isShuffle !== args.shuffle) {
              MusicControlCenter.toggleShuffle();
            }
          }
          if (typeof args.repeat === "boolean") {
            const state = MusicControlCenter.getState();
            if (state.isRepeat !== args.repeat) {
              MusicControlCenter.toggleRepeat();
            }
          }
          return {
            success: true,
            message: "Playback loop settings adjusted.",
            output: { success: true }
          };
        }

        // --- CONVENTIONAL UTILITY TOOLS ---
        case "openWebsite": {
          let url = args.url;
          if (!url) {
            throw new Error("Missing required 'url' parameter.");
          }
          if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
          }
          if (url.toLowerCase().trim().startsWith("javascript:")) {
            throw new Error("Insecure URL scheme rejected.");
          }
          const win = window.open(url, "_blank");
          if (win) {
            return {
              success: true,
              message: `Successfully opened website: ${url}`,
              output: { success: true, opened: true, url }
            };
          } else {
            return {
              success: false,
              message: `Could not open website: Popup was blocked. Please allow popups for this site.`,
              output: { success: false, error: "Popup blocked", url }
            };
          }
        }

        case "searchGoogle": {
          const query = args.query;
          if (!query) {
            throw new Error("Missing required 'query' parameter.");
          }
          const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          window.open(searchUrl, "_blank");
          return {
            success: true,
            message: `Searched Google for "${query}"`,
            output: { success: true, query }
          };
        }

        case "openYouTube": {
          const query = args.query;
          if (!query) {
            throw new Error("Missing required 'query' parameter.");
          }
          const youtubeUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
          window.open(youtubeUrl, "_blank");
          return {
            success: true,
            message: `Searched YouTube for "${query}"`,
            output: { success: true, query }
          };
        }

        case "openMaps": {
          const location = args.location;
          if (!location) {
            throw new Error("Missing required 'location' parameter.");
          }
          const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
          window.open(mapsUrl, "_blank");
          return {
            success: true,
            message: `Opened Google Maps for "${location}"`,
            output: { success: true, location }
          };
        }

        case "copyToClipboard": {
          const text = args.text;
          if (!text) {
            throw new Error("Missing required 'text' parameter.");
          }
          if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
          } else {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.opacity = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand("copy");
            document.body.removeChild(textArea);
          }
          const previewText = text.length > 40 ? text.substring(0, 40) + "..." : text;
          return {
            success: true,
            message: `Copied to clipboard: "${previewText}"`,
            output: { success: true }
          };
        }

        case "shareContent": {
          const text = args.text;
          if (!text) {
            throw new Error("Missing required 'text' parameter.");
          }
          if (navigator.share) {
            await navigator.share({ text });
            return {
              success: true,
              message: `Shared content successfully!`,
              output: { success: true, shared: true }
            };
          } else {
            if (navigator.clipboard) {
              await navigator.clipboard.writeText(text);
            }
            return {
              success: true,
              message: `Web Share not supported in this browser. Copied text to clipboard instead.`,
              output: { success: true, shared: false, copied: true }
            };
          }
        }

        case "getCurrentTime": {
          const timezone = args.timezone || "Asia/Kolkata";
          try {
            const now = new Date();
            // User local time formatting
            const localFormatter = new Intl.DateTimeFormat("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short"
            });

            // Kolkata time formatting
            const kolkataFormatter = new Intl.DateTimeFormat("en-US", {
              timeZone: "Asia/Kolkata",
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short"
            });

            // Requested timezone formatting
            let requestedFormatted = "";
            try {
              const reqFormatter = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZoneName: "short"
              });
              requestedFormatted = reqFormatter.format(now);
            } catch (tzErr) {
              requestedFormatted = "Invalid timezone specified";
            }

            const output = {
              success: true,
              localTime: localFormatter.format(now),
              kolkataTime: kolkataFormatter.format(now),
              requestedTimezone: timezone,
              requestedTime: requestedFormatted,
              timestamp: now.toISOString()
            };

            return {
              success: true,
              message: `Retrieved current time. Local: ${output.localTime}, Kolkata: ${output.kolkataTime}`,
              output: output
            };
          } catch (err: any) {
            throw new Error(`Failed to retrieve current time: ${err.message}`);
          }
        }

        default:
          return {
            success: false,
            message: `Unsupported function call: ${name}`,
            output: { error: `Function ${name} not supported` }
          };
      }
    } catch (error: any) {
      console.error(`[ToolExecutor] Error running ${name}:`, error);
      return {
        success: false,
        message: `Error executing ${name}: ${error.message || error}`,
        output: { error: error.message || String(error) }
      };
    }
  }
}
