export class ImageUploadError extends Error {
  readonly code = "image_upload_failed";

  constructor(
    public readonly failedImageIndex: number,
    public readonly failedImageName: string,
    message = `图片“${failedImageName}”上传失败`
  ) {
    super(message);
    this.name = "ImageUploadError";
  }
}

export function isImageUploadError(reason: unknown): reason is ImageUploadError {
  return reason instanceof ImageUploadError
    || (
      reason instanceof Error
      && "code" in reason
      && reason.code === "image_upload_failed"
      && "failedImageIndex" in reason
      && typeof reason.failedImageIndex === "number"
    );
}
