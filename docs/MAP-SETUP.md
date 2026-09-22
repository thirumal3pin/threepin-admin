# Map view — setting up the Google Maps key

The map in Property Intelligence works in two stages, and the first one needs
nothing from you.

**Already working, with no key and no bill:** 130 of the 131 properties have a
position worked out from the Location column and the area model, so the list,
the precision badges, the "needs a pin" report, "other properties within 5 km"
and every straight-line distance are live right now.

**Needs a key:** the map tiles themselves, and the three answers that ask
Google — nearby schools/hospitals/metro, drive times, and "distance to an
address I type".

Until the key is set the panel says so and names this file. It does not show a
blank grey rectangle.

---

## 1. Create the key

1. <https://console.cloud.google.com> → pick (or create) a project.
2. **APIs & Services → Library** → enable these six:
   - **Maps JavaScript API** — the map itself
   - **Places API (New)** — nearby schools, hospitals, metro, and the
     type-ahead on "Distance to…"
   - **Routes API** — travel times and road distances
   - **Geocoding API** — turning a typed place into a point
   - **Elevation API** — ground height on the property card
   - **Street View Static API** — the street photo on the property card

   > Two of those are the NEW generation, and it matters. Google refuses
   > **legacy Places** and the **Distance Matrix API** to Cloud projects
   > created after March 2025 — they cannot even be switched on. Verified
   > against this deployment's own key, which answers Distance Matrix with:
   >
   > > "You're calling a legacy API, which is not enabled for your project.
   > > To get newer features and more functionality, switch to the Places API
   > > (New) or Routes API."
   >
   > So the code calls **Places API (New)** and the **Routes API**. Enable the
   > old ones instead and every nearby search and every travel time returns
   > nothing, with no error anybody sees.

3. **APIs & Services → Credentials → Create credentials → API key.**

## 2. Restrict it — do not skip this

A browser key is visible to anyone who opens the page. That is unavoidable:
the Maps script will not load without it in the URL. It is protected by
restricting *where* it may be used, not by hiding it.

On the key's page:

- **Application restrictions → Websites.** Add:
  ```
  https://admin.threepin.in/*
  ```
  Add `http://localhost:*/*` too if you want the map while developing.

- **API restrictions → Restrict key**, and tick only the six APIs above.

An unrestricted key on a public page is somebody else's map bill on your
card. This is the one step worth double-checking.

## 3. Put it in Vercel

**Already done** — `GOOGLE_MAPS_BROWSER_KEY` is set on the project for
Production, Preview and Development. Step 2 (the referrer restriction) is the
one still worth checking, and the key should be rotated once the map is
confirmed working, since it has been shared in plain text.

To change it later: Vercel project → **Settings → Environment Variables**:

| Name | Value | Environments |
|---|---|---|
| `GOOGLE_MAPS_BROWSER_KEY` | the key | Production, Preview, Development |

Then **redeploy** — environment variables are read at request time by
`/api/public-config`, but the deployment has to be rebuilt to pick up a new
variable.

## 4. Check it

Open Properties → **Split**. You should see Chennai, muted, with price pills
on it. If not, the panel will tell you which of these it is:

| What the panel says | What it means |
|---|---|
| "No Google Maps key is configured" | The variable is missing, or you have not redeployed since adding it. |
| "Google rejected the Maps key for this site" | The referrer restriction does not cover this domain, an API is not enabled, or billing is off on the project. |
| "The Google Maps script could not be loaded" | Network, or an extension blocking `maps.googleapis.com`. |

---

## What it will cost

Google bills Maps per use, with a monthly free allowance per product. This
build is deliberately frugal, because the cheap path was also the better one:

| What | When it calls Google | Notes |
|---|---|---|
| Positions for all 131 properties | **Never** | Worked out locally from the Location column and the area model. |
| Map tiles | Once per map load | One "dynamic map" load per page view, not per pan or zoom. |
| "Within 5 km" | **Never** | Straight-line, from coordinates already held. |
| "Within 30 minutes" | One Routes request | Candidates are filtered by straight line first and capped at the 24 nearest. Never one request per property. |
| "Distance to…" type-ahead | One per pause in typing | Debounced 220 ms and cached, so a nine-letter place name is not nine requests. |
| Street View photo | One per property, cached | The FREE metadata endpoint is checked first, so the billed image is only requested when a panorama actually exists. |
| Ground height | One per property, cached | Elevation. Shown as height and context, never as a flood verdict. |
| "What is nearby" | One request per category you click | Cached for the rest of the page's life, so clicking back is free. |
| "Distance to…" | One geocode + one route | Cached per typed place. |
| Dropping a pin | **Never** | It is a click on the map. |

Geocoding is **never** run automatically and never in bulk over the
inventory. It exists only behind an explicit "place this one precisely"
action, and the answer is stored on the property document for good.

If you want a hard ceiling, set a **budget alert** on the Cloud project
(Billing → Budgets & alerts). For a team of this size the free monthly
allowance should cover normal use comfortably.

---

## Pins: what the team should actually do

The map separates three states, and only one of them is work:

- **pinned** (green) — an exact position. Distances from it can be quoted to a
  client.
- **~1.5km** (amber) — placed at its locality centre. Right for showing a
  client the area, *not* right for quoting a distance. The card says so, and
  every distance derived from it is given as a range.
- **no pin** — not on the map at all, so it is invisible to every distance
  question. These are worth fixing.

You do not need to pin all 131. Pin the ones you show often, and the ones a
client asks travel questions about. Use **"Does not need one"** to snooze
anything that genuinely does not matter — a plot in a village, a record kept
for history — and it stops appearing in the count.

The fastest way to pin one: open it on the map, **Drop the exact pin**, zoom
right in, click the building, **Save this pin**. It is stored on the property
and survives a Sync from Sheet, because the sheet has no column for it.

### Why the existing Location Pin links do not work

52 properties have something in the Location Pin column, and none of it can be
read for coordinates:

- Most are **shortened links** (`maps.app.goo.gl/…`). A browser cannot follow
  one to find the coordinates — the redirect is blocked cross-origin.
- Several hold a **project name** rather than a URL.

If you want to fix one from the sheet rather than the map: open the short link
in Google Maps, then copy the **full** URL out of the address bar (the long
one containing `@13.08…,80.21…`) and paste that into the column. The map reads
those directly, no key needed.
