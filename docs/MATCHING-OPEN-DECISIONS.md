# Matching — the decisions that need you

Three independent reviews went over the matching engine, the Chennai area
model and the map view: a premium-real-estate designer, a Chennai broker of
15 years, and a sales-ops lead who walked six client calls click by click.

Everything that was a **bug** or a **defensible judgement** is already fixed
and deployed. What is left are things that turn on facts about *your* market
and *your* business, where guessing would be worse than asking. Each one below
says what the reviewer said, what it would change, and what I need from you.

---

## 1. Flooding — the biggest single gap

**What the broker said, and I think they are right:** flooding appears
nowhere — not as an attribute, not a concept, not an objection, not a locality
flag. In a city where December 2015, November 2021 and Michaung are how buyers
date their lives, that is the largest omission in the engine. A buyer who was
flooded once will not look at a ground floor in a known-flooding locality *at
any price*. That is a veto, not a deduction.

**What I have already done:** nothing that asserts a fact. The lexicon side is
safe to add and I will add it on your word — "water stagnation", "water
logging", "low lying", "2015-la thanni vandhucha", "thanni", "kuzhi" as an
objection kind, plus a floor interaction (a ground or stilt+1 floor weighs
differently once a buyer has raised water).

**What I will not do without you:** mark named localities as flood-prone.
Writing "Velachery floods" into the repo is a claim about a real place that
affects what you show real clients, and per your own rule I am not inventing
facts about places. The broker named: **Velachery, Mudichur, Perungalathur,
Pallikaranai, Perumbakkam, Semmancheri, Mugalivakkam, Manapakkam,
Kotturpuram, Ashok Nagar / West Mambalam, Madipakkam**.

**What I need:** confirm or correct that list, with a severity if you want one
(avoid entirely / ground floor only / fine now the drains are done). It goes
in `shared-assets/chennai-geo.js` as a documented table you can edit.

---

## 2. Budget is scored against the sticker, not the cheque

**What the broker said:** a Chennai buyer's "1 crore" means 1 crore all-in,
and the asking price is not that. On top of it sits **stamp duty 7% +
registration 4%**, and on a new build **GST 5%** (nil on a completed flat with
OC), plus car park, corpus fund, club charge and utility deposits. So a
"₹1 Cr" property is already ~11–14% over a "₹1 Cr" buyer — and an
under-construction unit is not the same cheque as a ready resale at the same
sticker.

**What it would change:** score against `budget × 0.90` for ready/resale and
`× 0.87` for under-construction, unless the lead's own words say "all
inclusive". Today's 0.78-at-17%-over band is, on that reading, quietly closer
to 30% over.

**Why I have not done it:** it moves every score in the product, and the
multiplier is a commercial judgement about how your buyers think and quote.
The tax rates are not in doubt; how you want them applied is.

**What I need:** either "apply it at 0.90 / 0.87", or your own numbers, or
"leave it — my team quotes all-in budgets anyway".

---

## 3. Builder tier

**What the broker said:** a Chennai buyer pays 10–15% more for a known
developer than for a local builder on the same street, and refuses one with a
delay record outright. Today the engine only scores a builder when the buyer
*named* one — so a strong-brand property gets **zero** credit with a buyer who
just said "3BHK Anna Nagar 3 Cr", which is exactly the call where the brand is
the opening line. The weight should roughly double.

**Why I have not done it:** ranking named companies into tiers is a commercial
opinion about real businesses you work with. It is not mine to write.

**What I need:** a rough grouping of the builders in your inventory — say
three buckets (premium / solid / be careful) — or a note that you would rather
the engine stayed out of it. There is a hook waiting for the table.

---

## Smaller items from the same reviews, worth a yes/no

| Item | What it changes | Effort |
|---|---|---|
| **Peer-locality table** — who actually cross-shops with whom. An Anna Nagar buyer looks at Mogappair and Kilpauk, never Perambur at the same distance. The broker called this the highest-value geography fix left. | Would override raw kilometres with real substitution behaviour. Needs your list per cluster. | Half a day once the lists exist |
| **Legal / paperwork weight** — patta, EC, parent document, deviation, OC. The broker argues Chennai deals die on documents more than on price, and wants approval's weight raised from 4 to 11 and made veto-capable for loan buyers. | Big scoring shift; also needs the inventory to actually carry these fields, which it mostly does not yet. | Depends on data |
| **CRZ on the ECR corridor**, and **HR&CE / Wakf land** in the old city | Both are real Chennai traps the engine cannot see. Same objection: they are factual claims per locality. | Small, once confirmed |
| **Tanglish in the objection lexicon** — *adhigam, kammi, dooram, illa, pidikala, nalla illa, thanni, yosikkiren, paarkalam*. | If your team writes notes in Tanglish, most objection signal is currently invisible. I can add these safely — they are language, not facts about places. | Say the word |
| **Stall reasons separated from defects** — "waiting for a muhurtham", "Aadi month", "need to discuss with family" are currently read as problems with the *property*. | Stops a lead being mis-ranked because of a timing reason. | Safe to do, say the word |
| **Travel mode on distance** — Drive / Metro / Walk. Currently driving only, though there is a Metro & rail category. | "How long by metro" is a standard Chennai question. | Small |
| **"Only mine" filter on the buyer list** — the count is currently the whole team's, so "how many of *my* buyers" cannot be answered. | Needs an owner field on leads that is reliably filled. | Small |

---

## And one I will flag but not recommend

The broker noted that community, vegetarian-only and religion preferences are
spoken openly in parts of central Chennai and decide a large share of deals
there. **I have not built anything to weight that, and I would advise against
it** — it is discriminatory and legally exposed.

Their narrower point is fair, though: when such a preference is the real
reason a match dies, the engine currently recommends confidently into a wall
it cannot see. If you want, the honest middle is to let an agent record it as
a plain note on the lead that the panel surfaces as context, without any
scoring attached. Your call.
