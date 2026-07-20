import type { WorkItemType } from "./types";

const STORAGE_KEY = "atoms.workMode";

export class WorkCreationConfirmationRequired extends Error {
  constructor() {
    super("等待确认创建结构化需求");
    this.name = "WorkCreationConfirmationRequired";
  }
}

export function rememberedWorkMode(): WorkItemType {
  return localStorage.getItem(STORAGE_KEY) === "structured_requirement"
    ? "structured_requirement"
    : "direct_coding";
}

export function rememberWorkMode(mode: WorkItemType): void {
  localStorage.setItem(STORAGE_KEY, mode);
}
