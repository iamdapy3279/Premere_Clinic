---
name: Clinical Precision Monochrome
colors:
  surface: '#f9f9f9'
  surface-dim: '#dadada'
  surface-bright: '#f9f9f9'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f3'
  surface-container: '#eeeeee'
  surface-container-high: '#e8e8e8'
  surface-container-highest: '#e2e2e2'
  on-surface: '#1a1c1c'
  on-surface-variant: '#47464a'
  inverse-surface: '#2f3131'
  inverse-on-surface: '#f0f1f1'
  outline: '#78767b'
  outline-variant: '#c8c5ca'
  surface-tint: '#5f5e60'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1c1b1d'
  on-primary-container: '#858386'
  inverse-primary: '#c8c6c8'
  secondary: '#5f5e61'
  on-secondary: '#ffffff'
  secondary-container: '#e4e1e6'
  on-secondary-container: '#656467'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#1a1b22'
  on-tertiary-container: '#83838c'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e5e1e4'
  primary-fixed-dim: '#c8c6c8'
  on-primary-fixed: '#1c1b1d'
  on-primary-fixed-variant: '#474649'
  secondary-fixed: '#e4e1e6'
  secondary-fixed-dim: '#c8c5ca'
  on-secondary-fixed: '#1b1b1e'
  on-secondary-fixed-variant: '#47464a'
  tertiary-fixed: '#e3e1ec'
  tertiary-fixed-dim: '#c6c5cf'
  on-tertiary-fixed: '#1a1b22'
  on-tertiary-fixed-variant: '#46464e'
  background: '#f9f9f9'
  on-background: '#1a1c1c'
  surface-variant: '#e2e2e2'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '600'
    lineHeight: 18px
    letterSpacing: -0.005em
  body-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.02em
  mono-data:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  code-param:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0em
spacing:
  gutter: 12px
  gutter-desktop: 16px
  margin: 16px
  margin-desktop: 24px
  space-xs: 4px
  space-sm: 8px
  space-md: 12px
  space-lg: 16px
  space-xl: 24px
  space-2xl: 32px
---

## Brand & Style

This design system embodies austere clinical rigor, architectural clarity, and absolute utilitarian focus. Tailored for medical practice administrators, clinic receptionists, and healthcare operators who configure mission-critical patient voice agents, the interface eliminates all decorative artifice, emotional coloration, and visual noise.

The design philosophy is rooted in **Radical Monochrome Minimalism and Swiss Structuralism**. Trust and precision are derived from meticulous structural alignment, exacting typographic hierarchy, and razor-sharp borders rather than synthetic status colors or soft ornamental depth. Every pixel serves density, legibility, and rapid error-free data manipulation under demanding high-throughput clinical workflows.

## Colors

The palette operates under a strict achromatic discipline: zero hue saturation across the entire interface. Status, emphasis, hierarchy, and interaction states are expressed exclusively through luminance contrast, stroke weighting, and typographic shifts.

- **Canvas & Primary Base (`#FFFFFF`)**: Pure crisp white for primary panels, inputs, and operational cards.
- **Surface Muted (`#FAFAFA`)**: Global canvas backdrop, providing subtle separation behind pure white cards and panels.
- **Surface Subtle (`#F4F4F5`)**: Table row striping, disabled zones, muted container backdrops, and active toggle track states.
- **Border & Rule (`#E4E4E7`)**: The structural spine of the interface. 1px hairline borders demarcating data cells, form sections, and module perimeters.
- **Subtext & Secondary Label (`#71717A`)**: Metadata, field captions, helper strings, and inactive indicator states. Meets WCAG AA contrast standards against light backgrounds.
- **Primary Text & High Emphasis (`#18181B`)**: Standard body text, high-density table contents, and secondary action framing.
- **Absolute Accent & Focus Anchor (`#09090B`)**: Primary buttons, selected states, high-contrast check marks, focus boundaries, and critical headings.

## Typography

Typography is calibrated for extreme density and rapid scanning of medical logs, patient identifiers, and medication dosage schedules.

- **Primary Typeface**: `Inter` is utilized globally across headlines, UI controls, and body copy for its neutral mechanical geometry and robust tabular figure support.
- **Data & Parameter Typeface**: `JetBrains Mono` is reserved for dosage specifications, cron scheduling strings, patient record IDs (MRN), phone numbers, and voice agent runtime variables.
- **Numbers & Metrics**: All numerical tables must use `font-variant-numeric: tabular-nums` to ensure strict vertical column alignment across rapidly updating data streams.

## Layout & Spacing

The layout is built around a dense, high-efficiency grid optimized for multi-pane split-screen clinical workflows (e.g., patient queue alongside agent voice transcript rules and calendar sync matrices).

