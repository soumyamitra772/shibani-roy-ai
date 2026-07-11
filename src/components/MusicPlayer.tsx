import React, { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Play, 
  Pause, 
  SkipForward, 
  SkipBack, 
  Volume2, 
  VolumeX, 
  Shuffle, 
  Repeat, 
  Music, 
  ChevronUp, 
  ChevronDown, 
  ListMusic, 
  Radio,
  Search,
  CheckCircle2,
  AlertCircle,
  X
} from "lucide-react";
import { Track, PlaybackState } from "../types";
import { MusicControlCenter } from "../services/MusicControlCenter";

declare global {
  interface Window {
    onYouTubeIframeAPIReady: (() => void) | undefined;
    YT: any;
  }
}

export const MusicPlayer: React.FC = () => {
  const [state, setState] = useState<PlaybackState>(MusicControlCenter.getState());
  const [isOpen, setIsOpen] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [apiLoaded, setApiLoaded] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const ytPlayerRef = useRef<any>(null);
  const progressIntervalRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-reveal the player when a song is loaded/requested by user
  useEffect(() => {
    if (state.currentTrack) {
      setIsVisible(true);
      setIsOpen(true);
    }
  }, [state.currentTrack?.id]);

  const handleClosePlayer = () => {
    setIsVisible(false);
    MusicControlCenter.pause();
  };

  // Subscribe to playback state updates from MusicControlCenter
  useEffect(() => {
    const unsubscribe = MusicControlCenter.subscribe((updatedState) => {
      setState(updatedState);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Load YouTube Iframe API
  useEffect(() => {
    if (window.YT) {
      setApiLoaded(true);
      initializePlayer();
      return;
    }

    // Load the script tag
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    const firstScriptTag = document.getElementsByTagName("script")[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      setApiLoaded(true);
      initializePlayer();
    };

    return () => {
      window.onYouTubeIframeAPIReady = undefined;
    };
  }, []);

  // Track progress updates when playing
  useEffect(() => {
    if (state.isPlaying && ytPlayerRef.current) {
      progressIntervalRef.current = setInterval(() => {
        try {
          if (ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === "function") {
            const currentTime = Math.floor(ytPlayerRef.current.getCurrentTime());
            const duration = Math.floor(ytPlayerRef.current.getDuration()) || state.currentTrack?.duration || 180;
            
            MusicControlCenter.updateState({
              progress: currentTime,
              currentTrack: state.currentTrack ? {
                ...state.currentTrack,
                duration: duration
              } : null
            });
          }
        } catch (err) {
          console.error("Error reading youtube currentTime", err);
        }
      }, 1000);
    } else {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    }

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, [state.isPlaying, state.currentTrack]);

  // Hook up YouTube Player Instance commands to MusicControlCenter adapters
  const initializePlayer = () => {
    if (ytPlayerRef.current) return;

    try {
      const container = document.createElement("div");
      container.id = "youtube-iframe-holder";
      container.style.position = "absolute";
      container.style.width = "0px";
      container.style.height = "0px";
      container.style.pointerEvents = "none";
      container.style.opacity = "0";
      document.body.appendChild(container);

      ytPlayerRef.current = new window.YT.Player("youtube-iframe-holder", {
        height: "0",
        width: "0",
        videoId: "",
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            console.log("[YouTubePlayer] Player Engine Loaded & Ready");
            ytPlayerRef.current.setVolume(state.volume);
          },
          onStateChange: (event: any) => {
            // YT.PlayerState: -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 3 (buffering), 5 (video cued)
            if (event.data === 1) {
              MusicControlCenter.updateState({ isPlaying: true });
            } else if (event.data === 2) {
              MusicControlCenter.updateState({ isPlaying: false });
            } else if (event.data === 0) {
              MusicControlCenter.updateState({ isPlaying: false });
              // Track ended, skip next
              MusicControlCenter.next();
            }
          }
        }
      });

      // Register MusicControlCenter handlers
      MusicControlCenter.registerPlayer({
        play: (track: Track) => {
          if (ytPlayerRef.current && ytPlayerRef.current.loadVideoById) {
            ytPlayerRef.current.loadVideoById(track.videoId);
            ytPlayerRef.current.playVideo();
          }
          // Make sure player is open and visible
          setIsVisible(true);
          setIsOpen(true);
        },
        pause: () => {
          if (ytPlayerRef.current && ytPlayerRef.current.pauseVideo) {
            ytPlayerRef.current.pauseVideo();
          }
        },
        resume: () => {
          if (ytPlayerRef.current && ytPlayerRef.current.playVideo) {
            ytPlayerRef.current.playVideo();
          }
        },
        seek: (seconds: number) => {
          if (ytPlayerRef.current && ytPlayerRef.current.seekTo) {
            ytPlayerRef.current.seekTo(seconds, true);
            MusicControlCenter.updateState({ progress: seconds });
          }
        },
        setVolume: (level: number) => {
          if (ytPlayerRef.current && ytPlayerRef.current.setVolume) {
            ytPlayerRef.current.setVolume(level);
          }
        }
      });
    } catch (err) {
      console.error("Failed to construct YouTube Player iframe:", err);
    }
  };

  // Human friendly duration format (e.g., 3:45)
  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainingSecs = Math.floor(secs % 60);
    return `${mins}:${remainingSecs.toString().padStart(2, "0")}`;
  };

  // Handle progress bar seek clicking
  const handleProgressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const seconds = parseInt(e.target.value, 10);
    MusicControlCenter.seek(seconds);
  };

  // Perform a manual track search from the music player UI
  const handleManualSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setSearchError("");
    try {
      const res = await fetch(`/api/music/search?q=${encodeURIComponent(searchQuery)}`);
      if (!res.ok) {
        throw new Error("Could not find a match for that track.");
      }
      const track: Track = await res.json();
      
      // Auto queue and play
      MusicControlCenter.play(track);
      setSearchQuery("");
      setSearchError("");
    } catch (err: any) {
      setSearchError(err.message || "Failed to search.");
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <div id="shibani-floating-media-player" className="fixed bottom-6 right-6 z-40 max-w-[320px] w-full px-4 sm:px-0">
          <AnimatePresence mode="wait">
            {!isOpen ? (
              // Compact launcher bar
              <motion.button
                id="music-player-collapsed"
                key="collapsed"
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                onClick={() => setIsOpen(true)}
                className="flex items-center gap-3 bg-neutral-900/80 backdrop-blur-md border border-neutral-800 px-4 py-3 rounded-2xl shadow-xl hover:border-violet-500/50 transition-colors duration-300 w-full cursor-pointer text-left"
              >
                <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-violet-600 to-fuchsia-600 text-white shrink-0 shadow-lg">
                  {state.isPlaying ? (
                    <Radio className="w-5 h-5 animate-pulse" />
                  ) : (
                    <Music className="w-5 h-5" />
                  )}
                  {state.isPlaying && (
                    <span className="absolute -top-1 -right-1 flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                    </span>
                  )}
                </div>
                <div className="overflow-hidden grow">
                  <p className="text-[10px] text-neutral-400 font-medium font-sans">SHIBANI'S MUSIC</p>
                  <h4 className="text-xs text-neutral-100 font-medium truncate font-sans">
                    {state.currentTrack ? state.currentTrack.title : "No song playing"}
                  </h4>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <ChevronUp className="w-4 h-4 text-neutral-400" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClosePlayer();
                    }}
                    className="p-1 text-neutral-400 hover:text-rose-400 hover:bg-neutral-800 rounded-lg transition-colors cursor-pointer"
                    title="Remove player"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </motion.button>
            ) : (
              // Expanded visual deck (compact)
              <motion.div
                id="music-player-deck"
                key="expanded"
                ref={containerRef}
                initial={{ y: 50, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 50, opacity: 0 }}
                className="bg-neutral-950/90 backdrop-blur-xl border border-neutral-800 rounded-3xl overflow-hidden shadow-2xl shadow-neutral-950/50"
              >
                {/* Player header */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-900 bg-neutral-900/30">
                  <div className="flex items-center gap-2 text-violet-400">
                    <Music className="w-3.5 h-3.5 animate-bounce" />
                    <span className="text-[10px] font-semibold font-sans uppercase tracking-widest text-neutral-300">Playback</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button 
                      id="btn-toggle-queue"
                      onClick={() => setShowQueue(!showQueue)}
                      className={`p-1.5 rounded-lg transition-colors cursor-pointer ${showQueue ? "bg-violet-600/20 text-violet-400" : "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900"}`}
                      title="Show queue"
                    >
                      <ListMusic className="w-4 h-4" />
                    </button>
                    <button 
                      id="btn-collapse-player"
                      onClick={() => setIsOpen(false)}
                      className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 rounded-lg transition-colors cursor-pointer"
                      title="Collapse player"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button 
                      id="btn-close-player"
                      onClick={() => handleClosePlayer()}
                      className="p-1.5 text-neutral-400 hover:text-rose-400 hover:bg-neutral-900 rounded-lg transition-colors cursor-pointer"
                      title="Remove player"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Main playback panel */}
                <div className="p-4 flex flex-col">
                  {/* Top Row: Album Art + Meta & Volume controls */}
                  <div className="flex gap-3 items-center mb-3">
                    {/* Album Art (compact w-16 h-16) */}
                    <div className="relative w-16 h-16 rounded-xl overflow-hidden shadow-md border border-neutral-800 bg-neutral-900 shrink-0">
                      {state.currentTrack?.artwork ? (
                        <img 
                          src={state.currentTrack.artwork} 
                          alt={state.currentTrack.title}
                          className={`w-full h-full object-cover transition-transform duration-700 ${state.isPlaying ? "scale-105" : "scale-100"}`}
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-tr from-violet-950/50 to-fuchsia-950/50 text-neutral-500">
                          <Music className="w-8 h-8 text-neutral-600" />
                        </div>
                      )}

                      {/* Animated Equalizer Wave Overlay */}
                      {state.isPlaying && (
                        <div className="absolute inset-0 bg-neutral-950/40 backdrop-blur-[1px] flex items-end justify-center gap-1 pb-2 px-2">
                          <span className="w-0.5 bg-violet-400 rounded-full animate-[bounce_0.8s_infinite_0s]" style={{ height: "40%" }}></span>
                          <span className="w-0.5 bg-violet-400 rounded-full animate-[bounce_0.8s_infinite_0.15s]" style={{ height: "70%" }}></span>
                          <span className="w-0.5 bg-fuchsia-400 rounded-full animate-[bounce_0.8s_infinite_0.3s]" style={{ height: "90%" }}></span>
                          <span className="w-0.5 bg-pink-400 rounded-full animate-[bounce_0.8s_infinite_0.1s]" style={{ height: "60%" }}></span>
                        </div>
                      )}
                    </div>

                    {/* Meta details & Volume Slider stacked */}
                    <div className="overflow-hidden grow flex flex-col justify-between h-16 py-0.5">
                      <div className="w-full">
                        <h3 className="text-xs font-semibold text-neutral-100 truncate font-sans">
                          {state.currentTrack ? state.currentTrack.title : "No Song Selected"}
                        </h3>
                        <p className="text-[10px] text-neutral-400 truncate font-sans">
                          {state.currentTrack ? state.currentTrack.artist : "Ask Shibani to play music! 😏"}
                        </p>
                      </div>

                      {/* Compact volume control */}
                      <div className="flex items-center gap-1.5 w-full bg-neutral-900/30 px-2 py-1 rounded-lg border border-neutral-900/50">
                        <button
                          id="btn-toggle-mute"
                          onClick={() => MusicControlCenter.toggleMute()}
                          className="text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer shrink-0"
                        >
                          {state.isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                        </button>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={state.isMuted ? 0 : state.volume}
                          onChange={(e) => MusicControlCenter.setVolume(parseInt(e.target.value, 10))}
                          className="grow h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-violet-500 hover:accent-violet-400 outline-none"
                        />
                        <span className="text-[9px] font-mono text-neutral-500 w-5 text-right shrink-0">
                          {state.isMuted ? 0 : state.volume}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Progress Slider Bar */}
                  <div className="w-full flex flex-col gap-0.5 mb-2.5">
                    <input 
                      type="range"
                      min="0"
                      max={state.currentTrack?.duration || 210}
                      value={state.progress}
                      onChange={handleProgressChange}
                      className="w-full h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-violet-500 hover:accent-violet-400 transition-all outline-none"
                    />
                    <div className="flex justify-between text-[9px] text-neutral-500 font-mono font-medium">
                      <span>{formatTime(state.progress)}</span>
                      <span>{formatTime(state.currentTrack?.duration || 210)}</span>
                    </div>
                  </div>

                  {/* Playback action deck */}
                  <div className="flex items-center justify-between w-full px-1">
                    <button
                      id="btn-toggle-shuffle"
                      onClick={() => MusicControlCenter.toggleShuffle()}
                      className={`p-1.5 rounded-full transition-all cursor-pointer ${state.isShuffle ? "text-violet-400 bg-violet-600/10 scale-105" : "text-neutral-500 hover:text-neutral-200"}`}
                      title="Shuffle"
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>

                    <div className="flex items-center gap-2">
                      <button
                        id="btn-prev-track"
                        onClick={() => MusicControlCenter.previous()}
                        disabled={state.playlist.length <= 1}
                        className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 rounded-full transition-all cursor-pointer disabled:opacity-30 disabled:hover:bg-transparent"
                        title="Previous Song"
                      >
                        <SkipBack className="w-4 h-4 fill-current" />
                      </button>

                      <button
                        id="btn-play-pause"
                        onClick={() => state.isPlaying ? MusicControlCenter.pause() : MusicControlCenter.resume()}
                        className="p-2.5 rounded-full bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-600/30 active:scale-95 transition-all cursor-pointer"
                        title={state.isPlaying ? "Pause" : "Play"}
                      >
                        {state.isPlaying ? (
                          <Pause className="w-4 h-4 fill-current" />
                        ) : (
                          <Play className="w-4 h-4 fill-current translate-x-0.5" />
                        )}
                      </button>

                      <button
                        id="btn-next-track"
                        onClick={() => MusicControlCenter.next()}
                        disabled={state.playlist.length <= 1}
                        className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 rounded-full transition-all cursor-pointer disabled:opacity-30 disabled:hover:bg-transparent"
                        title="Next Song"
                      >
                        <SkipForward className="w-4 h-4 fill-current" />
                      </button>
                    </div>

                    <button
                      id="btn-toggle-repeat"
                      onClick={() => MusicControlCenter.toggleRepeat()}
                      className={`p-1.5 rounded-full transition-all cursor-pointer ${state.isRepeat ? "text-violet-400 bg-violet-600/10 scale-105" : "text-neutral-500 hover:text-neutral-200"}`}
                      title="Repeat Track"
                    >
                      <Repeat className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Queue & Search drawer panel */}
                <AnimatePresence>
                  {showQueue && (
                    <motion.div
                      id="music-player-queue"
                      initial={{ height: 0 }}
                      animate={{ height: "auto" }}
                      exit={{ height: 0 }}
                      className="border-t border-neutral-900 overflow-hidden bg-neutral-950"
                    >
                      <div className="p-4 border-b border-neutral-900">
                        <form onSubmit={handleManualSearch} className="flex gap-2">
                          <div className="relative grow">
                            <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2" />
                            <input 
                              type="text"
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              placeholder="Search track..."
                              className="w-full bg-neutral-900 border border-neutral-800 rounded-xl py-2 pl-9 pr-4 text-xs text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-violet-500"
                            />
                          </div>
                          <button 
                            type="submit"
                            disabled={isSearching}
                            className="bg-violet-600 hover:bg-violet-500 text-white rounded-xl px-3 py-2 text-xs font-semibold shrink-0 disabled:opacity-50 flex items-center justify-center cursor-pointer min-w-16"
                          >
                            {isSearching ? "..." : "Play"}
                          </button>
                        </form>

                        {searchError && (
                          <div className="mt-2 text-[10px] text-rose-400 flex items-center gap-1.5 font-sans">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>{searchError}</span>
                          </div>
                        )}
                      </div>

                      <div className="max-h-[180px] overflow-y-auto divide-y divide-neutral-900">
                        <div className="px-4 py-2 bg-neutral-900/20 flex justify-between items-center">
                          <span className="text-[10px] font-semibold text-neutral-400 tracking-wider font-sans uppercase">Queue Playlist</span>
                          <span className="text-[10px] font-mono text-neutral-500">{state.playlist.length} track(s)</span>
                        </div>

                        {state.playlist.length === 0 ? (
                          <div className="p-6 text-center text-xs text-neutral-600 font-sans">
                            No songs queued. Ask Shibani to play!
                          </div>
                        ) : (
                          state.playlist.map((track, idx) => (
                            <button
                              key={track.id + "-" + idx}
                              onClick={() => MusicControlCenter.play(track)}
                              className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-900 transition-colors duration-200 cursor-pointer text-left ${state.currentIndex === idx ? "bg-violet-950/20" : ""}`}
                            >
                              <div className="w-8 h-8 rounded bg-neutral-800 overflow-hidden relative shrink-0">
                                {track.artwork ? (
                                  <img src={track.artwork} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center bg-violet-900/10 text-violet-400">
                                    <Music className="w-4 h-4" />
                                  </div>
                                )}
                                {state.currentIndex === idx && state.isPlaying && (
                                  <div className="absolute inset-0 bg-neutral-950/60 flex items-center justify-center">
                                    <div className="flex gap-0.5 items-end h-3">
                                      <span className="w-0.5 bg-violet-400 rounded-full animate-[bounce_0.6s_infinite_0s]" style={{ height: "40%" }}></span>
                                      <span className="w-0.5 bg-violet-400 rounded-full animate-[bounce_0.6s_infinite_0.1s]" style={{ height: "80%" }}></span>
                                      <span className="w-0.5 bg-violet-400 rounded-full animate-[bounce_0.6s_infinite_0.2s]" style={{ height: "50%" }}></span>
                                    </div>
                                  </div>
                                )}
                              </div>
                              <div className="overflow-hidden grow">
                                <h4 className={`text-xs font-semibold truncate ${state.currentIndex === idx ? "text-violet-400" : "text-neutral-200"}`}>
                                  {track.title}
                                </h4>
                                <p className="text-[10px] text-neutral-500 truncate">{track.artist}</p>
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </AnimatePresence>
  );
};
