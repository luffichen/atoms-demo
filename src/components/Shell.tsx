import { FolderKanban, Home, Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { navigate } from "../lib";
import type { Guest } from "../types";
import { Brand } from "./Brand";
import { GuestMenu } from "./GuestMenu";

export function Shell({
  guest,
  active,
  projectLocked = false,
  onGuestChange,
  children
}: {
  guest: Guest;
  active: "home" | "projects" | "project";
  projectLocked?: boolean;
  onGuestChange: (guest: Guest) => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("atoms.sidebar") === "collapsed");
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    localStorage.setItem("atoms.sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  const go = (path: string) => {
    setDrawer(false);
    navigate(path);
  };

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <button
        className={`mobile-menu-button ${drawer ? "open" : ""}`}
        onClick={() => setDrawer((value) => !value)}
        aria-label={drawer ? "关闭导航" : "打开导航"}
        aria-expanded={drawer}
      >
        {drawer ? <X size={18} /> : <Menu size={18} />}
      </button>
      {drawer && (
        <button
          className="drawer-backdrop"
          onClick={() => setDrawer(false)}
          aria-label="点击遮罩关闭导航"
        />
      )}
      <aside className={`sidebar ${drawer ? "drawer-open" : ""}`}>
        <div className="sidebar-top">
          <Brand compact={collapsed} />
          <button
            className="icon-button collapse-button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav aria-label="主导航">
          <button
            className={active === "home" ? "active" : ""}
            onClick={() => go("/home")}
            title="首页"
          >
            <Home size={18} />
            {!collapsed && <span>首页</span>}
          </button>
          <button
            className={active === "projects" || active === "project" ? "active" : ""}
            onClick={() => go("/projects")}
            title="我的项目"
          >
            <FolderKanban size={18} />
            {!collapsed && <span>我的项目</span>}
          </button>
        </nav>
        <div className="sidebar-guest">
          <GuestMenu
            guest={guest}
            locked={projectLocked}
            onChange={projectLocked ? undefined : onGuestChange}
          />
        </div>
      </aside>
      <main inert={drawer ? true : undefined}>{children}</main>
    </div>
  );
}
