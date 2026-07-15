import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mail, Sparkles, Send, CheckCircle2, AlertCircle } from "lucide-react";
import { ThemeId, THEMES } from "../utils/themes";

interface LoginScreenProps {
  theme: ThemeId;
}

export default function LoginScreen({ theme }: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const activeTheme = THEMES[theme];

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    setErrorMsg(null);

    try {
      const response = await fetch("/api/auth/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to send login link.");
      }

      setSent(true);
    } catch (err: any) {
      console.error("Login error:", err);
      setErrorMsg(err.message || "Failed to send magic link. Please check your email and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6 min-h-[70vh]">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className={`w-full max-w-md p-8 rounded-3xl border ${activeTheme.borderColor} ${activeTheme.cardBg} backdrop-blur-xl shadow-2xl relative overflow-hidden`}
      >
        {/* Subtle decorative glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-48 bg-rose-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="text-center mb-8 relative z-10">
          <motion.div
            animate={{ rotate: [0, 10, -10, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-r from-rose-500/20 to-pink-500/20 border border-rose-500/30 text-rose-300 mb-4"
          >
            <Sparkles className="w-7 h-7" />
          </motion.div>
          <h2 className="text-2xl font-bold tracking-tight text-white mb-2 font-sans">
            Welcome back to Shibani
          </h2>
          <p className="text-xs text-gray-400 font-sans max-w-xs mx-auto">
            Your personal companion of deep thoughts and shared memories. Sign in securely using passwordless email.
          </p>
        </div>

        <AnimatePresence mode="wait">
          {!sent ? (
            <motion.form
              key="login-form"
              onSubmit={handleLogin}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.3 }}
              className="space-y-5 relative z-10"
            >
              <div>
                <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2 font-mono">
                  Email Address
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400 pointer-events-none">
                    <Mail className="w-4 h-4" />
                  </span>
                  <input
                    id="email"
                    type="email"
                    required
                    disabled={loading}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full pl-10 pr-4 py-3 bg-black/40 border border-white/10 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500 transition-all font-sans"
                  />
                </div>
              </div>

              {errorMsg && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-3 rounded-xl border border-red-500/20 bg-red-500/5 flex items-start gap-2 text-xs text-red-300"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </motion.div>
              )}

              <button
                type="submit"
                disabled={loading || !email}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-rose-500 to-pink-500 text-white font-semibold text-sm hover:brightness-110 shadow-lg disabled:opacity-50 disabled:pointer-events-none transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Sending magic link...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    <span>Send me a login link</span>
                  </>
                )}
              </button>
            </motion.form>
          ) : (
            <motion.div
              key="sent-confirmation"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 25 }}
              className="text-center py-6 space-y-4 relative z-10"
            >
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 mb-1">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-white font-sans">Check your email!</h3>
              <p className="text-xs text-gray-400 font-sans leading-relaxed max-w-sm mx-auto">
                We've sent a magic login link to <strong className="text-gray-200">{email}</strong>.
                Click the link in your email to sign in instantly.
              </p>
              
              <div className="pt-4">
                <button
                  type="button"
                  onClick={() => setSent(false)}
                  className="text-xs font-semibold text-gray-400 hover:text-white underline underline-offset-4 cursor-pointer transition-colors"
                >
                  Back to login
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
