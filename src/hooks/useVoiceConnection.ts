/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Includes Bluetooth microphone selection & built-in mic auto-detection for Android.
 * Integrates telecom call lifecycle: ringback tone, minimum ring time, call timer support,
 * and telecom operator voice message on call failures.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { AssistantState, ToolCallPayload } from "../types";
import { float32ToPcm16Base64, pcm16Base64ToFloat32 } from "../utils/audioUtils";
import { ToolExecutor } from "../services/ToolExecutor";
import { getAuthenticatedToken } from "../utils/userId";
import {
  startRingback,
  stopRingback,
  playPickupBlip,
  playHangupTone,
  playDroppedTone,
  playOperatorTones,
  speakOperatorMessage,
  playWarningChime,
  speakGoodbyeMessage,
  stopAllCallSounds,
  getSoundAudioContext,
} from "../utils/callSounds";

export type CallPhase = "idle" | "ringing" | "active" | "ended" | "failed";
export type FailureReason = "mic" | "limit" | "timeout" | "server" | null;

interface UseVoiceConnectionProps {
  onToolCallExecuted?: (message: string) => void;
  onAssistantSpokeText?: (text: string) => void;
  onToolCallExecuting?: (name: string, args: any) => void;
  onToolCallCompleted?: (name: string, result: any) => void;
  onVoiceError?: (errorMessage: string) => void;
  selectedMicId?: string;
}

