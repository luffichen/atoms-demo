# Atoms-inspired product design system

## Source boundary

The supplied `/zh/dashboard` URL redirects unauthenticated visitors to the public Atoms site. This reference combines:

- directly published Atoms style values and visible public-site patterns;
- Atoms' official statement that generated apps use shadcn/ui as their default UI foundation;
- publicly visible Atoms product/workbench screenshots;
- conservative product-UI adaptations for this repository.

Do not reproduce logos, copy, illustrations, avatars, or proprietary screenshots. Reuse the visual grammar.

## Design character

Use the idea “a white atelier with one blue spark.”

- Quiet, nearly achromatic product surfaces.
- One blue-violet accent used with scarcity.
- Soft, generous geometry without looking playful.
- Compact, technical typography.
- Dense enough for a builder tool, but never cramped.
- Structure comes from surface contrast, borders, and spacing—not saturated color.

## Tokens

### Color

| Semantic role | Value | Usage |
|---|---:|---|
| Accent / primary | `#4267ff` | Main action, selected state, focus ring, links |
| Accent hover | `#425ce1` | Hover/pressed state |
| Canvas | `#e5e7eb` | Marketing/project-gallery floor; use sparingly in dense workspaces |
| App background | `#f6f6f6` | Authenticated workspace background |
| Surface | `#ffffff` | Cards, panels, inputs, menus |
| Recessed surface | `#f6f6f6` | Wells, secondary panels, code/output areas |
| Primary text | `#0d0d0d` | Headings, body, active icons |
| Secondary text | `#3c3c3c` | Descriptions and supporting copy |
| Muted text | `#767676` | Metadata, placeholders, helper text |
| Disabled/decorative | `#b0b0b0` | Disabled icons and low-emphasis marks |
| Border | `#d1d1d1` | Controls and stronger dividers |
| Hairline | `#e5e7eb` | Panel and card separators |
| Destructive | existing project red | Errors/destructive actions only; do not use decoratively |

Use status colors only when semantics require them. Keep their backgrounds pale and their text/icons compact. Do not let status colors become a second brand palette.

### Typography

Primary family:

```css
"IBM Plex Sans", Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif
```

Product scale:

| Role | Size / line height | Weight |
|---|---|---:|
| Page title | `24px / 32px` | 600 |
| Section title | `18px / 26px` | 600 |
| Card title | `16px / 24px` | 600 |
| Body | `14px / 22px` | 400 |
| Control label | `14px / 20px` | 500 |
| Caption/metadata | `12px / 18px` | 400–500 |

Only public marketing heroes may use IBM Plex Serif at `48px / 56px`, weight 600, once per page.

### Spacing

Use a 4px base:

- micro: 4px;
- icon/label gap: 8px;
- compact control group: 12px;
- standard component gap: 16px;
- panel padding: 20–24px;
- page section gap: 32–48px;
- marketing section gap: 64px.

Desktop content max width is 1200px. Dense workbench canvas can fill available width.

### Shape and elevation

| Element | Radius |
|---|---:|
| Inputs, icon buttons | 8px |
| Menus, popovers, compact cards | 12px |
| Workspace panels | 12–16px |
| Project/promotional cards | 20–24px |
| Chips and segmented filters | 9999px |

Shadows:

```css
--shadow-sm: 0 1px 4px rgba(13, 13, 13, 0.04);
--shadow-card:
  0 8px 24px -4px rgba(13, 13, 13, 0.08),
  0 4px 4px rgba(13, 13, 13, 0.04);
```

Use `shadow-card` only when a card truly floats above the canvas. App shell panels generally use a border and `shadow-sm` or no shadow.

## Layout patterns

### Project home / dashboard

- Minimal 56–64px top bar.
- Left: brand/project scope. Right: search, utility actions, profile.
- Main content: max-width 1200px, 24px mobile padding, 32px desktop padding.
- Header row: title and supporting copy on the left; one primary action on the right.
- Filter/search row below the title.
- Project grid: 1 column on mobile, 2 on medium widths, 3 on wide screens.
- Project cards use a white surface, 20–24px radius, restrained shadow, 16–24px padding.
- Empty-state “new project” card may use a dashed border, but should remain neutral.

### Builder / chat workspace

- Use a full-height app shell with compact chrome.
- Prefer 240–300px navigation/chat pane, flexible primary canvas, and optional 280–340px inspector.
- Use 1px vertical dividers and white surfaces; avoid three independently floating cards.
- Keep the primary canvas visually dominant.
- Collapse secondary panes into drawers/sheets below 1024px.
- On mobile, show one task surface at a time with explicit back/context controls.

