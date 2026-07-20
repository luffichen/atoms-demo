import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ResultToast } from "./components/ResultToast";
import { navigate } from "./lib";
import { GuestSelectPage } from "./pages/GuestSelectPage";
import { HomePage } from "./pages/HomePage";
import { ProjectPage } from "./pages/ProjectPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import type { Guest, Notification } from "./types";

const LAST_GUEST_KEY = "atoms.lastGuestId";

export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [checkingGuest, setCheckingGuest] = useState(true);
  const [toast, setToast] = useState<Notification | null>(null);

  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);

  useEffect(() => {
    if (!guest) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retry: number | undefined;

    const deliver = async (notification: Notification) => {
      const key = `atoms.notification.${notification.turnId}`;
      const showOnce = async () => {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, "shown");
        if (location.pathname !== `/projects/${notification.projectId}`) {
          setToast(notification);
        }
      };
      if (navigator.locks) {
        await navigator.locks.request(key, showOnce);
      } else {
        await showOnce();
      }
    };

    void api.notifications(guest.id).then(({ items }) => {
      for (const notification of [...items].reverse()) void deliver(notification);
    });

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws/guests/${guest.id}`);
      socket.onmessage = (event) => {
        const envelope = JSON.parse(event.data);
        if (envelope.kind === "notification") void deliver(envelope.data);
      };
      socket.onclose = () => {
        if (!disposed) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [guest]);

  useEffect(() => {
    const remembered = localStorage.getItem(LAST_GUEST_KEY);
    if (!remembered) {
      setCheckingGuest(false);
      if (location.pathname !== "/select") navigate("/select");
      return;
    }
    api.guests()
      .then(({ items }) => {
        const selected = items.find(({ id }) => id === remembered);
        if (selected) {
          setGuest(selected);
          if (location.pathname === "/" || location.pathname === "/select") navigate("/home");
        } else {
          localStorage.removeItem(LAST_GUEST_KEY);
          navigate("/select");
        }
      })
      .catch(() => navigate("/select"))
      .finally(() => setCheckingGuest(false));
  }, []);

  const selectGuest = (selected: Guest) => {
    setGuest(selected);
    localStorage.setItem(LAST_GUEST_KEY, selected.id);
    navigate("/home");
  };

  const switchGuest = (selected: Guest) => {
    setGuest(selected);
    localStorage.setItem(LAST_GUEST_KEY, selected.id);
  };

  const dismissToast = useCallback(() => setToast(null), []);

  if (checkingGuest) return <div className="app-loading"><span className="spinner dark" /> 正在打开 Atoms Demo…</div>;
  const notificationToast = toast ? (
    <ResultToast
      notification={toast}
      onDismiss={dismissToast}
      onOpen={(notification) =>
        navigate(notification.targetUrl ?? `/projects/${notification.projectId}`)
      }
    />
  ) : null;

  if (path === "/select" || !guest) return <GuestSelectPage onSelect={selectGuest} />;
  if (path === "/home" || path === "/") {
    return <><HomePage guest={guest} onGuestChange={switchGuest} />{notificationToast}</>;
  }
  if (path === "/projects") {
    return <><ProjectsPage guest={guest} onGuestChange={switchGuest} />{notificationToast}</>;
  }
  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    return (
      <>
        <ProjectPage guest={guest} projectId={projectMatch[1]} onGuestChange={switchGuest} />
        {notificationToast}
      </>
    );
  }
  return <div className="unavailable-state"><h1>页面不存在</h1><button className="button primary" onClick={() => navigate("/home")}>返回首页</button></div>;
}