export function useVoiceConnection({
  onToolCallExecuted,
  onAssistantSpokeText,
  onToolCallExecuting,
  onToolCallCompleted,
  onVoiceError,
  selectedMicId,
}: UseVoiceConnectionProps = {}) {
  const [state, setState] = useState<AssistantState>("disconnected");
  const [callPhase, setCallPhase] = useState<CallPhase>("idle");
  const [failureReason, setFailureReason] = useState<FailureReason>(null);
  const [isCallDropped, setIsCallDropped] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState(false);

  // Second-based voice metering & limit states
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [limitSeconds, setLimitSeconds] = useState<number | null>(null);
  const [is1MinWarningActive, setIs1MinWarningActive] = useState(false);
  const [isSilenceHangup, setIsSilenceHangup] = useState(false);
  const [isQuotaHangup, setIsQuotaHangup] = useState(false);

  const remainingSecondsRef = useRef<number | null>(null);
  const lastAudioActivityRef = useRef<number>(Date.now());
  const hasWarned1MinRef = useRef<boolean>(false);
  const hasHandledLimitRef = useRef<boolean>(false);
  const hasHandledSilenceRef = useRef<boolean>(false);
  const isDisconnectingGracefullyRef = useRef<boolean>(false);
  const isQuotaHangupRef = useRef<boolean>(false);
  const isSilenceHangupRef = useRef<boolean>(false);

  const callPhaseRef = useRef<CallPhase>(callPhase);
  const updateCallPhase = useCallback((phase: CallPhase) => {
    callPhaseRef.current = phase;
    setCallPhase(phase);
  }, []);

  const volumesRef = useRef({ mic: 0, speaker: 0 });

  // Call lifecycle refs
  const wasEverActiveRef = useRef<boolean>(false);
  const callStartTimeRef = useRef<number>(0);
  const connectingTimeoutRef = useRef<any>(null);
  const minRingTimeoutRef = useRef<any>(null);
  const endedPhaseTimerRef = useRef<any>(null);
  const hasHandledFailureRef = useRef<boolean>(false);

  // Connection-specific refs
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Input Audio Pipeline refs
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const inputProcessorRef = useRef<ScriptProcessorNode | null>(null);

  // Output Audio Pipeline refs
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputGainNodeRef = useRef<GainNode | null>(null);
  const outputAudioRef = useRef<HTMLAudioElement | null>(null);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartTimeRef = useRef<number>(0);

  // Screen Wake Lock API reference
  const wakeLockRef = useRef<any | null>(null);

  // Animation Frame references
  const volumePollIdRef = useRef<number | null>(null);

  // Helper ref to avoid closure staleness
  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  /**
   * Request Screen Wake Lock to prevent mobile devices from sleeping
   */
  const requestWakeLock = useCallback(async () => {
    if ("wakeLock" in navigator) {
      try {
        if (!wakeLockRef.current) {
          const sentinel = await navigator.wakeLock.request("screen");
          sentinel.addEventListener("release", () => {
            console.log("[AudioEngine] Screen Wake Lock sentinel was released");
            if (wakeLockRef.current === sentinel) {
              wakeLockRef.current = null;
            }
          });
          wakeLockRef.current = sentinel;
          console.log("[AudioEngine] Screen Wake Lock acquired successfully");
        }
      } catch (err) {
        console.warn("[AudioEngine] Failed to acquire Screen Wake Lock:", err);
      }
    }
  }, []);

  /**
   * Release Screen Wake Lock
   */
  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        console.log("[AudioEngine] Screen Wake Lock released successfully");
      } catch (err) {
        console.error("[AudioEngine] Error releasing Screen Wake Lock:", err);
      }
      wakeLockRef.current = null;
    }
  }, []);

  // Handle visibility change to re-request Wake Lock if connection is active
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (
        document.visibilityState === "visible" &&
        state !== "disconnected" &&
        state !== "error"
      ) {
        console.log("[AudioEngine] Tab became visible, re-requesting Screen Wake Lock...");
        await requestWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [state, requestWakeLock]);

  /**
   * Stop all active and scheduled speech chunks instantly (Interruption Handling)
   */
  const stopPlayback = useCallback(() => {
    console.log("[AudioEngine] Stopping playback and clearing queue");
    scheduledSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        // Source may already be stopped/inactive
      }
    });
    scheduledSourcesRef.current = [];
    nextStartTimeRef.current = 0;
    volumesRef.current.speaker = 0;
  }, []);

  /**
   * Internal low-level audio & websocket cleanup without mutating callPhase
   */
  const internalDisconnect = useCallback(() => {
    console.log("[AudioEngine] Internal cleanup...");

    // Release Screen Wake Lock
    releaseWakeLock();

    // Cancel animation frame polling
    if (volumePollIdRef.current) {
      cancelAnimationFrame(volumePollIdRef.current);
      volumePollIdRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }

    // Stop and clear playback
    stopPlayback();

    // Clean up standard audio element
    if (outputAudioRef.current) {
      try {
        outputAudioRef.current.pause();
        outputAudioRef.current.srcObject = null;
        outputAudioRef.current.remove();
      } catch (e) {}
      outputAudioRef.current = null;
    }

    // Clean up microphone stream track
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Clean up input pipeline
    if (inputProcessorRef.current) {
      inputProcessorRef.current.disconnect();
      inputProcessorRef.current = null;
    }
    if (inputAnalyserRef.current) {
      inputAnalyserRef.current.disconnect();
      inputAnalyserRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      try {
        inputAudioCtxRef.current.close();
      } catch (e) {}
      inputAudioCtxRef.current = null;
    }

    // Clean up output pipeline
    if (outputAnalyserRef.current) {
      outputAnalyserRef.current.disconnect();
      outputAnalyserRef.current = null;
    }
    if (outputGainNodeRef.current) {
      outputGainNodeRef.current.disconnect();
      outputGainNodeRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      try {
        outputAudioCtxRef.current.close();
      } catch (e) {}
      outputAudioCtxRef.current = null;
    }

    volumesRef.current.mic = 0;
    volumesRef.current.speaker = 0;
  }, [stopPlayback, releaseWakeLock]);

  /**
   * Handles call failure before reaching "active" phase:
   * Sets failure reason, stops ringback, plays operator tones, and speaks operator message.
   */
  const failCall = useCallback((reason: FailureReason) => {
    if (hasHandledFailureRef.current) return;
    hasHandledFailureRef.current = true;

    if (connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = null;
    }
    if (minRingTimeoutRef.current) {
      clearTimeout(minRingTimeoutRef.current);
      minRingTimeoutRef.current = null;
    }

    stopRingback();
    setFailureReason(reason);
    updateCallPhase("failed");
    setState("error");

    internalDisconnect();

    if (reason) {
      playOperatorTones().then(() => {
        speakOperatorMessage(reason);
      });
    }
  }, [internalDisconnect, updateCallPhase]);

  /**
   * Close and clean up all connections, contexts, and audio nodes.
   * If isUserHangup is true, plays single hangup tone.
   * If dropped unexpectedly after active, plays two-tone drop sound.
   */
  const disconnect = useCallback((isUserHangup: boolean = false) => {
    console.log("[AudioEngine] Initiating disconnect... isUserHangup:", isUserHangup);

    if (connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = null;
    }
    if (minRingTimeoutRef.current) {
      clearTimeout(minRingTimeoutRef.current);
      minRingTimeoutRef.current = null;
    }

    stopRingback();

    if (callPhaseRef.current === "ringing" && isUserHangup) {
      // User cancelled call while it was ringing
      playHangupTone();
      updateCallPhase("idle");
      setState("disconnected");
    } else if (wasEverActiveRef.current) {
      wasEverActiveRef.current = false;
      const isPoliteEnd = isUserHangup || isQuotaHangupRef.current || isSilenceHangupRef.current;
      if (isPoliteEnd) {
        playHangupTone();
        setIsCallDropped(false);
      } else {
        playDroppedTone();
        setIsCallDropped(true);
      }
      updateCallPhase("ended");
      setState("disconnected");

      if (endedPhaseTimerRef.current) clearTimeout(endedPhaseTimerRef.current);
      endedPhaseTimerRef.current = setTimeout(() => {
        updateCallPhase("idle");
        setIsCallDropped(false);
        setIsQuotaHangup(false);
        setIsSilenceHangup(false);
        isQuotaHangupRef.current = false;
        isSilenceHangupRef.current = false;
      }, 4000);
    } else if (callPhaseRef.current !== "failed") {
      updateCallPhase("idle");
      setState("disconnected");
    } else {
      setState("disconnected");
    }

    internalDisconnect();
  }, [internalDisconnect, updateCallPhase]);

  /**
   * Graceful spoken goodbye when daily limit is reached during call
   */
  const triggerGracefulLimitEnd = useCallback(() => {
    if (isDisconnectingGracefullyRef.current) return;
    isDisconnectingGracefullyRef.current = true;
    isQuotaHangupRef.current = true;
    setIsQuotaHangup(true);

    isMutedRef.current = true;
    setIsMuted(true);

    speakGoodbyeMessage("limit").then(() => {
      disconnect(false);
      isDisconnectingGracefullyRef.current = false;
    });
  }, [disconnect]);

  /**
   * Graceful spoken goodbye when call is inactive for about 1 minute
   */
  const triggerGracefulSilenceEnd = useCallback(() => {
    if (isDisconnectingGracefullyRef.current || hasHandledSilenceRef.current) return;
    hasHandledSilenceRef.current = true;
    isDisconnectingGracefullyRef.current = true;
    isSilenceHangupRef.current = true;
    setIsSilenceHangup(true);

    isMutedRef.current = true;
    setIsMuted(true);

    speakGoodbyeMessage("silence").then(() => {
      disconnect(false);
      isDisconnectingGracefullyRef.current = false;
    });
  }, [disconnect]);

  // Fetch initial quota on mount
  const fetchVoiceQuota = useCallback(async () => {
    try {
      const token = getAuthenticatedToken();
      if (!token) return;
      const res = await fetch("/api/voice-quota", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.remainingSeconds === "number") {
          setRemainingSeconds(data.remainingSeconds);
          remainingSecondsRef.current = data.remainingSeconds;
        }
        if (typeof data.limitSeconds === "number") {
          setLimitSeconds(data.limitSeconds);
        }
      }
    } catch (e) {
      console.warn("[Voice] Error fetching voice quota:", e);
    }
  }, []);

  useEffect(() => {
    fetchVoiceQuota();
  }, [fetchVoiceQuota]);

  // Active call countdown timer & 1-minute warning trigger
  useEffect(() => {
    let interval: any = null;
    if (callPhase === "active") {
      interval = setInterval(() => {
        if (isDisconnectingGracefullyRef.current) return;
        setRemainingSeconds((prev) => {
          if (prev === null) return null;
          const next = Math.max(0, prev - 1);
          remainingSecondsRef.current = next;

          if (next === 60 && !hasWarned1MinRef.current) {
            hasWarned1MinRef.current = true;
            playWarningChime();
            setIs1MinWarningActive(true);
            setTimeout(() => setIs1MinWarningActive(false), 5000);
          }

          if (next === 0 && !hasHandledLimitRef.current) {
            hasHandledLimitRef.current = true;
            triggerGracefulLimitEnd();
          }

          return next;
        });
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [callPhase, triggerGracefulLimitEnd]);

  /**
   * Schedules a base64 PCM chunk for gapless synchronized playback
   */
  const playAudioChunk = useCallback((base64Data: string) => {
    if (!outputAudioCtxRef.current || !outputAnalyserRef.current) return;

    const ctx = outputAudioCtxRef.current;

    // Decode PCM Base64 to Float32Array
    const float32Data = pcm16Base64ToFloat32(base64Data);

    // Create Audio Buffer (Sample rate is always 24000Hz for Gemini Live output)
    const audioBuffer = ctx.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    // Create Source Node
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    // Route: source -> analyser -> master gain -> speaker destination
    source.connect(outputAnalyserRef.current);

    // Schedule playback precisely
    const now = ctx.currentTime;
    let startTime = nextStartTimeRef.current;

    if (startTime < now) {
      // Add a tiny scheduling buffer (100ms) to counteract network jitter on initial load
      startTime = now + 0.1;
    }

    source.start(startTime);
    nextStartTimeRef.current = startTime + audioBuffer.duration;

    // Save node reference for instant stoppage during interruptions
    scheduledSourcesRef.current.push(source);

    // Prune stale/completed nodes from the scheduled reference list
    source.onended = () => {
      scheduledSourcesRef.current = scheduledSourcesRef.current.filter((s) => s !== source);
    };

    setState("speaking");
  }, []);

  /**
   * Establishes full-duplex WebSocket connection to our Express Live WS gateway
   */
  const connect = useCallback(async () => {
    // Resume sound audio context during user click gesture
    getSoundAudioContext();

    // Reset failure and call duration states
    if (endedPhaseTimerRef.current) {
      clearTimeout(endedPhaseTimerRef.current);
      endedPhaseTimerRef.current = null;
    }
    if (connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = null;
    }
    if (minRingTimeoutRef.current) {
      clearTimeout(minRingTimeoutRef.current);
      minRingTimeoutRef.current = null;
    }

    hasHandledFailureRef.current = false;
    wasEverActiveRef.current = false;
    hasWarned1MinRef.current = false;
    hasHandledLimitRef.current = false;
    hasHandledSilenceRef.current = false;
    isDisconnectingGracefullyRef.current = false;
    isQuotaHangupRef.current = false;
    isSilenceHangupRef.current = false;
    lastAudioActivityRef.current = Date.now();
    setFailureReason(null);
    setIsCallDropped(false);
    setIsSilenceHangup(false);
    setIsQuotaHangup(false);
    setIs1MinWarningActive(false);

    // Stop all background call sounds or active operator speech
    stopAllCallSounds();

    // Clean up internal connections cleanly before starting new call
    internalDisconnect();

    setState("connecting");
    updateCallPhase("ringing");

    // Start ringback tone immediately
    startRingback();
    callStartTimeRef.current = Date.now();

    // Treat a connection staying in connecting for more than 15s as timeout failure
    connectingTimeoutRef.current = setTimeout(() => {
      console.warn("[AudioEngine] Connection timed out after 15s");
      failCall("timeout");
    }, 15000);

    try {
      // Request Screen Wake Lock on connect
      await requestWakeLock();

      // Initialize output AudioContext (24kHz) for speaker output
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
      });
      if (outCtx.state === "suspended") {
        await outCtx.resume();
      }
      outputAudioCtxRef.current = outCtx;

      const outAnalyser = outCtx.createAnalyser();
      outAnalyser.fftSize = 256;
      outputAnalyserRef.current = outAnalyser;

      const outGain = outCtx.createGain();
      outGain.gain.setValueAtTime(1.0, outCtx.currentTime);
      outputGainNodeRef.current = outGain;

      outAnalyser.connect(outGain);

      // Create a standard HTML <audio> element, append to the DOM, and route output stream through it for Bluetooth device routing support
      const dest = outCtx.createMediaStreamDestination();
      outGain.connect(dest);
 
      const audioEl = document.createElement("audio");
      audioEl.id = "voice-audio-output";
      audioEl.autoplay = true;
      audioEl.style.position = "absolute";
      audioEl.style.width = "0px";
      audioEl.style.height = "0px";
      audioEl.style.pointerEvents = "none";
      audioEl.style.opacity = "0";
      
      document.body.appendChild(audioEl);
      audioEl.srcObject = dest.stream;
      outputAudioRef.current = audioEl;

      if (typeof (audioEl as any).setSinkId === 'function') {
        try {
          await (audioEl as any).setSinkId('default');
          console.log('[AudioEngine] setSinkId set to default successfully');
        } catch (err) {
          console.warn('[AudioEngine] setSinkId failed:', err);
        }
      }

      navigator.mediaDevices.addEventListener('devicechange', async () => {
        if (outputAudioRef.current && typeof (outputAudioRef.current as any).setSinkId === 'function') {
          try {
            await (outputAudioRef.current as any).setSinkId('default');
            console.log('[AudioEngine] Re-synced sinkId after device change');
          } catch (err) {
            console.warn('[AudioEngine] Could not re-sync sinkId:', err);
          }
        }
      });

      audioEl.play().catch((err) => {
        console.warn("[AudioEngine] Error playing programmatic HTML5 audio element:", err);
      });

      let resolvedMicId: string | undefined = undefined;

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === "audioinput");
        console.log("[AudioEngine] Available mic devices:", audioInputs.map(d => `${d.label} (${d.deviceId})`));

        const builtInMic = audioInputs.find(d => {
          const label = d.label.toLowerCase();
          return !label.includes("bluetooth") &&
                 !label.includes("headset") &&
                 !label.includes("handsfree") &&
                 !label.includes("hfp") &&
                 !label.includes("sco") &&
                 (label.includes("built-in") || label.includes("default") || label.includes("internal") || d.deviceId === "default");
        });

        if (builtInMic) {
          resolvedMicId = builtInMic.deviceId;
          console.log("[AudioEngine] Auto-selected built-in mic:", builtInMic.label);
        } else {
          console.warn("[AudioEngine] Could not auto-detect built-in mic, falling back to system default");
        }
      } catch (err) {
        console.warn("[AudioEngine] Device enumeration failed, using system default mic:", err);
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedMicId ? { exact: selectedMicId } : resolvedMicId ? { exact: resolvedMicId } : { ideal: "default" },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // Initialize input AudioContext (16kHz) for microphone capturing
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });
      if (inCtx.state === "suspended") {
        await inCtx.resume();
      }
      inputAudioCtxRef.current = inCtx;

      const inSource = inCtx.createMediaStreamSource(stream);

      const inAnalyser = inCtx.createAnalyser();
      inAnalyser.fftSize = 256;
      inputAnalyserRef.current = inAnalyser;

      // ScriptProcessorNode for chunk processing (buffer size 4096 = ~250ms chunks)
      const inProcessor = inCtx.createScriptProcessor(4096, 1, 1);
      inputProcessorRef.current = inProcessor;

      inSource.connect(inAnalyser);
      inAnalyser.connect(inProcessor);
      inProcessor.connect(inCtx.destination); // Required for process event loop

      // Build WebSocket URL
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const token = getAuthenticatedToken() || "";
      const wsUrl = `${protocol}//${window.location.host}/api/live-ws`;

      console.log(`[AudioEngine] Connecting WebSocket: ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[AudioEngine] WebSocket opened, sending auth token");
        ws.send(JSON.stringify({ type: "auth", token: token }));
      };

      // Configure microphone chunk dispatch
      inProcessor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        
        // If muted, do not send voice packets to Gemini
        if (isMutedRef.current) return;

        const float32Array = e.inputBuffer.getChannelData(0);
        const base64Pcm = float32ToPcm16Base64(float32Array);

        ws.send(
          JSON.stringify({
            type: "audio",
            data: base64Pcm,
          })
        );

        setState((current) => {
          if (current === "connected" || current === "listening") {
            return "listening";
          }
          return current;
        });
      };

      // Handle websocket events
      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case "connected": {
              console.log("[AudioEngine] Voice connection active from server");
              if (connectingTimeoutRef.current) {
                clearTimeout(connectingTimeoutRef.current);
                connectingTimeoutRef.current = null;
              }

              if (typeof msg.remainingSeconds === "number") {
                setRemainingSeconds(msg.remainingSeconds);
                remainingSecondsRef.current = msg.remainingSeconds;
              }
              if (typeof msg.limitSeconds === "number") {
                setLimitSeconds(msg.limitSeconds);
              }

              // Enforce MINIMUM ring time of about 1.6s so users hear at least one full ring
              const elapsedRing = Date.now() - callStartTimeRef.current;
              const remainingRing = Math.max(0, 1600 - elapsedRing);

              if (minRingTimeoutRef.current) clearTimeout(minRingTimeoutRef.current);
              minRingTimeoutRef.current = setTimeout(() => {
                if (!hasHandledFailureRef.current) {
                  wasEverActiveRef.current = true;
                  lastAudioActivityRef.current = Date.now();
                  setState("connected");
                  updateCallPhase("active");
                  stopRingback();
                  playPickupBlip();
                }
              }, remainingRing);
              break;
            }

            case "warning":
              if (msg.warning === "1_MINUTE_REMAINING" && !hasWarned1MinRef.current) {
                hasWarned1MinRef.current = true;
                playWarningChime();
                setIs1MinWarningActive(true);
                setTimeout(() => setIs1MinWarningActive(false), 5000);
              }
              break;

            case "limit_reached":
              if (!hasHandledLimitRef.current) {
                hasHandledLimitRef.current = true;
                triggerGracefulLimitEnd();
              }
              break;

            case "audio":
              if (msg.data) {
                playAudioChunk(msg.data);
              }
              break;

            case "interrupted":
              console.log("[AudioEngine] Received interruption signal from Gemini");
              stopPlayback();
              setState("interrupted");
              setTimeout(() => {
                setState((prev) => (prev === "interrupted" ? "connected" : prev));
              }, 400);
              break;

            case "toolCall":
              if (msg.toolCall) {
                const call = msg.toolCall as ToolCallPayload;
                
                if (onToolCallExecuting) {
                  onToolCallExecuting(call.name, call.args);
                }

                const result = await ToolExecutor.execute(call);

                if (onToolCallCompleted) {
                  onToolCallCompleted(call.name, result);
                }
                
                if (onToolCallExecuted) {
                  onToolCallExecuted(result.message);
                }

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "toolResponse",
                      toolResponse: {
                        id: call.id,
                        name: call.name,
                        response: result.output,
                      },
                    })
                  );
                }
              }
              break;

            case "disconnected":
              console.log("[AudioEngine] Server disconnected Gemini API session");
              disconnect(false);
              break;

            case "error":
              console.error("[AudioEngine] Server error:", msg.message);
              if (onVoiceError) {
                onVoiceError(msg.message);
              }
              if (!wasEverActiveRef.current) {
                if (msg.message === "VOICE_LIMIT_REACHED") {
                  failCall("limit");
                } else {
                  failCall("server");
                }
              } else {
                disconnect(false);
              }
              break;
          }
        } catch (err) {
          console.error("[AudioEngine] Error parsing socket payload:", err);
        }
      };

      ws.onclose = () => {
        console.log("[AudioEngine] WebSocket connection closed");
        if (!wasEverActiveRef.current && callPhaseRef.current === "ringing") {
          failCall("server");
        } else {
          disconnect(false);
        }
      };

      ws.onerror = (e) => {
        console.error("[AudioEngine] WebSocket experienced an error:", e);
        if (!wasEverActiveRef.current && callPhaseRef.current === "ringing") {
          failCall("server");
        } else {
          disconnect(false);
        }
      };

      // Poll volumes continuously for visualization
      const pollVolume = () => {
        // Read Input volume
        if (inputAnalyserRef.current && !isMutedRef.current) {
          const bufferLength = inputAnalyserRef.current.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          inputAnalyserRef.current.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const average = sum / bufferLength / 255;
          volumesRef.current.mic = average;
        } else {
          volumesRef.current.mic = 0;
        }

        // Read Output volume
        if (outputAnalyserRef.current && scheduledSourcesRef.current.length > 0) {
          const bufferLength = outputAnalyserRef.current.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          outputAnalyserRef.current.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const average = sum / bufferLength / 255;
          volumesRef.current.speaker = average;

          setState((prev) => (prev === "connected" || prev === "listening" ? "speaking" : prev));
        } else {
          volumesRef.current.speaker = 0;
          setState((prev) => (prev === "speaking" ? "connected" : prev));
        }

        // Track audio activity & silence detection (~60s of silence during active call)
        const isActivity = volumesRef.current.mic > 0.02 || volumesRef.current.speaker > 0.02;
        if (isActivity) {
          lastAudioActivityRef.current = Date.now();
        } else if (callPhaseRef.current === "active" && !isDisconnectingGracefullyRef.current) {
          const silentMs = Date.now() - lastAudioActivityRef.current;
          if (silentMs >= 60000 && !hasHandledSilenceRef.current && !hasHandledLimitRef.current) {
            triggerGracefulSilenceEnd();
          }
        }

        volumePollIdRef.current = requestAnimationFrame(pollVolume);
      };

      volumePollIdRef.current = requestAnimationFrame(pollVolume);

    } catch (err: any) {
      console.error("[AudioEngine] Failed to connect:", err);
      const errMsg = (err.message || "").toLowerCase();
      const errName = err.name || "";
      const isMic =
        errName === "NotAllowedError" ||
        errName === "PermissionDeniedError" ||
        errName === "NotFoundError" ||
        errMsg.includes("permission") ||
        errMsg.includes("not allowed") ||
        errMsg.includes("microphone");

      failCall(isMic ? "mic" : "server");
    }
  }, [
    disconnect,
    failCall,
    internalDisconnect,
    playAudioChunk,
    requestWakeLock,
    selectedMicId,
    triggerGracefulLimitEnd,
    triggerGracefulSilenceEnd,
    updateCallPhase,
    onToolCallCompleted,
    onToolCallExecuted,
    onToolCallExecuting,
    onVoiceError
  ]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      stopAllCallSounds();
      if (connectingTimeoutRef.current) clearTimeout(connectingTimeoutRef.current);
      if (minRingTimeoutRef.current) clearTimeout(minRingTimeoutRef.current);
      if (endedPhaseTimerRef.current) clearTimeout(endedPhaseTimerRef.current);
      disconnect(false);
    };
  }, [disconnect]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  return {
    state,
    callPhase,
    failureReason,
    isCallDropped,
    isMuted,
    volumesRef,
    remainingSeconds,
    limitSeconds,
    is1MinWarningActive,
    isSilenceHangup,
    isQuotaHangup,
    fetchVoiceQuota,
    connect,
    disconnect,
    toggleMute,
    stopPlayback,
  };
}
