import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import type { FileTreeNode } from "../types";

function Node({
  node,
  selected,
  onSelect
}: {
  node: FileTreeNode;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (selected?.startsWith(`${node.path}/`)) setOpen(true);
  }, [node.path, selected]);
  if (node.type === "directory") {
    return (
      <li>
        <button className="tree-row" onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Folder size={15} />
          <span>{node.name}</span>
        </button>
        {open && node.children && (
          <ul>
            {node.children.map((child) => (
              <Node key={child.path} node={child} selected={selected} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button
        className={`tree-row file-row ${selected === node.path ? "selected" : ""}`}
        onClick={() => onSelect(node.path)}
      >
        <span className="tree-indent" />
        <File size={15} />
        <span>{node.name}</span>
        {node.change && (
          <small className={`file-change ${node.change}`}>
            {node.change === "new" ? "新建" : "更新"}
          </small>
        )}
      </button>
    </li>
  );
}

export function FileTree({
  items,
  selected,
  onSelect
}: {
  items: FileTreeNode[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="file-tree">
      {items.map((node) => (
        <Node key={node.path} node={node} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}
