export type RealtimeKind =
  | "sync"
  | "turn_created"
  | "turn_started"
  | "turn_completed"
  | "item_started"
  | "item_assistant_message_delta"
  | "item_command_output_snapshot"
  | "item_completed"
  | "thinking"
  | "file_create"
  | "file_append"
  | "file_tree"
  | "preview"
  | "notification"
  | "work_item_updated"
  | "version_published";

export interface RealtimeEnvelope<T = unknown> {
  id: string;
  projectId: string;
  kind: RealtimeKind;
  occurredAt: string;
  data: T;
}

type Listener = (event: RealtimeEnvelope) => void;

export class RealtimeHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(projectId: string, listener: Listener): () => void {
    const group = this.listeners.get(projectId) ?? new Set<Listener>();
    group.add(listener);
    this.listeners.set(projectId, group);
    return () => {
      group.delete(listener);
      if (!group.size) this.listeners.delete(projectId);
    };
  }

  publish<T>(
    projectId: string,
    kind: RealtimeKind,
    data: T,
    id: string = crypto.randomUUID()
  ): RealtimeEnvelope<T> {
    const event: RealtimeEnvelope<T> = {
      id,
      projectId,
      kind,
      occurredAt: new Date().toISOString(),
      data
    };
    for (const listener of this.listeners.get(projectId) ?? []) listener(event);
    return event;
  }

  viewerCount(projectId: string): number {
    return this.listeners.get(projectId)?.size ?? 0;
  }
}
