---
name: Echo Engine Industrial
colors:
  surface: '#121315'
  surface-dim: '#121315'
  surface-bright: '#38393a'
  surface-container-lowest: '#0d0e0f'
  surface-container-low: '#1b1c1d'
  surface-container: '#1f2021'
  surface-container-high: '#292a2b'
  surface-container-highest: '#343536'
  on-surface: '#e3e2e3'
  on-surface-variant: '#e7bdb5'
  inverse-surface: '#e3e2e3'
  inverse-on-surface: '#303032'
  outline: '#ae8881'
  outline-variant: '#5d3f3a'
  surface-tint: '#ffb4a6'
  primary: '#ffb4a6'
  on-primary: '#660700'
  primary-container: '#ff553a'
  on-primary-container: '#5a0600'
  inverse-primary: '#bc1600'
  secondary: '#c5c6c8'
  on-secondary: '#2e3132'
  secondary-container: '#444749'
  on-secondary-container: '#b4b5b7'
  tertiary: '#ecc23f'
  on-tertiary: '#3d2f00'
  tertiary-container: '#cfa723'
  on-tertiary-container: '#4f3d00'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdad4'
  primary-fixed-dim: '#ffb4a6'
  on-primary-fixed: '#3f0300'
  on-primary-fixed-variant: '#900e00'
  secondary-fixed: '#e1e2e4'
  secondary-fixed-dim: '#c5c6c8'
  on-secondary-fixed: '#191c1e'
  on-secondary-fixed-variant: '#444749'
  tertiary-fixed: '#ffe08d'
  tertiary-fixed-dim: '#ecc23f'
  on-tertiary-fixed: '#241a00'
  on-tertiary-fixed-variant: '#584400'
  background: '#121315'
  on-background: '#e3e2e3'
  surface-variant: '#343536'
typography:
  hero:
    fontFamily: Archivo Black
    fontSize: 80px
    fontWeight: '900'
    lineHeight: 76px
    letterSpacing: -0.02em
  display:
    fontFamily: Archivo Black
    fontSize: 44px
    fontWeight: '800'
    lineHeight: 44px
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Archivo Black
    fontSize: 24px
    fontWeight: '800'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Archivo Black
    fontSize: 20px
    fontWeight: '800'
    lineHeight: 28px
  numeral-xl:
    fontFamily: Archivo Black
    fontSize: 72px
    fontWeight: '400'
    lineHeight: 58px
    letterSpacing: -0.05em
  stat-value:
    fontFamily: Archivo Black
    fontSize: 36px
    fontWeight: '400'
    lineHeight: 40px
  body-md:
    fontFamily: Archivo
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.14em
  mono-data:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0.01em
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  huge: 64px
---

## Brand & Style

This design system is built for high-performance AI video processing, embodying a **Brutalist Editorial** aesthetic. It prioritizes technical authority and computational precision through a "mechanical instrument" lens. The interface should feel like a high-end cinema camera UI—think Leica, Hasselblad, or Arri—where every pixel serves a functional purpose.

The emotional response is one of **uncompromising reliability and professional rigor**. It achieves this through:
- **Obsidian Foundations:** Deep matte surfaces that recede, allowing content and telemetry to pop.
- **Industrial Precision:** Zero-radius geometry (sharp corners) and hairline borders.
- **High-Contrast Telemetry:** Aggressive white typography paired with monospaced data readouts.
- **Leica Vermilion Accents:** A singular, vibrant red used sparingly but powerfully for primary actions and active states.

## Colors

The palette is rooted in a monochromatic dark spectrum to minimize visual fatigue during intense video editing workflows, using **Leica Vermilion** as the sole high-energy disruptor.

