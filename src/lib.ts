export function navigate(path: string): void {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function formatLocalTime(value: string): { short: string; full: string } {
  const date = new Date(value);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const short = sameDay
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(date)
    : [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
      ].join("/");
  return {
    short,
    full: new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "full",
      timeStyle: "medium"
    }).format(date)
  };
}

export function avatarText(name: string): string {
  return name === "default" ? "D" : Array.from(name)[0]?.toLocaleUpperCase() ?? "?";
}
