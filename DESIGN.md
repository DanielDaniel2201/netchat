# DESIGN

## Design Thesis

Design `netchat` like an editorial graph workspace, not like a chat app.

The UI should feel closer to a printed layout, a marked-up document, or a newsroom board than to a messaging product. The canvas is the product. Message nodes are structural blocks inside that canvas.

## Style DNA

### 1. Editorial, not conversational

- Avoid chat-bubble metaphors.
- Avoid soft, friendly messenger UI patterns.
- Prefer layouts that feel composed, structured, and deliberate.

### 2. Block-based, not pill-based

- Use strong rectangular surfaces.
- Prefer hard edges and visible borders.
- Avoid rounded pills, rounded chat bubbles, and soft floating capsules.

### 3. Typography-led hierarchy

- Typography should do most of the hierarchy work.
- Use serif display type for titles and major moments.
- Use neutral sans-serif type for UI, body copy, labels, and controls.
- Meta information should be small, uppercase, and tightly tracked.

### 4. Orthogonal structure

- The canvas should feel architectural.
- Prefer straight, step-like, or orthogonal connectors.
- Layout should read as a system of lanes, columns, and aligned blocks.

### 5. Low-noise chrome

- Remove UI that does not help orientation or action.
- Do not add helper bars, redundant labels, or decorative status strips unless they are genuinely useful.
- If the user can already click the block or select text directly, avoid extra explanatory controls around it.

### 6. Paper over glass

- Prefer cream / paper backgrounds over pure white app shells.
- Surfaces may still be white, but the overall environment should feel printed and tactile rather than glossy or futuristic.

## Design Tokens

Use these as the primary visual contract:

```css
:root {
  --bg-cream: #F4F1EA;
  --text-main: #1A1A1A;
  --block-green: #3E4E42;
  --block-slate: #3A4042;
  --block-ochre: #C28E55;
  --line-color: #DCD6C8;
  --node-border: #E5DFD1;
}
```

### Color Rules

- `--bg-cream` is the default app background.
- `--text-main` is the default foreground text color.
- `--block-green` is the primary assistant / active system color.
- `--block-slate` is for dense information panels and dark utility surfaces.
- `--block-ochre` is the composer / emphasis color.
- `--line-color` is for grids, dividers, and quiet structure.
- `--node-border` is the default card border.

### Color Principles

- Use color semantically, not decoratively.
- Do not introduce bright accent colors unless there is a very strong product reason.
- Avoid gradient-heavy, neon, or glossy color treatments.

## Typography

### Font Roles

- Display / editorial titles: `Playfair Display`
- UI / body / controls: `Helvetica Neue`
- Monospace / paths / technical values: existing mono stack

### Typography Rules

#### Display text

- Reserved for titles, big moments, and a small number of emphasis points.
- Elegant, high-contrast, editorial.
- Never overused.

#### Body text

- Neutral and highly readable.
- Slightly generous line height.
- Should feel calm and typeset, not cramped.

#### Meta text

This is one of the most important primitives in the system:

```css
.editorial-meta {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
```

Use this for:

- labels
- timestamps
- section markers
- small UI metadata
- control captions

Do not use casual mixed-case helper text where an editorial meta label would work better.

## Layout Rules

### Canvas-first product

- The main canvas is the primary surface.
- The user should arrive in the workspace quickly.
- Avoid large permanent headers or dashboard chrome unless they carry essential information.

### Structural rhythm

- Use clear lanes and spacing between blocks.
- Keep alignment disciplined.
- Let whitespace create clarity.

### Grid and dividers

- A visible background grid is encouraged.
- Divider lines should be thin, quiet, and useful.
- Borders are a core part of the aesthetic, not just a utility.

## Component Rules

### Message Nodes

Message nodes should feel like structured cards on an editorial board.

Rules:

- Use rectangular cards.
- Use visible borders.
- Use a colored top border to communicate role or state.
- Keep the interior simple: header + body.
- Do not add a footer bar unless it provides indispensable functionality.

Current role treatment:

- User node: slate top border
- Assistant node: green top border
- Selection / branching emphasis: ochre treatment

### Message Node Header

- Contains only essential metadata.
- Typical content: role + timestamp.
- Use `editorial-meta` styling.
- Keep it restrained and aligned.

### Message Node Body

- The content should be the main event.
- Use generous padding.
- Preserve readable line length and line height.
- Selection states should feel subtle and integrated.

### Composer

The composer is a functional accent block.

Rules:

- Use `--block-ochre` as the main composer surface.
- Use white text inside the composer.
- Keep the layout simple and direct.
- The send button should feel structural, not playful.
- Prefer square or hard-edged controls over pills.

### Runtime / Utility Panels

- Use either dark slate blocks or white bordered cards.
- Panels should feel like utility inserts pinned onto the canvas.
- Offset shadows are preferred over soft diffuse glow.

### Buttons

- Prefer rectangular buttons with borders.
- Avoid rounded-full unless there is a very specific reason.
- Hover states should be subtle: slight translation, slight contrast shift, or small shadow change.

## Connection Rules

Graph edges are part of the design language.

- Prefer `step` / orthogonal routing.
- Use square line caps and miter joins.
- Active paths should become darker and more legible.
- Fork paths may be lighter or dashed, but still disciplined.
- Avoid curvy, organic, whimsical connection styles.

## Interaction Rules

### Direct manipulation first

- If a block is clickable, let the block be the affordance.
- If text is selectable, let text selection be the affordance.
- Avoid permanent helper UI that explains obvious actions.

### Minimal helper text

- Helper copy should only appear when it solves real ambiguity.
- Prefer contextual overlays over permanent clutter.

### Motion

- Motion should be restrained.
- Use small hover lifts, panel reveals, and viewport transitions.
- Do not use bouncy, playful, or overly polished animation styles.

## What To Avoid

Do not introduce:

- standard chat bubbles
- pill-shaped UI everywhere
- glassmorphism
- neon gradients
- oversized badges
- decorative icons without a job
- footers or helper bars that repeat obvious interaction hints
- dashboard-like header chrome with low-value information

## Frontend Consistency Checklist

Before shipping a new UI surface, check:

1. Does it feel editorial instead of chat-like?
2. Are the main surfaces rectangular and clearly bordered?
3. Are we using the existing semantic tokens instead of inventing new colors?
4. Is the hierarchy driven by typography first?
5. Is meta text uppercase, small, and tracked?
6. Did we avoid redundant helper UI?
7. Does the component reduce noise rather than add it?
8. If this were printed on paper, would it still make visual sense?

## Default Direction For Future Work

When making new frontend features in `netchat`, prefer this default direction:

- cream paper background
- white structural cards
- green / slate / ochre semantic blocks
- serif display accents
- sans-serif UI copy
- uppercase meta labels
- orthogonal lines
- hard borders
- sparse chrome
- direct interaction

If a new design idea conflicts with these rules, preserve the spirit above unless there is a clear product reason to break it.