- **Primary (Leica Vermilion):** Used for critical CTAs, active progress pulses, and brand-critical indicators. It represents the "Record" state of professional equipment.
- **Neutral/Surface:** The "Matte Obsidian" foundation uses staggered shades of near-black. Avoid pure black (#000) for surfaces to prevent "smearing" on OLED displays; use `#08090A` for the canvas and `#101214` for primary containers.
- **Typography:** High-contrast white (`#F2F3F5`) for headlines and secondary technical grey (`#A4ABB3`) for metadata.
- **Rules:** Hairline borders use `#24282D`. They should be crisp, 1px lines that define the grid without adding bulk.

## Typography

The typography system is a mix of bold editorial impact and technical utility. 

- **Display Hierarchy:** Use `Archivo Black` for all headings. It should feel heavy and structural. For "Step" numbers (e.g., 01, 02), use the `numeral-xl` role, often positioned as a hanging element to the left of the content.
- **Technical Readouts:** Use `JetBrains Mono` for any data that is calculated by the engine—resolutions, frame rates, file paths, and hashes. This font must always use tabular figures to ensure columns of numbers align perfectly.
- **Captions & Eyebrows:** Small caps with wide tracking (0.14em) should be used for section labels to evoke the "engraved" look of camera hardware.

## Layout & Spacing

The layout is governed by an **Industrial Grid** philosophy, characterized by high-density control clusters and dramatic editorial whitespace between major sections.

- **The Chassis:** A fixed 280px sidebar on the left contains navigation and system health telemetry. The main workspace has a max-width of 1120px to keep control panels within a comfortable scan-range.
- **Rhythm:** Use a strict 4px baseline. Components like stat-grids should use seamless 1px borders (collapsed margins) to create a "spreadsheet" or "instrument" feel.
- **Sequential Flow:** Workflows follow a "Step" model (01 → 02 → 03). Each step is separated by `huge` (64px) vertical spacing to clearly demarcate the processing pipeline.
- **Responsive:** Below 900px, the sidebar collapses into a modal drawer. All grids reflow from multi-column stat rows to single-column stacks.

## Elevation & Depth

This system rejects traditional soft shadows in favor of **Tonal Layering** and **High-Contrast Outlines**.

- **Surface Tiers:** Depth is communicated by color, not shadow. The further "forward" an element is (like a dropdown or modal), the lighter the surface color becomes (e.g., moving from `#08090A` to `#16191C`).
- **Hairline Boundaries:** Every container must be defined by a 1px border (`#24282D`). This creates a blueprint-like appearance.
- **Active Glow:** The only exception to the "no shadow" rule is the Primary Action button. It utilizes a `24px` diffused Vermilion glow (`rgba(255, 59, 31, 0.35)`) to simulate an illuminated physical button on a control deck.
- **Focus States:** Focused inputs do not use "halos"; they use a sharp 1px Vermilion border.

## Shapes

The shape language is **strictly binary**:
- **Rectilinear (Sharp):** Every button, card, input, and modal must have **0px border-radius**. This reinforces the brutalist, industrial aesthetic and ensures components feel like "blocks" of an integrated machine.
- **Circular (Full):** Reserved exclusively for status indicators (e.g., a "Live" pulse or "System OK" dot) to provide a soft visual counterpoint to the rigid grid.

## Components

- **Primary Buttons:** High-impact Vermilion (#FF3B1F) background with black text (#0A0A0A). 44px height for primary actions. Text must be `Archivo Black` uppercase.
- **Secondary Buttons:** Ghost style with a 1px `#3A4047` border. On hover, the background fills with `#1D2126`.
- **Telemetry Cards:** Used for GPU stats or file info. These use `#101214` backgrounds with `JetBrains Mono` text. Group them in seamless rows where they share a middle border.
- **Input Fields:** `#16191C` background with a `#3A4047` border. Use `JetBrains Mono` for text entry to ensure technical values (like resolution dimensions) are easy to read.
- **Segmented Controls:** For switching modes (e.g., 4K vs 8K). These should look like a single bar divided by 1px lines. The active segment inverts to white background with black text.
- **Accent Blocks:** Use a 4px solid Vermilion left-border for high-priority callouts or instructions.
- **Progress Bars:** Thin 4px tracks. The "fill" should be Vermilion for active processes and Success Green for completed tasks.