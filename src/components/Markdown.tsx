import { marked } from "marked";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }) {
  return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>`;
};
renderer.link = ({ href, title, text }) => {
  const safeHref = /^https?:\/\//i.test(href) ? href : "#";
  return `<a href="${escapeHtml(safeHref)}"${title ? ` title="${escapeHtml(title)}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
renderer.image = ({ text }) => escapeHtml(text);
renderer.html = ({ text }) => `<pre><code>${escapeHtml(text)}</code></pre>`;

export function Markdown({ content }: { content: string }) {
  const html = marked.parse(content, { renderer, async: false }) as string;
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