- **Grid Architecture**: 12-column fixed-gutter grid on desktop environments (`gutter-desktop: 16px`, outer margins `24px`). On viewports under 1024px, collapses into a single-column stacked hierarchy with `margin: 16px`.
- **Rhythm Principle**: A strict 4px base modular scale (`4px`, `8px`, `12px`, `16px`, `24px`, `32px`). Vertical gaps between form fields and list items stay tightly bound between `8px` and `12px` to keep critical patient parameters above the fold.
- **Density Tier**: Ultra-compact vertical padding across inputs and rows allows receptionists to review full daily medication reminder batches without excessive scrolling.

## Elevation & Depth

This system rejects drop shadows, blurred overlays, and soft simulated light. Spatial layering and structure are achieved purely through **crisp 1px borders, subtle tone shifting, and high-contrast bounding lines**.

- **Surface Tiers**:
  - `Level 0 (Base Canvas)`: `#FAFAFA`
  - `Level 1 (Panels & Cards)`: Pure `#FFFFFF`, delineated by a solid `1px` border of `#E4E4E7`.
  - `Level 2 (Active/Hover Containers)`: Pure `#FFFFFF` framed by a `1px` border of `#18181B`.
  - `Level 3 (Modals & Flyouts)`: Pure `#FFFFFF`, framed by a `1px` border of `#09090B`. No drop shadow. A non-blurred 40% `#09090B` opaque backdrop curtain isolates the modal context.
- **Structural Lines**: Dividers, column borders, and card perimeters share an unyielding `1px solid #E4E4E7` specification.

## Shapes

The interface adopts a strictly non-rounded, sharp geometry (`roundedness: 0`). 

- **Corners**: Exactly `0px` border-radius across all interactive components—including buttons, input fields, badges, cards, tabs, and alert containers.
- **Rationale**: Sharp rectilinear boundaries evoke clinical instruments, data matrices, and laboratory-grade equipment. They maximize active pixel estate, reinforce structural grid lines, and remove any casual software feel in high-consequence medical administrative tasks.

## Components

### Buttons
- **Primary Action**: Background `#09090B`, text `#FFFFFF`, border `1px solid #09090B`, radius `0px`. Height `32px`. Text `label-md`. Hover shifts background to `#18181B`.
- **Secondary Action**: Background `#FFFFFF`, text `#18181B`, border `1px solid #E4E4E7`, radius `0px`. Height `32px`. Hover shifts border to `#18181B`.
- **Destructive/Critical Action**: Background `#FFFFFF`, text `#09090B`, border `2px solid #09090B`, uppercase `label-sm`. Hover inverts to background `#09090B`, text `#FFFFFF`. (Zero red used; emphasis relies strictly on high-contrast stroke weight).

### Input Fields & Controls
- **Text & Numerical Inputs**: Background `#FFFFFF`, border `1px solid #E4E4E7`, text `#18181B`, height `32px`, padding `0 8px`. Font `body-md`. Focus state switches border to `1px solid #09090B` with an internal `1px` inner rule (zero glow).
- **Checkboxes & Radios**: `14px x 14px`, `0px` radius. Border `1px solid #71717A`. Selected state: fill `#09090B` with white geometric mark.
- **Toggles / Switches**: Rectangular `32px x 16px` track with `0px` radius, border `1px solid #E4E4E7`. Handle is an `8px x 12px` solid rectangular block.

### Badges & Status Indicators
- **Standard Token / Chip**: Height `20px`, padding `0 6px`, border `1px solid #E4E4E7`, background `#FAFAFA`, text `#18181B`, font `label-sm`.
- **Voice Agent Active Status**: Solid `6px x 6px` square mark. Active: `#09090B`. Suspended / Inactive: hollow `1px` border `#71717A`.
- **Medication Compliance Pill**: Monospaced dosage timing (`JetBrains Mono`, `11px`), wrapped in a `1px solid #E4E4E7` container with `#FFFFFF` background.

### Tables & Data Grids
- **Header Cells**: Height `28px`, background `#FAFAFA`, border-bottom `1px solid #E4E4E7`, text `#71717A`, font `label-sm`, uppercase.
- **Body Rows**: Height `36px`, background `#FFFFFF`, border-bottom `1px solid #E4E4E7`, text `#18181B`, font `body-md`. Alternate rows may use `#FAFAFA` when density exceeds 15 columns. Hover state shifts row background to `#F4F4F5`.

### Specialized Clinical Agent Modules
- **Cron / Reminder Schedule Block**: Sharp rectangular box with `1px solid #E4E4E7`, header bordered by `#E4E4E7`, split into dosage frequency, delivery channel (TTS Phone Call vs SMS), and patient timezone.
- **Agent Voice Transcript Node**: Pure white background card with left rail border `2px solid #09090B` for agent responses and `1px dashed #71717A` for patient inputs.