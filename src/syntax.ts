import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-css";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-go";
import "prismjs/components/prism-ignore";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-properties";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";

export const MAX_HIGHLIGHT_BYTES = 200 * 1024;
export const MAX_HIGHLIGHT_LINES = 5_000;

export interface LanguageDefinition {
  id: string;
  label: string;
  grammar: string | null;
}

export interface SyntaxSegment {
  text: string;
  classes: string[];
}

export interface SyntaxDocument {
  source: string;
  lines: SyntaxSegment[][];
  highlighted: boolean;
  fallback: "large" | "error" | null;
}

const PLAIN_TEXT: LanguageDefinition = {
  id: "text",
  label: "纯文本",
  grammar: null
};

const LANGUAGES: Record<string, LanguageDefinition> = {
  ts: { id: "typescript", label: "TypeScript", grammar: "typescript" },
  tsx: { id: "tsx", label: "TSX", grammar: "tsx" },
  js: { id: "javascript", label: "JavaScript", grammar: "javascript" },
  jsx: { id: "jsx", label: "JSX", grammar: "jsx" },
  json: { id: "json", label: "JSON", grammar: "json" },
  css: { id: "css", label: "CSS", grammar: "css" },
  html: { id: "html", label: "HTML", grammar: "markup" },
  htm: { id: "html", label: "HTML", grammar: "markup" },
  xml: { id: "xml", label: "XML", grammar: "markup" },
  svg: { id: "xml", label: "XML", grammar: "markup" },
  md: { id: "markdown", label: "Markdown", grammar: "markdown" },
  markdown: { id: "markdown", label: "Markdown", grammar: "markdown" },
  py: { id: "python", label: "Python", grammar: "python" },
  go: { id: "go", label: "Go", grammar: "go" },
  rs: { id: "rust", label: "Rust", grammar: "rust" },
  sh: { id: "shell", label: "Shell", grammar: "bash" },
  bash: { id: "shell", label: "Shell", grammar: "bash" },
  zsh: { id: "shell", label: "Shell", grammar: "bash" },
  yaml: { id: "yaml", label: "YAML", grammar: "yaml" },
  yml: { id: "yaml", label: "YAML", grammar: "yaml" },
  toml: { id: "toml", label: "TOML", grammar: "toml" },
  sql: { id: "sql", label: "SQL", grammar: "sql" }
};

const SPECIAL_FILES: Record<string, LanguageDefinition> = {
  dockerfile: { id: "dockerfile", label: "Dockerfile", grammar: "docker" },
  ".gitignore": { id: "gitignore", label: "Git ignore", grammar: "ignore" }
};

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

export function detectLanguage(path: string, content = ""): LanguageDefinition {
  const name = fileName(path);
  if (SPECIAL_FILES[name]) return SPECIAL_FILES[name];
  if (name === ".env" || name.startsWith(".env.")) {
    return { id: "dotenv", label: "Environment", grammar: "properties" };
  }
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  if (LANGUAGES[extension]) return LANGUAGES[extension];

  const firstLine = content.split(/\r?\n/u, 1)[0] ?? "";
  if (/^#!.*(?:python|python3)\b/iu.test(firstLine)) return LANGUAGES.py;
  if (/^#!.*(?:node|nodejs)\b/iu.test(firstLine)) return LANGUAGES.js;
  if (/^#!.*(?:ba|z|k)?sh\b/iu.test(firstLine) || /^#!\/bin\/sh\b/iu.test(firstLine)) {
    return LANGUAGES.sh;
  }
  return PLAIN_TEXT;
}

function aliases(token: Prism.Token): string[] {
  if (!token.alias) return [];
  return Array.isArray(token.alias) ? token.alias : [token.alias];
}

function flatten(
  stream: Prism.TokenStream,
  output: SyntaxSegment[],
  inherited: string[] = []
): void {
  if (typeof stream === "string") {
    if (stream) output.push({ text: stream, classes: inherited });
    return;
  }
  if (Array.isArray(stream)) {
    for (const value of stream) flatten(value, output, inherited);
    return;
  }
  flatten(stream.content, output, [...inherited, "token", stream.type, ...aliases(stream)]);
}

export function plainLines(content: string): SyntaxSegment[][] {
  const lines: SyntaxSegment[][] = [[]];
  const segments: SyntaxSegment[] = [{ text: content, classes: [] }];
  for (const segment of segments) {
    const parts = segment.text.split(/\r\n|\n|\r/u);
    parts.forEach((part, index) => {
      if (part) lines[lines.length - 1].push({ ...segment, text: part });
      if (index < parts.length - 1) lines.push([]);
    });
  }
  if (content && /(?:\r\n|\n|\r)$/u.test(content) && lines.length > 1) lines.pop();
  return lines;
}

function linesFromSegments(content: string, segments: SyntaxSegment[]): SyntaxSegment[][] {
  const lines: SyntaxSegment[][] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split(/\r\n|\n|\r/u);
    parts.forEach((part, index) => {
      if (part) lines[lines.length - 1].push({ ...segment, text: part });
      if (index < parts.length - 1) lines.push([]);
    });
  }
  if (content && /(?:\r\n|\n|\r)$/u.test(content) && lines.length > 1) lines.pop();
  return lines;
}

function lineCount(content: string): number {
  let count = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (
      content[index] === "\n" ||
      (content[index] === "\r" && content[index + 1] !== "\n")
    ) {
      count += 1;
    }
  }
  return count;
}

export function createSyntaxDocument(
  path: string,
  content: string,
  language = detectLanguage(path, content)
): SyntaxDocument {
  const tooLarge =
    new TextEncoder().encode(content).byteLength > MAX_HIGHLIGHT_BYTES ||
    lineCount(content) > MAX_HIGHLIGHT_LINES;
  if (!language.grammar || tooLarge) {
    return {
      source: content,
      lines: plainLines(content),
      highlighted: false,
      fallback: tooLarge ? "large" : null
    };
  }
  try {
    const grammar = Prism.languages[language.grammar];
    if (!grammar) throw new Error(`Missing Prism grammar: ${language.grammar}`);
    const segments: SyntaxSegment[] = [];
    flatten(Prism.tokenize(content, grammar), segments);
    return {
      source: content,
      lines: linesFromSegments(content, segments),
      highlighted: true,
      fallback: null
    };
  } catch (error) {
    console.error("Syntax highlighting failed", error);
    return {
      source: content,
      lines: plainLines(content),
      highlighted: false,
      fallback: "error"
    };
  }
}

export function appendPlainText(
  document: SyntaxDocument,
  source: string
): SyntaxDocument {
  if (!source.startsWith(document.source)) {
    return { source, lines: plainLines(source), highlighted: false, fallback: null };
  }
  const suffix = source.slice(document.source.length);
  if (!suffix) return document;
  const pending = plainLines(suffix);
  const lines = document.lines.map((line) => [...line]);
  if (lines.length === 0) lines.push([]);
  lines[lines.length - 1].push(...(pending[0] ?? []));
  lines.push(...pending.slice(1));
  return { ...document, source, lines };
}
