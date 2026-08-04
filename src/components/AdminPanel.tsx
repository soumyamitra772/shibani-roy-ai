import React, { useEffect, useState, useCallback } from "react";
import { Users, Crown, Activity, MessageSquare, Image, Wrench, Mic, RefreshCw, ShieldCheck, X } from "lucide-react";
import { THEMES } from "../utils/themes";
import type { ThemeId } from "../utils/themes";

interface AdminPanelProps {
  theme: ThemeId;
  session: any;
  onClose: () => void;
}

interface Stats {
  totalUsers: number;
  proUsers: number;
  activeToday: number;
  totalMessages: number;
  today: string;
}

interface UserRow {
  userId: string;
  chatMessages: number;
  imagesGenerated: number;
  toolCalls: number;
  voiceMinutes: number;
  isPro: boolean;
  subStatus: string;
  subExpiry: string | null;
}

export default function AdminPanel({ theme, session, onClose }: AdminPanelProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const t = THEMES[theme];

  const authHeader = () => ({
    "Content-Type": "application/json",
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : "",
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, usersRes] = await Promise.all([
        fetch("/api/admin/stats", { headers: authHeader() }),
        fetch("/api/admin/users", { headers: authHeader() }),
      ]);
      if (statsRes.ok) setStats(await statsRes.json());
      if (usersRes.ok) {
        const d = await usersRes.json();
        setUsers(d.users || []);
      }
    } catch (e) {
      console.error("Admin fetch failed:", e);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleGrantPro = async (userId: string) => {
    setActionLoading(userId + "-grant");
    try {
      const res = await fetch("/api/admin/grant-pro", {
        method: "POST", headers: authHeader(), body: JSON.stringify({ userId }),
      });
      const d = await res.json();
      setNotification(d.success ? `✅ Pro granted to ${userId.slice(0, 8)}...` : `❌ ${d.error}`);
      await fetchData();
    } finally {
      setActionLoading(null);
      setTimeout(() => setNotification(null), 3000);
    }
  };

  const handleRevokePro = async (userId: string) => {
    setActionLoading(userId + "-revoke");
    try {
      const res = await fetch("/api/admin/revoke-pro", {
        method: "POST", headers: authHeader(), body: JSON.stringify({ userId }),
      });
      const d = await res.json();
      setNotification(d.success ? `✅ Pro revoked from ${userId.slice(0, 8)}...` : `❌ ${d.error}`);
      await fetchData();
    } finally {
      setActionLoading(null);
      setTimeout(() => setNotification(null), 3000);
    }
  };

  return (
    <div className={`fixed inset-0 z-50 flex flex-col ${t.bgClass} text-white overflow-y-auto`}>
      {/* Header */}
      <div className={`sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b ${t.borderColor} backdrop-blur-xl bg-black/30`}>
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-purple-400" />
          <h1 className="text-lg font-bold">Admin Panel</h1>
          {stats && <span className="text-xs text-gray-400 ml-2">{stats.today}</span>}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={fetchData} className="p-2 rounded-full hover:bg-white/10 transition" title="Refresh">
            <RefreshCw className="w-4 h-4 text-gray-400" />
          </button>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-white/10 transition">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      </div>

      {notification && (
        <div className="mx-6 mt-4 px-4 py-2 rounded-xl bg-purple-500/20 border border-purple-500/40 text-sm text-center">
          {notification}
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <RefreshCw className="w-6 h-6 animate-spin text-purple-400" />
        </div>
      ) : (
        <div className="p-6 flex flex-col gap-6">
          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "Total Users", value: stats.totalUsers, icon: <Users className="w-4 h-4" />, color: "text-blue-400" },
                { label: "Pro Users", value: stats.proUsers, icon: <Crown className="w-4 h-4" />, color: "text-yellow-400" },
                { label: "Active Today", value: stats.activeToday, icon: <Activity className="w-4 h-4" />, color: "text-green-400" },
                { label: "Messages Today", value: stats.totalMessages, icon: <MessageSquare className="w-4 h-4" />, color: "text-purple-400" },
              ].map((s) => (
                <div key={s.label} className={`rounded-2xl border ${t.borderColor} ${t.cardBg} p-4 flex flex-col gap-1`}>
                  <div className={`flex items-center gap-1.5 ${s.color} text-xs font-medium`}>{s.icon}{s.label}</div>
                  <div className="text-2xl font-bold">{s.value ?? "—"}</div>
                </div>
              ))}
            </div>
          )}

          {/* Users Table */}
          <div className={`rounded-2xl border ${t.borderColor} ${t.cardBg} overflow-hidden`}>
            <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
              <h2 className="font-semibold text-sm">Today's Active Users</h2>
              <span className="text-xs text-gray-400">{users.length} users</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-400 border-b border-white/10">
                    <th className="px-4 py-2 text-left">User ID</th>
                    <th className="px-4 py-2 text-center"><MessageSquare className="w-3 h-3 inline" /> Msgs</th>
                    <th className="px-4 py-2 text-center"><Image className="w-3 h-3 inline" /> Imgs</th>
                    <th className="px-4 py-2 text-center"><Wrench className="w-3 h-3 inline" /> Tools</th>
                    <th className="px-4 py-2 text-center"><Mic className="w-3 h-3 inline" /> Voice</th>
                    <th className="px-4 py-2 text-center">Plan</th>
                    <th className="px-4 py-2 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 && (
                    <tr><td colSpan={7} className="text-center text-gray-500 py-8">No active users today</td></tr>
                  )}
                  {users.map((u) => (
                    <tr key={u.userId} className="border-b border-white/5 hover:bg-white/5 transition">
                      <td className="px-4 py-2 font-mono text-xs text-gray-300">{u.userId.slice(0, 12)}...</td>
                      <td className="px-4 py-2 text-center">{u.chatMessages}</td>
                      <td className="px-4 py-2 text-center">{u.imagesGenerated}</td>
                      <td className="px-4 py-2 text-center">{u.toolCalls}</td>
                      <td className="px-4 py-2 text-center">{u.voiceMinutes}m</td>
                      <td className="px-4 py-2 text-center">
                        {u.isPro
                          ? <span className="px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-medium border border-yellow-500/30">PRO</span>
                          : <span className="px-2 py-0.5 rounded-full bg-white/5 text-gray-400 text-xs border border-white/10">Free</span>}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <div className="flex gap-1 justify-center">
                          {!u.isPro ? (
                            <button
                              onClick={() => handleGrantPro(u.userId)}
                              disabled={!!actionLoading}
                              className="px-2 py-1 rounded-lg bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 text-xs border border-yellow-500/30 transition disabled:opacity-50"
                            >
                              {actionLoading === u.userId + "-grant" ? "..." : "Grant Pro"}
                            </button>
                          ) : (
                            <button
                              onClick={() => handleRevokePro(u.userId)}
                              disabled={!!actionLoading}
                              className="px-2 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 text-xs border border-red-500/30 transition disabled:opacity-50"
                            >
                              {actionLoading === u.userId + "-revoke" ? "..." : "Revoke"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
