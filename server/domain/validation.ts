export const MAX_MESSAGE_CHARACTERS = 10_000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);

export type ValidationResult =
  | { valid: true; visibleCharacters: number }
  | { valid: false; code: "required" | "too_long"; message: string; visibleCharacters: number };

export function countVisibleCharacters(value: string): number {
  return Array.from(value).length;
}

export function validateMessageText(value: string): ValidationResult {
  const visibleCharacters = countVisibleCharacters(value);
  if (!value.trim()) {
    return {
      valid: false,
      code: "required",
      message: "请输入文字需求",
      visibleCharacters
    };
  }
  if (visibleCharacters > MAX_MESSAGE_CHARACTERS) {
    return {
      valid: false,
      code: "too_long",
      message: `内容过长，最多 ${MAX_MESSAGE_CHARACTERS.toLocaleString("zh-CN")} 个字符`,
      visibleCharacters
    };
  }
  return { valid: true, visibleCharacters };
}

export type ImageValidationInput = {
  type: string;
  size: number;
};

export type ImageValidationResult =
  | { valid: true }
  | { valid: false; code: "unsupported_type" | "too_large"; message: string };

export function validateImage(
  image: ImageValidationInput,
  _acceptedCount = 0
): ImageValidationResult {
  if (!ALLOWED_IMAGE_TYPES.has(image.type)) {
    return { valid: false, code: "unsupported_type", message: "仅支持 PNG 和 JPEG 图片" };
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return { valid: false, code: "too_large", message: "单张图片不能超过 10 MB" };
  }
  return { valid: true };
}
