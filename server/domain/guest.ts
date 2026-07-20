const GUEST_NAME_PATTERN = /^[\p{Script=Han}A-Za-z0-9_-]+$/u;
export const MAX_CUSTOM_GUESTS = 100;

export type GuestNameValidation =
  | { valid: true; name: string }
  | { valid: false; code: "required" | "too_long" | "invalid_characters" | "reserved"; message: string };

export function validateGuestName(input: string): GuestNameValidation {
  if (!input) {
    return { valid: false, code: "required", message: "请输入游客名称" };
  }
  if (Array.from(input).length > 20) {
    return { valid: false, code: "too_long", message: "游客名称最多 20 个字符" };
  }
  if (!GUEST_NAME_PATTERN.test(input)) {
    return {
      valid: false,
      code: "invalid_characters",
      message: "仅支持中文、英文字母、数字、短横线和下划线"
    };
  }
  if (input.toLocaleLowerCase("en-US") === "default") {
    return { valid: false, code: "reserved", message: "default 是系统保留名称" };
  }
  return { valid: true, name: input };
}

export function normalizeGuestName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

export function compareGuests(a: { name: string }, b: { name: string }): number {
  if (a.name === "default") return b.name === "default" ? 0 : -1;
  if (b.name === "default") return 1;
  return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
}
