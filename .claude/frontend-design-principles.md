# Frontend Design Principles

*Extracted from anthropics/skills/frontend-design — a design-led approach to UI/UX*

## Core Philosophy
- Deliver distinctive, intentional visual design avoiding templated defaults
- Ground design decisions in the subject matter, audience, and purpose
- Make deliberate, opinionated choices about palette, typography, and layout
- Take one real aesthetic risk you can justify

## Design Principles

### Hero & Opening
- Open with the most characteristic thing in the subject's world
- Lead with what makes the subject memorable in appropriate format
- Avoid generic treatments like a "big number with a small label" unless truly optimal

### Typography
- Select display and body typefaces deliberately for each project
- Establish a clear type scale with intentional weights, widths, and spacing
- Make typography itself memorable rather than neutral
- Pair faces that complement rather than repeat

### Structure & Information
- Structural devices (numbering, eyebrows, dividers) should encode something true about the content
- Use numbered markers only when order carries genuine meaning
- Question whether structural choices actually serve the content

### Motion & Animation
- Deploy animation deliberately where it serves the subject
- Choose orchestrated moments over scattered effects
- Recognize when restraint prevents an "AI-generated" feeling

### Complexity Matching
- Align execution complexity to the chosen vision
- Maximalist directions require elaborate execution
- Minimal directions demand precision in spacing and detail
- "Spend your boldness in one place; keep everything around it quiet"

## Writing & Copy

### Principles
- Words exist to aid understanding and usability
- Write from the end user's side of the screen
- Be specific rather than clever; use plain terms
- Use active voice for controls and actions

### Tone & Clarity
- Keep register conversational and brand-appropriate
- Use sentence case and plain verbs
- Explain failures clearly without apologies
- Treat empty states as invitations to act, not mood-setting

### Consistency
- Actions maintain same names through flows ("Publish" → "Published")
- Interface vocabulary becomes navigation signposting
- Each element performs one job precisely

## Common Defaults to Avoid
- Warm cream backgrounds (#F4F1EA) with serif/terracotta
- Dark backgrounds with single bright accent colors
- Broadsheet layouts with hairline rules and dense columns
- Over-reliance on emoji as section markers
- Everything centered with rounded-lg corners everywhere

## Design Process

**Two-Pass Approach:**

1. **Brainstorm**: Create compact design plan with:
   - **Color**: 4–6 named hex values specific to the subject
   - **Typography**: 2+ roles (display, body, utility)
   - **Layout**: One or two sentences describing the concept
   - **Signature element**: What makes this distinctive

2. **Review & Refine**: 
   - Check against brief; revise any generic elements
   - Ensure choices reflect the subject's world, not defaults
   - Confirm the design plan is unique before building

**Quality Standards:**
- Responsive to mobile
- Visible keyboard focus
- Reduced motion respected
- Works in both light and dark themes
- No silent font fallbacks or cascade collisions

## For UI/UX Specifically

### Information Design
- Surface summary before detail
- Encode state in form as well as number (pills, chips, severity stripes)
- Semantic color (good/warning/critical) separate from accent hue
- What's interactive should look interactive

### Visual Hierarchy
- Typography carries personality and guides the eye
- Structure is information — numbering/dividers must mean something
- Avoid decorative elements that don't serve the content

### Responsive & Accessible
- Layout with flex/grid and `gap` for proper spacing
- Wide content gets `overflow-x: auto` on its container
- Use `text-wrap: balance` for headings
- Body text near 65 characters wide

---

**Key Takeaway**: Design is distinctive when it's rooted in the subject's world, not in generic defaults. Make deliberate choices, avoid over-templating, and let the content drive the visual treatment.
