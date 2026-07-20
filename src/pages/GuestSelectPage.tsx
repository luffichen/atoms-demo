import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Brand } from "../components/Brand";
import { avatarText } from "../lib";
import type { Guest } from "../types";

export function GuestSelectPage({ onSelect }: { onSelect: (guest: Guest) => void }) {
  const [items, setItems] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setItems((await api.guests()).items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "游客列表加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => void load(), []);

  const create = async () => {
    setCreateError("");
    try {
      onSelect(await api.createGuest(name));
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : "创建失败");
    }
  };

  return (
    <main className="guest-select-page">
      <div className="select-brand">
        <Brand />
      </div>
      <section className="guest-select-card">
        <div>
          <p className="eyebrow">共享演示实例</p>
          <h1>选择游客开始体验</h1>
          <p>选择已有游客，或创建一个新的演示身份。</p>
        </div>
        {loading ? (
          <div className="center-state"><span className="spinner dark" /> 正在加载游客…</div>
        ) : error ? (
          <div className="error-state">
            <span>{error}</span>
            <button className="button secondary" onClick={() => void load()}>
              <RefreshCw size={16} /> 重试
            </button>
          </div>
        ) : (
          <div className="guest-list">
            {items.map((guest) => (
              <button className="guest-card" key={guest.id} onClick={() => onSelect(guest)}>
                <span className="avatar large">{avatarText(guest.name)}</span>
                <span>{guest.name}</span>
              </button>
            ))}
          </div>
        )}
        {!loading && !error && (
          creating ? (
            <div className="guest-create-form">
              <label htmlFor="new-guest">新游客名称</label>
              <input
                id="new-guest"
                value={name}
                autoFocus
                onChange={(event) => {
                  setName(event.target.value);
                  setCreateError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void create();
                }}
              />
              {createError && <span className="error-text">{createError}</span>}
              <div>
                <button className="button secondary" onClick={() => setCreating(false)}>取消</button>
                <button className="button primary" disabled={!name} onClick={() => void create()}>创建并进入</button>
              </div>
            </div>
          ) : (
            <button className="new-guest-button" onClick={() => setCreating(true)}>
              <Plus size={17} /> 创建游客
            </button>
          )
        )}
      </section>
    </main>
  );
}
