import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { avatarText } from "../lib";
import type { Guest } from "../types";

export function GuestMenu({
  guest,
  locked = false,
  onChange
}: {
  guest: Guest;
  locked?: boolean;
  onChange?: (guest: Guest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

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

  const toggle = () => {
    if (locked) return;
    const next = !open;
    setOpen(next);
    setCreating(false);
    if (next) void load();
  };

  const create = async () => {
    try {
      const created = await api.createGuest(name);
      setName("");
      setOpen(false);
      onChange?.(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    }
  };

  return (
    <div className="guest-menu" ref={root}>
      <button
        type="button"
        className={`guest-trigger ${locked ? "locked" : ""}`}
        onClick={toggle}
        aria-expanded={locked ? undefined : open}
      >
        <span className="avatar">{avatarText(guest.name)}</span>
        <span className="guest-name">{guest.name}</span>
        {!locked && <ChevronDown size={15} aria-hidden="true" />}
      </button>
      {open && (
        <div className="guest-popover">
          <div className="popover-heading">
            <span>选择游客</span>
            <button className="icon-button" onClick={() => setOpen(false)} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
          {error && (
            <div className="inline-error">
              <span>{error}</span>
              {!creating && <button onClick={() => void load()}>重试</button>}
            </div>
          )}
          {loading ? (
            <div className="menu-loading">正在加载…</div>
          ) : creating ? (
            <div className="create-guest">
              <label htmlFor="guest-name">游客名称</label>
              <input
                id="guest-name"
                value={name}
                autoFocus
                maxLength={21}
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void create();
                }}
              />
              <div className="menu-actions">
                <button className="button secondary" onClick={() => setCreating(false)}>
                  取消
                </button>
                <button className="button primary" disabled={!name} onClick={() => void create()}>
                  创建
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="guest-options">
                {items.map((item) => (
                  <button
                    key={item.id}
                    className="guest-option"
                    onClick={() => {
                      setOpen(false);
                      if (item.id !== guest.id) onChange?.(item);
                    }}
                  >
                    <span className="avatar small">{avatarText(item.name)}</span>
                    <span>{item.name}</span>
                    {item.id === guest.id && <Check size={16} />}
                  </button>
                ))}
              </div>
              <button className="create-guest-entry" onClick={() => setCreating(true)}>
                <Plus size={16} /> 创建游客
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
