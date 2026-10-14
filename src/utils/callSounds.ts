/**
 * Call Sounds and Telecom Operator Voice Engine
 * Generated entirely using Web Audio API (oscillators + gain envelopes) and SpeechSynthesis API.
 * No binary or audio files (mp3, wav, ogg) are used.
 */

let soundAudioCtx: AudioContext | null = null;
let ringbackIntervalId: any = null;
let isRingbackActive = false;
let currentRingGains: GainNode[] = [];

/**
 * Lazily creates or resumes the shared sound effects AudioContext.
 * Must be invoked from or prepared during a user gesture (e.g. call button click).
 */
export function getSoundAudioContext(): AudioContext {
  if (!soundAudioCtx || soundAudioCtx.state === "closed") {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    soundAudioCtx = new AudioContextClass();
  }
  if (soundAudioCtx.state === "suspended") {
    soundAudioCtx.resume().catch(() => {});
  }
  return soundAudioCtx;
}

/**
 * Start a phone ringback tone:
 * Two mixed sine tones (~400 Hz and ~450 Hz) with low volume (0.08 - 0.12).
 * Cadence: 0.4s ring, 0.2s gap, 0.4s ring, 2.0s pause (total 3.0s cycle).
 * Smooth attack/release to prevent audio clicks.
 */
export function startRingback(): void {
  stopRingback();
  stopOperatorSpeech();

  const ctx = getSoundAudioContext();
  isRingbackActive = true;

  const playRingBurst = (startDelay: number, duration: number) => {
    if (!isRingbackActive) return;
    try {
      const now = ctx.currentTime + startDelay;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const burstGain = ctx.createGain();

      osc1.type = "sine";
      osc1.frequency.setValueAtTime(400, now);

      osc2.type = "sine";
      osc2.frequency.setValueAtTime(450, now);

      // Smooth attack and release envelope (max gain ~0.09)
      burstGain.gain.setValueAtTime(0.0001, now);
      burstGain.gain.linearRampToValueAtTime(0.09, now + 0.04);
      burstGain.gain.setValueAtTime(0.09, now + duration - 0.04);
      burstGain.gain.linearRampToValueAtTime(0.0001, now + duration);

      osc1.connect(burstGain);
      osc2.connect(burstGain);
      burstGain.connect(ctx.destination);

      currentRingGains.push(burstGain);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + duration + 0.05);
      osc2.stop(now + duration + 0.05);

      setTimeout(() => {
        currentRingGains = currentRingGains.filter((g) => g !== burstGain);
      }, (startDelay + duration + 0.1) * 1000);
    } catch (e) {
      console.warn("[CallSounds] Error playing ring burst:", e);
    }
  };

  const scheduleCycle = () => {
    if (!isRingbackActive) return;
    // Burst 1: 0.4s
    playRingBurst(0, 0.4);
    // Gap: 0.2s -> Burst 2: 0.4s
    playRingBurst(0.6, 0.4);
  };

  // Immediate first cycle
  scheduleCycle();
  // Repeat every 3 seconds (0.4 + 0.2 + 0.4 + 2.0s pause)
  ringbackIntervalId = setInterval(() => {
    if (!isRingbackActive) {
      clearInterval(ringbackIntervalId);
      return;
    }
    scheduleCycle();
  }, 3000);
}

/**
 * Stops the ringback tone immediately and mutes any in-flight bursts.
 */
export function stopRingback(): void {
  isRingbackActive = false;
  if (ringbackIntervalId) {
    clearInterval(ringbackIntervalId);
    ringbackIntervalId = null;
  }
  // Mute active gain nodes instantly
  currentRingGains.forEach((g) => {
    try {
      if (soundAudioCtx) {
        g.gain.cancelScheduledValues(soundAudioCtx.currentTime);
        g.gain.setValueAtTime(0.0001, soundAudioCtx.currentTime);
      }
    } catch (e) {}
  });
  currentRingGains = [];
}

/**
 * Short pick-up blip (about 120ms) when call becomes active.
 * Triggers short haptic vibration on supported devices.
 */
export function playPickupBlip(): void {
  try {
    const ctx = getSoundAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(920, now + 0.12);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.13);
  } catch (e) {
    console.warn("[CallSounds] Pickup blip error:", e);
  }

  try {
    navigator.vibrate?.(30);
  } catch (e) {}
}

/**
 * Short single tone when user intentionally hangs up.
 */
export function playHangupTone(): void {
  try {
    const ctx = getSoundAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(480, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.1, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.19);
  } catch (e) {
    console.warn("[CallSounds] Hangup tone error:", e);
  }
}

/**
 * Short two-tone sound when an active call drops unexpectedly.
 */
