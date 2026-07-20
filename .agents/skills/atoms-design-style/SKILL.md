---
name: atoms-design-style
description: Apply the Atoms-inspired visual system consistently when creating, editing, or reviewing this project's frontend. Use for page layouts, app shells, dashboards, project lists, chat/workbench interfaces, forms, cards, navigation, responsive behavior, component styling, design tokens, and visual QA. Trigger whenever a request asks to build or restyle UI, add a frontend component, match the project's design, or keep the product visually consistent.
---

# Atoms Design Style

Build a quiet, professional AI-product workspace: near-achromatic surfaces, compact typography, soft geometry, scarce blue emphasis, and clear information hierarchy.

## Workflow

1. Inspect the existing frontend stack, global styles, tokens, and reusable components before editing.
2. Read [references/design-system.md](references/design-system.md) before making visual decisions.
3. Choose the relevant layout pattern:
   - project home/dashboard: top bar + centered content + project card grid;
   - focused creation flow: centered single-column task surface;
   - builder/workbench: compact app chrome + navigation/chat pane + primary canvas + optional inspector;
   - settings/data management: compact sidebar + content header + flat sections or tables.
4. Reuse existing primitives. If shadcn/ui already exists, theme its source components instead of adding parallel components. Do not add a new UI dependency merely for styling.
5. Map the design to semantic tokens rather than scattering literal values. Copy or merge [assets/atoms-theme.css](assets/atoms-theme.css) when the project has no equivalent token layer.
6. Implement all relevant states: default, hover, active/selected, focus-visible, disabled, loading, empty, and error.
7. Check the result at mobile, tablet, and desktop widths. Preserve task hierarchy before decorative fidelity.
8. Run the visual QA checklist in the reference before finishing.

## Non-negotiable rules

- Use one accent voice: `#4267ff`. Reserve it for the primary action, selected state, focus, link, or small status emphasis.
- Use `#0d0d0d` for primary text instead of pure black.
- Build with the surface stack: soft gray canvas, white primary surfaces, fog-gray recessed areas.
- Use IBM Plex Sans when available; otherwise use the project's existing sans or Inter/system UI.
- Keep product UI type compact: 14px body/control text, 12px metadata, 20–24px page titles.
- Use 8px controls, 12–16px panels, and 20–24px promotional/project cards. Use pill radii only for chips, segmented filters, compact badges, and standalone actions.
- Prefer 1px borders and subtle shadows. Do not put a floating shadow on every panel.
- Use small monoline icons, usually 16–18px. Always pair unfamiliar icons with labels or tooltips.
- Keep animation restrained: 120–200ms color, border, opacity, and small transform transitions. Respect reduced motion.
- Keep blue regions small. Avoid gradients, glassmorphism, neon glows, oversized type, excessive pills, and decorative color.

## Context rule

The serif 48px display treatment belongs only to a public landing-page hero. Never use it in the authenticated dashboard, builder, settings, dialogs, cards, or routine page headings.

## Implementation notes

- Preserve the project's established framework and conventions.
- Prefer semantic names such as `background`, `surface`, `muted`, `foreground`, `border`, `primary`, and `ring`.
- For Tailwind/shadcn, bind those semantic roles to CSS variables; avoid one-off arbitrary colors when a token exists.
- For Chinese UI, allow slightly taller line-height and verify truncation with realistic Chinese copy.
- Treat the reference as a coherent design grammar, not a mandate to copy Atoms branding or proprietary assets.
