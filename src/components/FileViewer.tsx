import {
  type Ref,
  type UIEventHandler,
  useEffect,
  useMemo,
  useState
} from "react";
import type { FileView } from "../types";
import {
  appendPlainText,
  createSyntaxDocument,
  detectLanguage
} from "../syntax";

export type FileViewerState = "idle" | "loading" | "ready" | "error";

function FileHeader({
  path,
  label,
  status
}: {
  path: string;
  label: string;
  status?: string;
}) {
  return (
    <div className="file-viewer-header">
      <span title={path}>{path}</span>
      <div>
        {status && <small>{status}</small>}
        <strong>{label}</strong>
      </div>
    </div>
  );
}

function TextFile({
  path,
  content,
  streaming
}: {
  path: string;
  content: string;
  streaming: boolean;
}) {
  const language = useMemo(() => detectLanguage(path, content), [content, path]);
  const [document, setDocument] = useState(() =>
    createSyntaxDocument(path, content, language)
  );

  useEffect(() => {
    const update = () => setDocument(createSyntaxDocument(path, content, language));
    if (!streaming) {
      update();
      return;
    }
    const timer = window.setTimeout(update, 100);
    return () => window.clearTimeout(timer);
  }, [content, language, path, streaming]);

  const visibleDocument = useMemo(() => {
    if (document.source === content) return document;
    return appendPlainText(document, content);
  }, [content, document]);
  const status =
    visibleDocument.fallback === "large"
      ? "文件较大，已关闭语法高亮"
      : visibleDocument.fallback === "error"
        ? "高亮不可用"
        : undefined;

  return (
    <>
      <FileHeader path={path} label={language.label} status={status} />
      <div className="code-view" style={{ tabSize: 2 }}>
        {visibleDocument.lines.map((line, index) => (
          <div className="code-line" key={index}>
            <span aria-hidden="true">{index + 1}</span>
            <code>
              {line.length
                ? line.map((segment, segmentIndex) => (
                    <span
                      className={segment.classes.join(" ") || undefined}
                      key={`${segmentIndex}-${segment.text.length}`}
                    >
                      {segment.text}
                    </span>
                  ))
                : " "}
            </code>
          </div>
        ))}
      </div>
    </>
  );
}

export function FileViewer({
  path,
  file,
  state,
  error = "",
  streaming = false,
  contentRef,
  onScroll
}: {
  path: string | null;
  file: FileView | null;
  state: FileViewerState;
  error?: string;
  streaming?: boolean;
  contentRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      aria-label={path ? `文件内容：${path}` : "文件内容"}
      className="file-content"
      onScroll={onScroll}
      ref={contentRef}
      role="region"
      tabIndex={0}
    >
      {!path || state === "idle" ? (
        <div className="viewer-empty">请选择文件</div>
      ) : state === "loading" ? (
        <>
          <FileHeader path={path} label="加载中" />
          <div className="viewer-empty" role="status">正在加载文件…</div>
        </>
      ) : state === "error" ? (
        <>
          <FileHeader path={path} label="加载失败" />
          <div className="viewer-empty" role="alert">
            <h2>{path.split("/").at(-1)}</h2>
            <p>{error || "文件加载失败"}</p>
          </div>
        </>
      ) : file?.kind === "text" ? (
        <TextFile content={file.content} path={file.path} streaming={streaming} />
      ) : file?.kind === "image" ? (
        <>
          <FileHeader path={file.path} label={file.mimeType} />
          <div className="image-file-view">
            <img
              alt={file.name}
              src={`data:${file.mimeType};base64,${file.data}`}
            />
          </div>
        </>
      ) : file ? (
        <>
          <FileHeader
            path={file.path}
            label={file.kind === "large" ? "大型文本" : "二进制文件"}
          />
          <div className="viewer-empty">
            <h2>{file.name}</h2>
            <p>{file.message}</p>
            <small>{file.size.toLocaleString()} bytes</small>
          </div>
        </>
      ) : (
        <div className="viewer-empty">请选择文件</div>
      )}
    </div>
  );
}
