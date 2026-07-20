import { useState } from "react";
import { api } from "../api";
import { Composer } from "../components/Composer";
import { Shell } from "../components/Shell";
import { navigate } from "../lib";
import type { Guest } from "../types";
import type { WorkItemType } from "../types";
import {
  rememberedWorkMode,
  rememberWorkMode,
  WorkCreationConfirmationRequired
} from "../work-mode";

export function HomePage({
  guest,
  onGuestChange
}: {
  guest: Guest;
  onGuestChange: (guest: Guest) => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<WorkItemType>(rememberedWorkMode);
  const [pendingCreation, setPendingCreation] = useState<{
    images: File[];
    uploadIds: string[];
  } | null>(null);
  const focus = new URLSearchParams(location.search).get("focus") === "composer";

  const submit = async (images: File[], uploadIds: string[] = []) => {
    if (mode === "structured_requirement") {
      setPendingCreation({ images, uploadIds });
      throw new WorkCreationConfirmationRequired();
    }
    setSubmitting(true);
    setError("");
    try {
      const { project } = await api.createProject(
        guest.id,
        draft,
        images,
        mode,
        uploadIds
      );
      setDraft("");
      navigate(`/projects/${project.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目创建失败");
      throw reason;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Shell guest={guest} active="home" onGuestChange={onGuestChange}>
      <div className="home-page">
        <section className="home-content">
          <div className="home-heading">
            <span className="agent-orbit" aria-hidden="true"><i /></span>
            <h1>输入想法，生成应用。开始吧，{guest.name}。</h1>
            <p>描述目标，luffi 会真实创建项目、编写代码并展示执行过程。</p>
          </div>
          <div className="work-mode-switch" aria-label="工作模式">
            <button
              type="button"
              className={mode === "direct_coding" ? "active" : ""}
              onClick={() => {
                setMode("direct_coding");
                rememberWorkMode("direct_coding");
              }}
            >
              直接编码
              <small>快速实现并按需发布版本</small>
            </button>
            <button
              type="button"
              className={mode === "structured_requirement" ? "active" : ""}
              onClick={() => {
                setMode("structured_requirement");
                rememberWorkMode("structured_requirement");
              }}
            >
              需求规划
              <small>需求文档 → 技术方案 → 开发测试</small>
            </button>
          </div>
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            onUpload={(file, onProgress) => api.uploadImage(guest.id, file, onProgress)}
            onRemoveUpload={(uploadId) => api.deleteUpload(guest.id, uploadId)}
            busy={submitting}
            autoFocus={focus}
          />
          {submitting && <p className="submit-status">正在创建项目…</p>}
          {error && <p className="error-text centered">{error}</p>}
        </section>
      </div>
      {pendingCreation && (
        <div className="modal-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="create-requirement-title">
            <button className="dialog-close" onClick={() => setPendingCreation(null)} aria-label="关闭">
              ×
            </button>
            <h2 id="create-requirement-title">创建结构化需求？</h2>
            <p>确认后将创建独立需求编号、工作分支和需求访谈对话。</p>
            <div>
              <button className="button secondary" onClick={() => setPendingCreation(null)}>取消</button>
              <button
                className="button primary"
                onClick={async () => {
                  setSubmitting(true);
                  setError("");
                  try {
                    const { project } = await api.createProject(
                      guest.id,
                      draft,
                      pendingCreation.images,
                      "structured_requirement",
                      pendingCreation.uploadIds,
                      true
                    );
                    setPendingCreation(null);
                    setDraft("");
                    navigate(`/projects/${project.id}`);
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : "项目创建失败");
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                确认创建
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
