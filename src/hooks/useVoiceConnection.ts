/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { AssistantState, ToolCallPayload } from "../types";
import { float32ToPcm16Base64, pcm16Base64ToFloat32 } from "../utils/audioUtils";
import { ToolExecutor } from "../services/ToolExecutor";
import { getOrCreateUserId } from "../utils/userId";

interface UseVoiceConnectionProps {
  onToolCallExecuted?: (message: string) => void;
  onAssistantSpokeText?: (text: string) => void;
}

export function useVoiceConnection({
  onToolCallExecuted,
  onAssistantSpokeText,
}: UseVoiceConnectionProps = {}) {
  const [state, setState] = useState<AssistantState>("disconnected");
  const [isMuted, setIsMuted] = useState(false);
  const volumesRef = useRef({ mic: 0, speaker: 0 });

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
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartTimeRef = useRef<number>(0);

  // Animation Frame references
  const volumePollIdRef = useRef<number | null>(null);

  // Helper ref to avoid closure staleness
  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

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
   * Close and clean up all connections, contexts, and audio nodes
   */
  const disconnect = useCallback(() => {
    console.log("[AudioEngine] Initiating clean disconnect...");
    setState("disconnected");

    // Cancel animation frame polling
    if (volumePollIdRef.current) {
      cancelAnimationFrame(volumePollIdRef.current);
      volumePollIdRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Stop and clear playback
    stopPlayback();

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
  }, [stopPlayback]);

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
    disconnect();
    setState("connecting");

    try {
      // Initialize output AudioContext (24kHz) for speaker output
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
      });
      outputAudioCtxRef.current = outCtx;

      const outAnalyser = outCtx.createAnalyser();
      outAnalyser.fftSize = 256;
      outputAnalyserRef.current = outAnalyser;

      const outGain = outCtx.createGain();
      outGain.gain.setValueAtTime(1.0, outCtx.currentTime);
      outputGainNodeRef.current = outGain;

      outAnalyser.connect(outGain);
      outGain.connect(outCtx.destination);

      // Request microphone permissions
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
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
      const userId = getOrCreateUserId();
      const wsUrl = `${protocol}//${window.location.host}/api/live-ws?userId=${encodeURIComponent(userId)}`;

      console.log(`[AudioEngine] Connecting WebSocket: ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Configure microphone chunk dispatch
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
            case "connected":
              console.log("[AudioEngine] Voice connection active");
              setState("connected");
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
              // Transition back to connected state after a split second
              setTimeout(() => {
                setState((prev) => (prev === "interrupted" ? "connected" : prev));
              }, 400);
              break;

            case "toolCall":
              if (msg.toolCall) {
                const call = msg.toolCall as ToolCallPayload;
                // Execute tool
                const result = await ToolExecutor.execute(call);
                
                // Trigger visual callbacks if provided
                if (onToolCallExecuted) {
                  onToolCallExecuted(result.message);
                }

                // Reply to WebSocket server with result (include function name required by SDK)
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
              disconnect();
              break;

            case "error":
              console.error("[AudioEngine] Server error:", msg.message);
              setState("error");
              break;
          }
        } catch (err) {
          console.error("[AudioEngine] Error parsing socket payload:", err);
        }
      };

      ws.onclose = () => {
        console.log("[AudioEngine] WebSocket connection closed");
        disconnect();
      };

      ws.onerror = (e) => {
        console.error("[AudioEngine] WebSocket experienced an error:", e);
        setState("error");
      };

      // Poll volumes continuously for visualization (directly updating refs for high performance)
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

          // Update state to speaking if active
          setState((prev) => (prev === "connected" || prev === "listening" ? "speaking" : prev));
        } else {
          volumesRef.current.speaker = 0;
          // Transition speaking state back to connected if no audio is playing
          setState((prev) => (prev === "speaking" ? "connected" : prev));
        }

        volumePollIdRef.current = requestAnimationFrame(pollVolume);
      };

      volumePollIdRef.current = requestAnimationFrame(pollVolume);

    } catch (err: any) {
      console.error("[AudioEngine] Failed to connect:", err);
      setState("error");
      disconnect();
    }
  }, [disconnect, playAudioChunk, stopPlayback, onToolCallExecuted]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  return {
    state,
    isMuted,
    volumesRef,
    connect,
    disconnect,
    toggleMute,
    stopPlayback,
  };
}