export function playDroppedTone(): void {
  try {
    const ctx = getSoundAudioContext();
    const now = ctx.currentTime;

    // Tone 1: 480 Hz (140ms)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(480, now);
    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.linearRampToValueAtTime(0.1, now + 0.02);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.15);

    // Tone 2: 350 Hz (160ms) starting after 140ms
    const t2 = now + 0.14;
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(350, t2);
    gain2.gain.setValueAtTime(0.001, t2);
    gain2.gain.linearRampToValueAtTime(0.1, t2 + 0.02);
    gain2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.16);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(t2);
    osc2.stop(t2 + 0.17);
  } catch (e) {
    console.warn("[CallSounds] Dropped tone error:", e);
  }
}

/**
 * Three short descending-then-rising "operator" tones (about 3 x 250ms).
 * Returns a Promise that resolves when tones complete.
 */
export function playOperatorTones(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const ctx = getSoundAudioContext();
      const now = ctx.currentTime;
      const freqs = [950, 700, 1400]; // descending then rising
      const toneDuration = 0.25;

      freqs.forEach((freq, idx) => {
        const startTime = now + idx * toneDuration;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, startTime);

        gain.gain.setValueAtTime(0.001, startTime);
        gain.gain.linearRampToValueAtTime(0.12, startTime + 0.02);
        gain.gain.setValueAtTime(0.12, startTime + toneDuration - 0.03);
        gain.gain.linearRampToValueAtTime(0.0001, startTime + toneDuration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + toneDuration + 0.02);
      });

      setTimeout(() => {
        resolve();
      }, freqs.length * toneDuration * 1000);
    } catch (e) {
      console.warn("[CallSounds] Operator tones error:", e);
      resolve();
    }
  });
}

/**
 * Helper to get available SpeechSynthesis voices, handling asynchronous loading.
 */
function getVoicesAsync(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve([]);
      return;
    }
    const current = window.speechSynthesis.getVoices();
    if (current && current.length > 0) {
      resolve(current);
      return;
    }
    const timer = setTimeout(() => {
      resolve(window.speechSynthesis.getVoices() || []);
    }, 300);

    window.speechSynthesis.onvoiceschanged = () => {
      clearTimeout(timer);
      resolve(window.speechSynthesis.getVoices() || []);
    };
  });
}

/**
 * Speaks the matching telecom operator message with speechSynthesis.
 */
export async function speakOperatorMessage(reason: "server" | "timeout" | "mic" | "limit"): Promise<void> {
  stopOperatorSpeech();

  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }

  const voices = await getVoicesAsync();
  const navLang = (navigator.language || "").toLowerCase();

  let targetLang: "hi" | "bn" | "en" = "en";
  if (navLang.startsWith("hi")) {
    const hasHiVoice = voices.some((v) => v.lang.toLowerCase().includes("hi"));
    if (hasHiVoice) targetLang = "hi";
  } else if (navLang.startsWith("bn")) {
    const hasBnVoice = voices.some(
      (v) => v.lang.toLowerCase().includes("bn") || v.lang.toLowerCase().includes("ben")
    );
    if (hasBnVoice) targetLang = "bn";
  }

  let text = "";
  let bcp47 = "en-IN";

  if (targetLang === "hi") {
    bcp47 = "hi-IN";
    if (reason === "mic") {
      text = "माइक्रोफ़ोन एक्सेस ब्लॉक है। कृपया अपनी ब्राउज़र सेटिंग में माइक्रोफ़ोन की अनुमति दें और दोबारा कॉल करें।";
    } else if (reason === "limit") {
      text = "आपने आज के लिए अपने सभी वॉयस मिनट इस्तेमाल कर लिए हैं। कृपया आधी रात के बाद दोबारा प्रयास करें।";
    } else {
      text = "आप जिस नंबर से संपर्क करना चाहते हैं, वह अभी उपलब्ध नहीं है। कृपया कुछ देर बाद प्रयास करें।";
    }
  } else if (targetLang === "bn") {
    bcp47 = "bn-IN";
    if (reason === "mic") {
      text = "মাইক্রোফোন অ্যাক্সেস ব্লক করা আছে। অনুগ্রহ করে আপনার ব্রাউজার সেটিংসে গিয়ে মাইক্রোফোনের অনুমতি দিন এবং আবার কল করুন।";
    } else if (reason === "limit") {
      text = "আপনি আজকের জন্য আপনার সমস্ত ভয়েস মিনিট ব্যবহার করে ফেলেছেন। অনুগ্রহ করে মধ্যরাতের পর আবার চেষ্টা করুন।";
    } else {
      text = "আপনি যে নম্বরে যোগাযোগ করতে চাইছেন, সেটি এই মুহূর্তে পাওয়া যাচ্ছে না। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।";
    }
  } else {
    bcp47 = "en-IN";
    if (reason === "mic") {
      text = "Microphone access is blocked. Please allow microphone permission in your browser settings, and call again.";
    } else if (reason === "limit") {
      text = "You have used all your voice minutes for today. Please try again after midnight.";
    } else {
      text = "The number you are trying to reach is currently unavailable. Please try again later.";
    }
  }

  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = bcp47;
    utterance.rate = 0.95;
    utterance.volume = 1.0;

    // Pick best matching voice
    const voice =
      voices.find((v) => v.lang.toLowerCase() === bcp47.toLowerCase()) ||
      voices.find((v) => v.lang.toLowerCase().startsWith(bcp47.slice(0, 2))) ||
      voices.find((v) => v.lang.toLowerCase().includes("en-in")) ||
      voices.find((v) => v.lang.toLowerCase().startsWith("en")) ||
      voices[0];

    if (voice) {
      utterance.voice = voice;
    }

    window.speechSynthesis.speak(utterance);
  } catch (e) {
    console.warn("[CallSounds] Speech synthesis error:", e);
  }
}

