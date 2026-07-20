import type { ConversationItem, ConversationTurn } from "./types";

const terminalStatuses = new Set<ConversationTurn["status"]>([
  "completed",
  "failed",
  "cancelled"
]);

function mergeItems(
  current: ConversationItem[],
  incoming: ConversationItem[]
): ConversationItem[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()].sort((left, right) => left.ordinal - right.ordinal);
}

export function mergeConversationTurn(
  current: ConversationTurn,
  incoming: ConversationTurn
): ConversationTurn {
  const currentTerminal = terminalStatuses.has(current.status);
  const incomingTerminal = terminalStatuses.has(incoming.status);

  if (currentTerminal && !incomingTerminal) return current;
  if (current.status === "running" && incoming.status === "queued") {
    return {
      ...current,
      items: mergeItems(current.items, incoming.items)
    };
  }
  if (currentTerminal && incomingTerminal && current.status !== incoming.status) {
    return current;
  }

  return {
    ...incoming,
    items: mergeItems(current.items, incoming.items)
  };
}

export function promoteTurnForActivity(turn: ConversationTurn): ConversationTurn {
  return turn.status === "queued" ? { ...turn, status: "running" } : turn;
}
