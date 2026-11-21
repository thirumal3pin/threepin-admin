# Where this comes from

Copied unchanged from **GoogleChrome/modern-web-guidance** (Apache License 2.0, see LICENSE here),
`skills/modern-web-guidance/`, commit `64a6d708f5a43f2cd3fde5d4d7db3905ba1bdf65` (16 Nov 2026).
Stewarded by the Chrome, Edge, Firefox and MDN teams. Added at the owner's request on 20 Nov 2026
as part of this repo's UI/UX design instructions — see `.claude/frontend-design-principles.md`,
section "Modern Web Guidance".

## Using it here

SKILL.md describes searching the guides with `npx modern-web-guidance`. That needs network access
and may be blocked on this machine; the guides themselves are all in `guides/` and can be read
directly:

    grep -h '^description:' -r .claude/skills/modern-web-guidance/guides | less     # what exists
    ls .claude/skills/modern-web-guidance/guides/<area>/                             # one area

Areas: accessibility, css, forms, html, js, performance, privacy, pwa, security, ui-atoms,
ui-behaviors, ui-components, user-experience, visual-design (and built-in-ai, wasm, webmcp).

To update: copy the folder again from a newer commit and change the commit above.