### Settings and data management

- Compact left navigation or tab row.
- Page title and one primary action at the top.
- Group settings into flat white sections with dividers; do not wrap each row in a separate card.
- Use tables for repeated structured data, cards only when items need distinct actions or rich summaries.

### Focused creation flow

- Center a 640–760px content column.
- Use a single white task surface on the fog-gray background.
- Keep progress/status near the heading.
- Place one clear primary action at the end; secondary action is neutral or ghost.

## Components

### Buttons

- Primary: blue background, white text, 36–40px high, 12–16px horizontal padding.
- Secondary: white background, ink text, 1px border.
- Ghost: transparent, ink/secondary text.
- Destructive: semantic red only after intent is clear.
- Use an 8px radius for in-app buttons. Reserve full pills for standalone marketing actions and filter chips.
- One visually dominant primary action per local task region.

### Inputs

- 38–40px control height; textareas size to task.
- White background, 1px border, 8px radius.
- Focus uses the blue ring without changing layout.
- Placeholder uses muted text.
- Keep labels visible. Do not rely on placeholder-only labeling.

### Cards and panels

- Use cards for entities, summaries, or self-contained actions.
- Use panels for workspace regions.
- Project card order: preview/icon → title → metadata/description → recency/actions.
- Show hover through border tint, subtle lift (`translateY(-1px)`), or shadow—not all aggressively.
- Keep nested surfaces to three levels maximum.

### Navigation

- Use 16–18px monoline icons.
- Active item: subtle blue-tinted or ink-filled state; inactive items remain neutral.
- Keep labels short and visible in primary navigation.
- Use tooltips for icon-only collapsed rails.

### Chips and filters

- Transparent or white surface, 1px hairline border, 12–14px text.
- Active neutral filter may invert to ink background and white text.
- Use blue only when selection is also the main action/focus.
- Do not turn ordinary buttons, tabs, tags, and metadata all into pills.

### Dialogs, menus, and toasts

- Dialog radius 16px, clear title/body/action hierarchy.
- Menus use 12px radius, 8px internal padding, compact rows.
- Toasts communicate transient results; inline validation remains near the field.
- Never rely on color alone for errors or success.

### Chat and agent states

- Distinguish roles through alignment, label, avatar/icon, and surface—not multiple saturated bubbles.
- User prompt may use a subtle fog or blue-tinted surface.
- Agent output stays white/transparent for long-form readability.
- Progress steps use compact icons, muted copy, and one active accent.
- Pending image attachments appear as 56–72px thumbnails with clear remove/retry controls.

## Interaction and motion

- Hover/focus transition: 120–160ms.
- Panel/drawer transition: 180–220ms.
- Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Loading skeletons use neutral opacity animation.
- Avoid bouncing, elastic motion, parallax, glowing pulses, and decorative infinite animation.
- Honor `prefers-reduced-motion`.

## Responsive behavior

- `< 640px`: one primary surface; stack headers; full-width primary actions when useful.
- `640–1023px`: two-column project grid; secondary panes become overlays.
- `>= 1024px`: full workspace panes or three-column project grid.
- Keep tap targets at least 40px high (44px where space permits).
- Do not shrink typography below 12px or compress card padding below 16px.
- Test Chinese labels at 150–200% of the shortest expected copy length.

## Accessibility

- Maintain WCAG AA contrast.
- Provide a visible 2px focus ring with offset.
- Use semantic HTML before ARIA.
- Give icon-only controls accessible names and tooltips.
- Preserve keyboard order when panes collapse.
- Announce async task state and errors.
- Do not encode project/guest/status identity by color alone.

## Visual QA checklist

- Is there exactly one dominant action in each task region?
- Is blue scarce and meaningful?
- Are primary, secondary, and muted text visibly distinct?
- Does the UI use no more than three surface levels?
- Are related rows grouped by dividers instead of card spam?
- Are radii consistent by component type?
- Are icons consistently monoline and sized 16–18px?
- Are hover, focus, disabled, loading, empty, and error states implemented?
- Does mobile preserve the same task hierarchy?
- Does Chinese copy wrap or truncate intentionally?
- Is the authenticated product free of serif display typography and marketing decoration?

## Evidence links

- Atoms public product site: https://atoms.dev/
- Atoms design-system extraction: https://styles.refero.design/style/537641a0-5a24-4203-ae9b-cd29516aa3f8
- Atoms on its shadcn/ui foundation: https://atoms.dev/blog/introduce-shadcn-ui
- Public Atoms product screenshot and architecture context: https://neon.com/blog/atoms-is-out-a-multi-agent-ai-team-that-builds-full-stack-apps-for-you
