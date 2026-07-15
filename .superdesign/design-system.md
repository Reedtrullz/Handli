# Handleplan Design System

## Product context

Handleplan is a Norwegian public-good grocery planning web app. Planlegg helps an anonymous shopper build a complete basket and choose between real one-to-three-store plans. Oppdag surfaces explainable opportunities and their effect on the active plan. The product must communicate price provenance, freshness, substitutions, offer conditions, and optional travel costs without becoming visually bureaucratic.

The design is adapted from Superdesign's **Mosaic Grid Architecture Style**. Retain its structural clarity, paper-and-forest palette, flat surfaces, hairline borders, and compact metadata. Do not retain landing-page tropes such as giant hero type, decorative technical diagrams, uppercase-only navigation, or dense blueprint ornament.

## Brand character

- Trustworthy, calm, neighborly, practical, and independent.
- A civic utility with consumer warmth—not a coupon tabloid, supermarket campaign, fintech dashboard, or luxury product.
- Recommendations should feel inspectable and reversible.
- Norwegian copy is direct and plain. Avoid hype and gamified urgency.

## Color tokens

- `paper`: `#F7F7F2` — application background.
- `surface`: `#FFFFFF` — cards and interactive surfaces.
- `forest-950`: `#10281D` — strongest text and active brand surface.
- `forest-800`: `#1A3C2B` — primary brand and primary action.
- `forest-650`: `#2F6248` — secondary brand text and progress.
- `mint-100`: `#E4F2E8` — selected plan and positive context.
- `mint-300`: `#A9D6B7` — decorative route or selection accents.
- `coral-100`: `#FCE9E2` — conditions or substitution notice background.
- `coral-600`: `#B84F32` — high-attention condition text, never the only signal.
- `gold-100`: `#F8F0CE` — savings evidence and calculated price-drop background.
- `gold-600`: `#8A6812` — savings evidence text.
- `ink`: `#19201C` — body text.
- `muted`: `#657069` — secondary text; preserve AA contrast.
- `line`: `#D7DCD7` — default hairline.
- `line-strong`: `#AEB8B1` — interactive boundary.
- `focus`: `#1769E0` — high-visibility focus ring independent of retailer colors.

Retailer branding is never used as Handleplan's primary palette. Retailer names appear as text and may use a small neutral source mark only when rights allow.

## Typography

- Display and interface headings: `"Space Grotesk", "Avenir Next", system-ui, sans-serif`.
- Body and controls: `"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Numeric evidence and compact metadata only: `"JetBrains Mono", ui-monospace, SFMono-Regular, monospace`.
- Page title: 40/44 desktop, 30/34 mobile, weight 650.
- Section title: 24/30 desktop, 21/27 mobile, weight 650.
- Card title: 17/23, weight 650.
- Body: 16/24.
- Compact metadata: 12/17; sentence case by default, uppercase only for very short status categories.
- Use tabular numerals for prices, travel time, and totals.

## Spacing and layout

- Base spacing unit: 4px.
- Core scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Minimum touch target: 44x44px; checklist targets 48px high.
- Desktop content width: 1180px with 24–32px gutters.
- Planner/result desktop grid: flexible main column plus 360–400px summary rail when useful.
- Mobile gutters: 16px.
- Use whitespace and subtle section rules rather than nested boxes.
- Borders: 1px solid `line`; active boundaries use `forest-800`.
- Radius: 10px for cards and inputs, 999px only for compact chips and segmented controls.
- Shadows: none by default; sticky mobile action bars may use a single subtle `0 -8px 24px rgba(16,40,29,.08)` separation shadow.

## Application shell

- Desktop: 64px header, wordmark at left, Planlegg/Oppdag centered or adjacent, preference/location entry at right. Bottom border only.
- Mobile: 56px header with wordmark and compact basket/status action; bottom navigation for Planlegg and Oppdag outside focused checklist mode.
- Handleplan wordmark is typographic until a logo is designed. Use a simple 20px forest square containing a white route/list line mark only if an icon is needed.
- Planlegg is the default active destination.

## Components

### Buttons

- Primary: forest background, white text, 48px height, 10px radius.
- Secondary: surface background, forest text, 1px forest border.
- Quiet: transparent, forest text, underline or icon on hover.
- Disabled states retain readable labels and explain missing prerequisites nearby.

### Inputs and item cards

- Inputs use white surfaces, 1px line-strong borders, 48–52px height, persistent labels when meaning could be lost.
- Basket item cards emphasize the shopper's need first, then matched product and constraints.
- Exact, constrained, and flexible matches have both an icon/label and explanatory copy.

### Plan selector

- The convenience–savings control is discrete. Each stop maps to a real complete plan.
- A horizontal track may connect labeled plan points, but it must be paired with selectable named cards or radio rows.
- Selected plan uses a forest border and mint background.
- Never display a fake `0–100` value.
- Total, stops, travel, and substitutions update as a coordinated evidence block.

### Price and trust evidence

- Savings use gold-100 surfaces and gold-600 text.
- Conditions/substitutions use coral-100 and coral-600.
- Freshness and provenance use compact neutral metadata with an information icon.
- Avoid red unless data is invalid or an action is destructive.

### Store and checklist groups

- Store groups are separated by structural rules and numbered route markers rather than retailer-colored containers.
- Checklist rows show item, quantity, expected price, and any condition without truncating the essential meaning.
- Completed items reduce emphasis but remain readable.

## Motion

- 120–180ms ease-out for selection, disclosure, and card state changes.
- Slider changes crossfade numeric evidence and translate no more than 4px.
- No looping decorative animation.
- Honor `prefers-reduced-motion` by removing nonessential transitions.

## Responsive behavior

- Desktop comparison may use side-by-side plan evidence and basket/store assignments.
- Mobile is a single column with a sticky selected-plan summary and bottom primary action.
- Plan selector cards scroll horizontally only if every option remains reachable by keyboard and screen reader; a vertical list is preferred below 390px.
- Tables become labeled definition rows, never unlabeled horizontal scrolling.

## Accessibility and content rules

- WCAG 2.2 AA contrast.
- Visible 3px focus ring using `focus` with 2px offset.
- Every status has text or an icon label in addition to color.
- Slider exposes plan name and metrics; equivalent radio-list selection is always present.
- Use Norwegian kroner as `1 024,50 kr`; use `min` for minutes and localized dates.
- Describe calculated savings as calculated, not as an official retailer discount.
- Never imply branch stock or branch-specific shelf-price certainty.

## Key page direction

### Planlegg

List-first composition. A welcoming but compact page title leads directly to a strong need composer. Existing needs form calm editable rows. Optional travel calculation is a clearly separate choice. The primary action explains whether it can calculate a complete plan.

### Resultat

Recommendation first. Show selected plan title, total, savings, stores, and travel in the first viewport. The discrete selector makes trade-offs tangible. Below, group item assignments by route order and expose provenance in a quiet disclosure.

### Handle

Focused, mobile, large targets, route-progress context, expected subtotal per store, and explicit offline state. No discovery distractions.

### Oppdag

Structured opportunity cards, not flyer thumbnails. Each card answers: what is it, why is it relevant, what is the evidence, and what happens to the plan if added or substituted?

