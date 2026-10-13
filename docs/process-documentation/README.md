# Process documentation

Everything that documents how the 3 PIN Realty platform works — and the AI & automation roadmap — lives in this folder. It was written from the code on 13 Oct 2026 and revised on 14 Oct 2026 against the live `main` at `b48bfaa` (released 13 Oct 2026, Firestore ruleset `132b5f73`). This folder is excluded from the Vercel deployment (`.vercelignore`).

## What is here

| Path | What it is |
| --- | --- |
| `pdf/3Pin-Process-Atlas.pdf` | The four documents as one A4 PDF (functional overview, business guide, process & field reference, architecture & flows, release status) |
| `pdf/3Pin-AI-PropTech-Strategy.pdf` | **The AI & PropTech Strategy 2027–2029** (14 Oct 2026): benchmarks, scorecard, twelve areas with status / why / money / business / agent time, financial model, six waves, KPIs, guardrails, **Eåsy by 3 PIN** (the personal AI staff), the sector bets, the next chain of business (mandates → JV → co-development → redevelopment) the international watchlist with the ideas untouched in Chennai, an audit of the current system (missings, gaps, defects, the improvement list), and the business sections: positioning and names, customer segments, fee card, unit economics, micro-markets, people, partners, competitors and moats, risk register, the 90-day plan and funding. Supersedes the roadmap below |
| `pdf/3Pin-AI-Automation-Roadmap.pdf` | The earlier AI & automation roadmap (13 Oct 2026), kept for reference |
| `html/3Pin-Process-Atlas.html` | The documentation with animated diagrams — open it in a browser |
| `html/3Pin-AI-PropTech-Strategy.html` | The strategy as a page with a side index and light/dark theme |
| `html/3Pin-AI-Autopilot.html` | The animated before-and-after roadmap page (earlier edition) |
| `html/3Pin-Process-Atlas.artifact.html` | The same atlas without the document wrapper, as published to claude.ai |
| `source/*.md` | The text of every section — **edit these**, then rebuild |
| `source/ai-roadmap.html` | Source of the animated roadmap page |
| `source/7-ai-proptech-strategy.md` | **The strategy's text — edit this**, then rebuild |
| `source/6-ai-roadmap.md` | Text copy of the earlier AI & automation roadmap (superseded by the strategy) |
| `deck/` | The 28-slide presentation (section 3 is the strategy: thesis, leaders, scorecard, model, four area slides, Eåsy, bets, the next chain, brand and names, fees and unit economics, waves, numbers, risks and funding, the 90-day plan, decisions) (`deck.json` + one file per slide). The online deck stores these under `project/` (`project/deck.json`, `project/slides/<id>.html`), so republish from a folder with that layout |
| `build/` | Scripts that turn `source/` into `html/` and `pdf/` |

## Online editions (private until shared from each page's Share menu)

| Edition | Link |
| --- | --- |
| **AI & PropTech Strategy 2027–2029** | https://claude.ai/artifact/1uTR3SWFPwbAEgF5nRkdxD |
| Living doc, with tabs and drawn diagrams (13 Oct edition) | https://claude.ai/code/artifact/78ef93ba-1672-4eca-8900-15bb866f4235 |
| AI & automation roadmap doc (13 Oct edition, superseded by the strategy) | https://claude.ai/code/artifact/5dc896b9-92c5-46cc-a802-500142160b36 |
| Animated atlas (13 Oct edition; the 14 Oct revision is `html/3Pin-Process-Atlas.html`) | https://claude.ai/artifact/CrVE55snq5yKLV4jZpJcro |
| Animated AI roadmap | https://claude.ai/artifact/D2vxuHAHDgn8GH3jdCYsy1 |
| Presentation deck (online copy is the 13 Oct edition; the 24-slide edition is in `deck/`) | https://claude.ai/artifact/2EWHKV85xj9hN9NMe3nXj7 |

The living docs and the files here are separate copies: when a process changes, update both (or ask Claude to update one from the other).

## Which source file feeds which section

| File | Section |
| --- | --- |
| `1-functional.md` | Document 1 · Functional overview |
| `2-business.md` | Document 2 · Business guide |
| `3f-interlinks.md` | Document 3 · interconnection matrix |
| `3a-property.md` … `3e-platform.md` | Document 3 · one module each (Property, CRM, Shoot & Media + Posting, Finance, Platform) |
| `build/diagrams.mjs` | Document 4 · the animated diagrams |
| `5-status.md` | Release status, gaps and known issues |

## Rebuild after editing

```
cd docs/process-documentation/build
npm install        # once — installs the markdown converter
npm run build      # source/ → html/
npm run pdf        # html/ → pdf/ (uses the repo's Playwright)
```
