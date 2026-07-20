import { Code2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Shell } from "../components/Shell";
import { LocalTime } from "../components/Time";
import { navigate } from "../lib";
import type { Guest, Project } from "../types";

export function ProjectsPage({
  guest,
  onGuestChange
}: {
  guest: Guest;
  onGuestChange: (guest: Guest) => void;
}) {
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const nextOffset = useRef(0);

  const load = async (append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    const offset = append ? nextOffset.current : 0;
    try {
      const response = await api.projects(guest.id, offset);
      nextOffset.current = offset + response.items.length;
      setItems((current) => {
        if (!append) return response.items;
        const known = new Set(current.map(({ id }) => id));
        return [...current, ...response.items.filter(({ id }) => !known.has(id))];
      });
      setHasMore(response.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目加载失败");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => void load(), [guest.id]);

  return (
    <Shell guest={guest} active="projects" onGuestChange={onGuestChange}>
      <div className="projects-page">
        <header className="page-header">
          <div>
            <h1>我的项目</h1>
            <p>{guest.name} 创建和继续修改的项目</p>
          </div>
          <button className="button primary" onClick={() => navigate("/home?focus=composer")}>
            <Plus size={17} /> 新建项目
          </button>
        </header>
        {loading ? (
          <div className="project-skeleton-grid" aria-label="正在加载项目">
            {Array.from({ length: 6 }, (_, index) => <div className="project-skeleton" key={index} />)}
          </div>
        ) : error && !items.length ? (
          <div className="error-state large">
            <span>项目加载失败：{error}</span>
            <button className="button secondary" onClick={() => void load()}>
              <RefreshCw size={16} /> 重试
            </button>
          </div>
        ) : !items.length ? (
          <div className="empty-projects">
            <span className="empty-icon"><Code2 size={24} /></span>
            <h2>暂无项目</h2>
            <p>从一个清晰的想法开始，luffi 会为你构建第一版。</p>
            <button className="button primary" onClick={() => navigate("/home?focus=composer")}>
              创建第一个项目
            </button>
          </div>
        ) : (
          <>
            <div className="project-grid">
              {items.map((project) => (
                <button
                  className="project-card"
                  key={project.id}
                  onClick={() => navigate(`/projects/${project.id}`)}
                >
                  <span className="project-preview">
                    {project.thumbnailUrl ? (
                      <img src={project.thumbnailUrl} alt={`${project.name}预览`} />
                    ) : project.previewCapable
                      && (project.previewStatus === "starting" || project.previewStatus === "ready") ? (
                      <span
                        className="preview-placeholder loading"
                        aria-label={`${project.name}：正在生成预览`}
                      >
                        <span className="spinner" aria-hidden="true" />
                        正在生成预览
                      </span>
                    ) : project.previewCapable ? (
                      <span
                        className="preview-placeholder"
                        aria-label={`${project.name}：暂无预览`}
                      >
                        暂无预览
                      </span>
                    ) : (
                      <span
                        className="code-placeholder"
                        aria-label={`${project.name}：代码项目`}
                      >
                        <Code2 size={28} />
                      </span>
                    )}
                  </span>
                  <span className="project-card-info">
                    <strong>{project.name}</strong>
                    <small className="project-version-summary">
                      {project.activeWorkItem
                        ? project.activeWorkItem.type === "structured_requirement"
                          ? `R${String(project.activeWorkItem.requirementSequence).padStart(3, "0")} · ${project.activeWorkItem.workflowState}`
                          : "直接编码 · 有未发布改动"
                        : project.currentCodeVersion
                          ? `当前正式版本 V${project.currentCodeVersion.sequence}`
                          : "尚未发布版本"}
                    </small>
                    <LocalTime value={project.updatedAt} />
                  </span>
                </button>
              ))}
            </div>
            {error && <p className="error-text centered" role="alert">加载更多失败：{error}</p>}
            {hasMore && (
              <div className="load-more">
                <button className="button secondary" disabled={loadingMore} onClick={() => void load(true)}>
                  {loadingMore ? "正在加载…" : error ? "重试加载" : "加载更多"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
