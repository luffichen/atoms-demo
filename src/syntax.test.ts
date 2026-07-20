import {
  MAX_HIGHLIGHT_BYTES,
  createSyntaxDocument,
  detectLanguage
} from "./syntax";
import { describe, expect, it } from "vitest";

describe("syntax highlighting", () => {
  it("detects extensions, special names, and supported shebangs", () => {
    expect(detectLanguage("src/app.tsx").id).toBe("tsx");
    expect(detectLanguage("Dockerfile").id).toBe("dockerfile");
    expect(detectLanguage(".env.local").id).toBe("dotenv");
    expect(detectLanguage("script", "#!/usr/bin/env python3\nprint('ok')").id).toBe(
      "python"
    );
    expect(detectLanguage("notes.custom", "plain text").id).toBe("text");
  });

  it("creates safe token segments and omits a synthetic trailing line", () => {
    const document = createSyntaxDocument(
      "app.ts",
      "const answer: number = 42;\n"
    );
    expect(document.highlighted).toBe(true);
    expect(document.lines).toHaveLength(1);
    expect(
      document.lines[0].some(({ classes }) => classes.includes("keyword"))
    ).toBe(true);
    expect(document.lines[0].map(({ text }) => text).join("")).toBe(
      "const answer: number = 42;"
    );
  });

  it("falls back to complete plain text above the highlight threshold", () => {
    const content = "a".repeat(MAX_HIGHLIGHT_BYTES + 1);
    const document = createSyntaxDocument("large.ts", content);
    expect(document.highlighted).toBe(false);
    expect(document.fallback).toBe("large");
    expect(document.lines[0][0].text).toBe(content);
  });
});
