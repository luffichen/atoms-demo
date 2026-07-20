import { ImagePlus, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  MAX_IMAGE_BYTES,
  validateImage,
  validateMessageText
} from "../../server/domain/validation";
import { isImageUploadError } from "../image-upload";

type PendingImage = {
  id: string;
  file: File;
  url: string;
  status: "queued" | "uploading" | "uploaded" | "failed";
  progress: number;
  uploadId?: string;
  error?: string;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  onUpload,
  onRemoveUpload,
  onStop,
  running = false,
  busy = false,
  queueFull = false,
  placeholder = "描述你想创建的应用",
  autoFocus = false
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (images: File[], uploadIds?: string[]) => Promise<void>;
  onUpload?: (
    file: File,
    onProgress: (progress: number) => void
  ) => Promise<{ id: string }>;
  onRemoveUpload?: (uploadId: string) => Promise<void>;
  onStop?: () => void;
  running?: boolean;
  busy?: boolean;
  queueFull?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<PendingImage[]>([]);
  const validation = validateMessageText(value);
  const hasFailedImage = images.some((image) => image.status === "failed");
  const hasPendingUpload = images.some(
    (image) => image.status === "queued" || image.status === "uploading"
  );
  const blocked =
    busy || queueFull || !validation.valid || hasFailedImage || hasPendingUpload;
  const stopMode = running && value.trim().length === 0;

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.url);
  }, []);

  useEffect(() => {
    if (!onUpload) return;
    const available = Math.max(
      0,
      3 - images.filter(({ status }) => status === "uploading").length
    );
    const queued = images
      .filter(({ status }) => status === "queued")
      .slice(0, available);
    for (const image of queued) {
      setImages((current) =>
        current.map((candidate) =>
          candidate.id === image.id
            ? { ...candidate, status: "uploading", progress: 0, error: undefined }
            : candidate
        )
      );
      void onUpload(image.file, (progress) => {
        setImages((current) =>
          current.map((candidate) =>
            candidate.id === image.id
              ? { ...candidate, progress }
              : candidate
          )
        );
      }).then(
        ({ id: uploadId }) => {
          setImages((current) => {
            if (!current.some(({ id }) => id === image.id)) {
              void onRemoveUpload?.(uploadId);
              return current;
            }
            const next: PendingImage[] = current.map((candidate) =>
              candidate.id === image.id
                ? {
                    ...candidate,
                    status: "uploaded",
                    progress: 100,
                    uploadId,
                    error: undefined
                  }
                : candidate
            );
            setImageError(next.find(({ error }) => error)?.error ?? "");
            return next;
          });
        },
        (reason) => {
          const message =
            reason instanceof Error
              ? `图片“${image.file.name}”上传失败：${reason.message}`
              : `图片“${image.file.name}”上传失败`;
          setImages((current) =>
            current.map((candidate) =>
              candidate.id === image.id
                ? { ...candidate, status: "failed", error: message }
                : candidate
            )
          );
          setImageError(message);
        }
      );
    }
  }, [images, onRemoveUpload, onUpload]);

  const add = (files: File[]) => {
    const accepted: PendingImage[] = [];
    let count = images.length;
    let lastError = "";
    for (const file of files) {
      const result = validateImage(file, count);
      if (!result.valid) {
        lastError = result.message;
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
        status: onUpload ? "queued" : "uploaded",
        progress: onUpload ? 0 : 100
      });
      count += 1;
    }
    setImages((current) => [...current, ...accepted]);
    setImageError(lastError);
  };

  const submit = async (retryFailedImages = false) => {
    if (
      busy
      || queueFull
      || !validation.valid
      || (!retryFailedImages && hasFailedImage)
    ) return;
    if (retryFailedImages) {
      setImages((current) =>
        current.map((image) => ({
          ...image,
          status: onUpload ? image.status : "uploaded",
          error: undefined
        }))
      );
      setImageError("");
    }
    try {
      if (onUpload) {
        await onSubmit(
          [],
          images.flatMap(({ uploadId }) => uploadId ? [uploadId] : [])
        );
      } else {
        await onSubmit(images.map(({ file }) => file));
      }
    } catch (reason) {
      if (isImageUploadError(reason)) {
        setImages((current) => current.map((image, index) => (
          index === reason.failedImageIndex
            ? { ...image, status: "failed", error: reason.message }
            : { ...image, status: "uploaded", error: undefined }
        )));
        setImageError(reason.message);
      }
      return;
    }
    for (const image of images) URL.revokeObjectURL(image.url);
    setImages([]);
    setImageError("");
  };

  return (
    <div className="composer" onPaste={(event) => add(Array.from(event.clipboardData.files))}>
      {images.length > 0 && (
        <div className="pending-images">
          {images.map((image) => (
            <div
              className={`pending-image ${image.status === "failed" ? "failed" : ""}`}
              key={image.id}
            >
              <div className="pending-image-preview">
                <img src={image.url} alt={image.file.name} />
                <button
                  className="pending-image-remove"
                  aria-label={`移除 ${image.file.name}`}
                  onClick={() => {
                    URL.revokeObjectURL(image.url);
                    if (image.uploadId) void onRemoveUpload?.(image.uploadId);
                    setImages((current) => {
                      const next = current.filter(({ id }) => id !== image.id);
                      setImageError(next.find((item) => item.error)?.error ?? "");
                      return next;
                    });
                  }}
                >
                  <X size={13} />
                </button>
              </div>
              {image.status === "uploading" && (
                <div
                  className="pending-image-progress"
                  role="progressbar"
                  aria-label={`${image.file.name} 上传进度`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={image.progress}
                >
                  <i style={{ width: `${image.progress}%` }} />
                  <span>{image.progress}%</span>
                </div>
              )}
              {image.status === "queued" && (
                <span className="pending-image-state">等待上传</span>
              )}
              {image.status === "uploaded" && onUpload && (
                <span className="pending-image-state">已上传</span>
              )}
              {image.status === "failed" && (
                <button
                  className="pending-image-retry"
                  aria-label={`重试 ${image.file.name}`}
                  title={image.error}
                  onClick={() => {
                    if (onUpload) {
                      setImages((current) => {
                        const next: PendingImage[] = current.map((candidate) =>
                          candidate.id === image.id
                            ? {
                                ...candidate,
                                status: "queued",
                                progress: 0,
                                error: undefined
                              }
                            : candidate
                        );
                        setImageError(next.find(({ error }) => error)?.error ?? "");
                        return next;
                      });
                    } else {
                      void submit(true);
                    }
                  }}
                >
                  重试
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <label className="sr-only" htmlFor="requirement-input">
        {placeholder}
      </label>
      <textarea
        id="requirement-input"
        ref={input}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-footer">
        <div>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            hidden
            onChange={(event) => {
              add(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button
            className="icon-button attach-button"
            onClick={() => picker.current?.click()}
            aria-label="添加图片"
            title={`添加 PNG/JPEG（单张不超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB）`}
          >
            <ImagePlus size={18} />
          </button>
        </div>
        <div className="composer-status">
          {queueFull ? (
            <span className="error-text">队列已满</span>
          ) : imageError ? (
            <span className="error-text" role="alert">{imageError}</span>
          ) : !validation.valid && value.length > 0 ? (
            <span className="error-text">{validation.message}</span>
          ) : (
            <span>{validation.visibleCharacters.toLocaleString("zh-CN")} / 10,000</span>
          )}
          <button
            className={`send-button ${stopMode ? "stop-button" : ""}`}
            onClick={() => {
              if (stopMode) onStop?.();
              else void submit();
            }}
            disabled={stopMode ? busy || !onStop : blocked}
            aria-label={stopMode ? "停止当前任务" : "发送"}
            title={stopMode ? "停止当前任务" : "发送"}
          >
            {stopMode
              ? <Square size={14} fill="currentColor" />
              : busy
                ? <span className="spinner" />
                : <Send size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
