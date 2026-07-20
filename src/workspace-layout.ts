export const MIN_CONVERSATION_WIDTH = 320;
export const MIN_WORKSPACE_WIDTH = 480;
export const WORKSPACE_RESIZER_WIDTH = 5;

export function clampConversationRatio(ratio: number, containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return ratio;
  const minimum = (MIN_CONVERSATION_WIDTH / containerWidth) * 100;
  const maximum =
    ((containerWidth - MIN_WORKSPACE_WIDTH - WORKSPACE_RESIZER_WIDTH) / containerWidth) * 100;
  return Math.min(maximum, Math.max(minimum, ratio));
}