/**
 * Gentle 1-minute warning chime: two soft tones (G5 ~784Hz, C6 ~1046Hz).
 * Smooth gain envelope to notify user unobtrusively.
 */
export function playWarningChime(): void {
  try {
    const ctx = getSoundAudioContext();
    const now = ctx.currentTime;

    // Tone 1: 784 Hz (120ms)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(783.99, now);

    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.linearRampToValueAtTime(0.07, now + 0.02);
    gain1.gain.setValueAtTime(0.07, now + 0.09);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.13);

    // Tone 2: 1046.5 Hz (140ms), starts after 100ms
    const t2 = now + 0.1;
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(1046.5, t2);

    gain2.gain.setValueAtTime(0.001, t2);
    gain2.gain.linearRampToValueAtTime(0.07, t2 + 0.02);
    gain2.gain.setValueAtTime(0.07, t2 + 0.11);
    gain2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.14);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(t2);
    osc2.stop(t2 + 0.15);
  } catch (e) {
    console.warn("[CallSounds] Warning chime error:", e);
  }
}

/**
 * Speaks a polite, natural goodbye in the user's language when the call ends gracefully
 * (e.g. daily limit reached or silence auto-hang-up).
 */
export async function speakGoodbyeMessage(reason: "limit" | "silence"): Promise<void> {
  stopOperatorSpeech();

  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }

  const voices = await getVoicesAsync();
  const navLang = (navigator.language || "").toLowerCase();

  let targetLang: "hi" | "bn" | "en" = "en";
  if (navLang.startsWith("hi")) {
    const hasHiVoice = voices.some((v) => v.lang.toLowerCase().includes("hi"));
    if (hasHiVoice) targetLang = "hi";
  } else if (navLang.startsWith("bn")) {
    const hasBnVoice = voices.some(
      (v) => v.lang.toLowerCase().includes("bn") || v.lang.toLowerCase().includes("ben")
    );
    if (hasBnVoice) targetLang = "bn";
  }

  let text = "";
  let bcp47 = "en-IN";

  if (targetLang === "hi") {
    bcp47 = "hi-IN";
    if (reason === "limit") {
      text = "आज के लिए हमारा समय पूरा हो गया! आपसे बात करके बहुत अच्छा लगा। जल्दी फिर बात करेंगे, बाय!";
    } else {
      text = "काफी देर से कोई आवाज न आने के कारण कॉल समाप्त की जा रही है। बाद में फिर बात करेंगे, बाय!";
    }
  } else if (targetLang === "bn") {
    bcp47 = "bn-IN";
    if (reason === "limit") {
      text = "আজকের মতো আমাদের কথা বলা শেষ! তোমার সাথে কথা বলে খুব ভালো লাগলো। আবার কথা হবে, বাই!";
    } else {
      text = "অনেকক্ষণ কোনো সাড়া না পাওয়ায় কলটি কেটে দেওয়া হচ্ছে। পরে আবার কথা হবে, বাই!";
    }
  } else {
    bcp47 = "en-IN";
    if (reason === "limit") {
      text = "Our time is up for today! It was wonderful chatting with you. Talk soon, bye!";
    } else {
      text = "I haven't heard from you in a bit, so I'll let you go for now. Talk soon, bye!";
    }
  }

  return new Promise((resolve) => {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = bcp47;
      utterance.rate = 1.0;
      utterance.volume = 1.0;

      const voice =
        voices.find((v) => v.lang.toLowerCase() === bcp47.toLowerCase()) ||
        voices.find((v) => v.lang.toLowerCase().startsWith(bcp47.slice(0, 2))) ||
        voices.find((v) => v.lang.toLowerCase().includes("en-in")) ||
        voices.find((v) => v.lang.toLowerCase().startsWith("en")) ||
        voices[0];

      if (voice) {
        utterance.voice = voice;
      }

      const timeout = setTimeout(() => {
        resolve();
      }, 4000);

      utterance.onend = () => {
        clearTimeout(timeout);
        resolve();
      };
      utterance.onerror = () => {
        clearTimeout(timeout);
        resolve();
      };

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn("[CallSounds] Goodbye speech error:", e);
      resolve();
    }
  });
}

/**
 * Cancels any speech synthesis in progress.
 */
export function stopOperatorSpeech(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}
  }
}

/**
 * Stops all call sounds, ringbacks, and operator speech.
 */
export function stopAllCallSounds(): void {
  stopRingback();
  stopOperatorSpeech();
}
