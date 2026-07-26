# 3 PIN Realty — Standard Operating Procedures (SOP)

Simple step-by-step guides for the team. Written for a phone. No coding needed
unless a step clearly says "developer only."

**The two apps**
- **CRM** (leads): `https://admin.threepin.in/crm.html` — real login, one account each.
- **Dashboard** (property listings): `https://admin.threepin.in/dashboard.html` — same login as the CRM, one account each.

**When you see "developer only":** that task needs someone who can run commands
on a computer. Call your developer. The manual/console fallback is written out so
they can do it fast.

---

## Index — jump to what you need

**Users & access**
1. [Add a new team member (CRM)](#1-add-a-new-team-member-crm)
2. [Change someone's role or access](#2-change-someones-role-or-access)
3. [Remove someone / stop their access](#3-remove-someone--stop-their-access)
4. [Reset a password / locked out](#4-reset-a-password--locked-out)
5. [See who has access](#5-see-who-has-access)

**Everyday data — leads**
6. [Add a lead](#6-add-a-lead)
7. [Edit a lead](#7-edit-a-lead)
8. [Delete a lead](#8-delete-a-lead)
9. [Move a lead to another stage](#9-move-a-lead-to-another-stage)
10. [Log a follow-up / set the next follow-up](#10-log-a-follow-up--set-the-next-follow-up)
11. [Export leads to Excel](#11-export-leads-to-excel)
12. [Fix a broken / half-saved lead](#12-fix-a-broken--half-saved-lead)
13. ["Reassign" a lead to another person](#13-reassign-a-lead-to-another-person)

**Everyday data — properties (Dashboard)**
14. [Add a property](#14-add-a-property)
15. [Edit a property](#15-edit-a-property)
16. [Mark a property Sold Out](#16-mark-a-property-sold-out)
17. [Delete a property](#17-delete-a-property)

**Media & files**
18. [Add / replace / remove a photo or file](#18-add--replace--remove-a-photo-or-file)
19. [Find where a file lives](#19-find-where-a-file-lives)

**WhatsApp & bot**
20. [Connect a WhatsApp number](#20-connect-a-whatsapp-number)
21. [Turn the follow-up digest on/off](#21-turn-the-follow-up-digest-onoff)

**Operations (developer)**
22. [Deploy a change](#22-deploy-a-change-developer)
23. [Roll back a bad deploy](#23-roll-back-a-bad-deploy-developer)
24. [Back up / restore the database](#24-back-up--restore-the-database-developer)
25. [Rotate an API key safely](#25-rotate-an-api-key-safely-developer)
26. [Add a new environment variable](#26-add-a-new-environment-variable-developer)
27. [Change a Firestore rule or index safely](#27-change-a-firestore-rule-or-index-safely-developer)

**If something breaks**
28. [Site is down](#28-site-is-down)
29. [Nobody can log in](#29-nobody-can-log-in)
30. [Data isn't saving](#30-data-isnt-saving)
31. [Someone deleted something important](#31-someone-deleted-something-important)

---

## Users & access

### 1. Add a new team member (CRM)
**Who:** Owner / developer.
**Note:** There is **no button in the app** to add a user. This is done by a
developer once. *(This is a known gap.)*

**Developer steps (one command):**
1. On the computer with the project, run:
   `node scripts/add-team-member.js --email newperson@threepin.in --tenantId t_3pinrealty`
2. It prints a temporary password. **Copy it now** — it is not saved anywhere.
3. Send the person their email + password.

**What they do:**
1. Open `https://admin.threepin.in/crm.html`
2. Type the email and password.
3. Tap **Login**.

**Worked?** They see the leads board with everyone else's leads.
**Undo:** See [Remove someone](#3-remove-someone--stop-their-access).
**Common mistake:** Using `create-tenant.js` instead — that makes a **separate**
business that can't see your leads. For teammates, always use `add-team-member.js`.

### 2. Change someone's role or access
**Who:** Developer.
Today everyone who can log into the CRM has the **same** powers (there is no
"view only" mode). Roles are recorded but not enforced. *(Known gap.)*
- To fully remove access, see [#3](#3-remove-someone--stop-their-access).
- To limit what someone can do: not possible in the app right now — note it as a
  request to the developer.

### 3. Remove someone / stop their access
**Who:** Owner / developer.
**Best path — Firebase Console (no coding):**
1. Go to `https://console.firebase.google.com` → project **pin-realty**.
2. Left menu → **Build → Authentication → Users**.
3. Find their email. Tap the **⋮** at the end of the row.
4. Tap **Disable account** (reversible) or **Delete account** (permanent).

**What happens to their leads?** Nothing is deleted. Leads stay on the shared
board. The "Added by / Updated by" name on old leads stays as-is.
**Verify:** They can no longer log in.
**Undo:** If you chose *Disable*, tap **Enable** on the same menu.
**Common mistake:** Deleting a lead instead of a user. Users are under
**Authentication**, leads are in the CRM app.

### 4. Reset a password / locked out
**Who:** Owner / developer.
**Firebase Console (no coding):**
1. Console → **pin-realty** → **Authentication → Users**.
2. Find the email → **⋮** → **Reset password** (sends a reset email) **or**
   **Edit** to set a new password directly.
3. Tell the person the new password (if you set one).
**Verify:** They can log in at `/crm.html` — the same account also logs into
`/dashboard.html`.

### 5. See who has access
**Who:** Anyone with Firebase Console access.
1. Console → **pin-realty** → **Authentication → Users**.
2. The list shows every login (both CRM and Dashboard use the same accounts),
   last sign-in, and whether it's disabled.

---

## Everyday data — leads

### 6. Add a lead
**Who:** Any CRM user.
1. Open `/crm.html` and log in.
2. Tap **+ Add Lead** (top bar) — on a phone, the round **+** button bottom-right.
3. Fill the form. Required (marked *): **Channel, Name, Phone, Enquiry Type,
   Property / Locality**.
4. Optional: Email, Budget, Follow-up Date/Time, Notes.
5. Tap **✓ Save Enquiry**.
**Worked?** A green "✓ Enquiry saved" appears and the card shows in the board.
**Undo:** Open the lead → **🗑️ Delete**.
**Common mistake:** A follow-up date in the past is rejected — pick a future date
(add a time if you mean later today).

### 7. Edit a lead
**Who:** Any CRM user.
1. Tap the lead's card to open it.
2. Tap **✏️ Edit** (top right of the panel).
3. Change fields → **✓ Save Enquiry**.
**Worked?** "✓ Enquiry updated"; the change is listed under **🕓 Lead History**.
**Undo:** Edit again to the old value (history keeps a record either way).

### 8. Delete a lead
**Who:** Any CRM user.
1. Open the lead → **🗑️ Delete** → confirm.
**Worked?** "Lead deleted"; it disappears for everyone.
**Undo:** **There is no undo.** If it was a mistake, see
[#31](#31-someone-deleted-something-important).
**Common mistake:** Deleting when you meant "Closed Lost" — instead move the lead
to the **Closed Lost** stage ([#9](#9-move-a-lead-to-another-stage)).

### 9. Move a lead to another stage
**Who:** Any CRM user.
- **On computer:** drag the card into another column, **or** use the **→ [next
  stage]** button on the card.
- **On phone:** open the lead → use the **stage dropdown** near the top → pick a
  stage.
**Worked?** The card moves; history logs "Stage changed…".
**Undo:** Move it back the same way.

### 10. Log a follow-up / set the next follow-up
**Who:** Any CRM user.
1. Open the lead.
2. In the follow-up box, tap **✓ Followed Up**.
3. Type what happened (optional), then pick when to follow up next — quick buttons
   **Tomorrow / +3 days / +1 week / +2 weeks**, or a date, or **No follow-up**.
4. Tap **✓ Save**.
**Worked?** The follow-up banner updates; the lead shows in the **📅 Follow-ups**
view under the right day.
**Remove a follow-up entirely:** tap **✕ Remove** on the follow-up banner.
**Common mistake:** "Followed Up" without a next date is fine — it just means no
further follow-up is scheduled.

### 11. Export leads to Excel
**Who:** Any CRM user.
1. Top bar **☰** menu → **⬇️ Export Leads**.
2. Choose **All / Created Today / Has Movement Today / Date Range**.
3. Tap **⬇️ Export** — a `.xlsx` file downloads.
**Worked?** "✓ Export downloaded"; open it in Excel/Sheets.
**Common mistake:** For **Date Range**, you must pick both a From and a To date.

### 12. Fix a broken / half-saved lead
**Who:** Any CRM user (developer if it won't open).
- If a lead looks wrong (blank name, weird text): open it → **✏️ Edit** → correct
  the fields → **✓ Save**.
- If the lead **won't open or won't save**: it's usually a connection issue — see
  [#30](#30-data-isnt-saving). Refresh the page and try again.
- If a lead has no stage/looks stuck: open it and set a stage from the dropdown.
**Developer fallback:** Firebase Console → **Firestore → `leads`** → find the doc
→ fix the field by hand.

### 13. "Reassign" a lead to another person
**Who:** Any CRM user.
There is no per-person ownership of leads — **everyone on the team sees every
lead**. To hand a lead over, just tell your teammate, or add a note:
1. Open the lead → in **📝 Notes**, type e.g. "Handing to Rajesh — please call".
2. Tap **Add**.
**Worked?** The note (with your name and time) shows for everyone.

---

## Everyday data — properties (Dashboard)

### 14. Add a property
**Who:** Any CRM user (same login as `/crm.html`).
1. Open `/dashboard.html`, log in with your CRM email/password.
2. Tap **+ Add Property** (or the **+** button on phone).
3. Tap **📥 Download JSON Template**, fill it in a notes app, then paste it back
   into the box. (Minimum: **name** and **location**.)
4. Tap **✓ Save Property**.
**Worked?** "✓ Property added"; the card appears for everyone.
**Undo:** Open it → **🗑️ Delete**.
**Common mistake:** Broken JSON (missing comma/quote) — the app shows the error;
fix and paste again.

### 15. Edit a property
**Who:** Any CRM user (same login as `/crm.html`).
1. Tap the property card → **✏️ Edit**.
2. The box is pre-filled with its details — change what you need → **✓ Save
   Property**.
**Worked?** "✓ Property updated".

### 16. Mark a property Sold Out
**Who:** Any CRM user (same login as `/crm.html`).
1. Open the property → **🏷️ Mark Sold Out** (tap again to unmark).
**Worked?** A "SOLD OUT" overlay shows; toast confirms. Use **Hide Sold Out**
filter to hide them.
**Undo:** Same button → **✓ Marked Sold Out** toggles back to active.

### 17. Delete a property
**Who:** Any CRM user (same login as `/crm.html`).
1. Open it → **🗑️ Delete** → confirm.
**Worked?** "Property deleted".
**Undo:** No undo — you'd re-add it. See [#31](#31-someone-deleted-something-important).

---

## Media & files

### 18. Add / replace / remove a photo or file
**Important:** The apps **do not host property photos or image uploads**.
- Property cards show **text only** (no image upload feature exists).
- The only file feature is the **bot Knowledge Base** in the CRM (documents the
  bot could read), not customer-facing images.

**To add a document to the bot's knowledge (CRM):**
1. CRM → **☰ → 🤖 AI Bot** → **📚 Knowledge Base**.
2. Either paste a **Google Sheet/Doc link** (must be shared "Anyone with the
   link") and tap **🔗 Connect**, **or** tap **📄 Upload PDF / TXT**, **or**
   **✍️ Paste text**.
**Replace:** For a linked Sheet/Doc, tap **↻ Sync** to refresh it. For an
uploaded file, remove it and add the new version.
**Remove:** Tap the **🗑️** next to the source.
**Common mistake:** A private Google link fails with "not publicly readable" —
change its sharing to Anyone-with-link (Viewer).

### 19. Find where a file lives
- **Property data & leads:** Firebase Firestore, project **pin-realty**
  (Console → Firestore Database). Collections: `properties`, `leads`.
- **Bot knowledge text:** Firestore → `knowledgeConfigs`.
- **The website files themselves:** the GitHub repo → deployed by Vercel.
- **There is no image/photo storage bucket in use.**

---

## WhatsApp & bot

### 20. Connect a WhatsApp number
**Who:** Owner.
1. CRM → **☰ → 🤖 AI Bot** → **🔌 Channels**.
2. Tap **Connect WhatsApp via Meta**.
3. A Meta popup opens — log in with **your own WhatsApp Business account** and
   follow the steps. Nothing is typed into our site.
4. When done, the card shows a green **Verified** badge with your number.
**Worked?** The WhatsApp card shows "Verified" and your number.
**Undo:** Same card → **Disconnect**.
**Note:** Right now the bot **does not auto-reply** — an incoming message creates
a lead and sends a short "a team member will follow up" message. *(By design for
now.)*
**Common mistake:** Popup blocked — allow popups for `admin.threepin.in` and tap
Connect again.

### 21. Turn the follow-up digest on/off
**Who:** Owner.
1. CRM → **☰ → 🔔 Follow-up Digest**.
2. Tick **WhatsApp digest** and/or **email digest**.
3. Add recipient WhatsApp numbers and/or email addresses (**+ Add** each).
4. Tap **✓ Save**. To test immediately, tap **📤 Send Digest Now**.
**Worked?** "✓ Digest settings saved"; a test send toasts how many went out.
It runs automatically every morning at **9:00 AM IST**.
**Common mistake:** WhatsApp won't deliver to a number that hasn't messaged your
business in the last 24 hours (Meta rule). Email always works if Gmail is set up.

---

## Operations (developer)

### 22. Deploy a change (developer)
**Preferred (automatic):**
1. Commit and `git push` to the **main** branch.
2. Vercel builds and publishes automatically in ~1 minute.
3. Check `https://admin.threepin.in` looks right.
**Console path:** Vercel → project **threepin-admin** → **Deployments** → **⋯ →
Redeploy** on the latest.
**Verify:** The Deployments list shows the new build as **Ready / Production**.

### 23. Roll back a bad deploy (developer)
**Preferred (instant, no rebuild):**
1. Vercel → **threepin-admin** → **Deployments**.
2. Find the last good deployment → **⋯ → Promote to Production**.
**Alternative:** `git revert <bad-commit>` then `git push`.
**Verify:** The site works again; the promoted build shows as Production.

### 24. Back up / restore the database (developer)
**Back up:** Firebase Console → **Firestore Database → Import/Export** → **Export**
→ choose a Cloud Storage bucket. Do this before any bulk change.
**Restore:** Same screen → **Import** → pick the export folder.
**Preferred over manual edits** for anything large — one bad bulk edit can't be
undone otherwise.

### 25. Rotate an API key safely (developer)
General rule: **create new → update Vercel → redeploy → then revoke old.**
1. Create the new key at the provider (Anthropic / Meta / Gmail App Password /
   Firebase service account).
2. Vercel → **threepin-admin → Settings → Environment Variables** → edit the
   variable → paste the new value → Save.
3. **Redeploy** (env changes need a new build) — see [#22](#22-deploy-a-change-developer).
4. Confirm the feature works, then revoke/delete the old key at the provider.
**Special case — `META_APP_SECRET`:** update Meta and Vercel close together, or
webhook signature checks will fail in between.

### 26. Add a new environment variable (developer)
1. **Local:** add it to `.env.local` (used by `vercel dev`).
2. **Vercel:** **Settings → Environment Variables → Add** → set it for
   **Production** (and Preview if needed).
3. **Redeploy.**
**Verify:** The function that reads it works (check Vercel → Logs).

### 27. Change a Firestore rule or index safely (developer)
**Rules are NOT auto-deployed from the repo.** The source is
[`firestore.rules`](firestore.rules).
1. Edit `firestore.rules` in the repo (keep it the source of truth).
2. Firebase Console → **Firestore → Rules** → paste the new rules → **Publish**.
3. Test: log into the CRM and confirm reads/writes still work; confirm a
   different tenant still can't see your data.
**Index:** If the Console shows "this query requires an index", click the provided
link to create it and wait for it to finish building.
**Undo:** Re-publish the previous rules (keep a copy before changing).

---

## If something breaks

### 28. Site is down
Check these **in order**:
1. **Is it just you?** Try mobile data / another device. If only you → your
   network.
2. **Vercel status:** Vercel → **threepin-admin → Deployments**. Is the latest
   **Ready**, or did a deploy **fail/error**? If failed → [roll back](#23-roll-back-a-bad-deploy-developer).
3. **Firebase status:** [status.firebase.google.com](https://status.firebase.google.com)
   — an outage means data won't load.
4. **Domain/DNS:** does `threepin-admin.vercel.app` work but `admin.threepin.in`
   doesn't? Then it's the domain — check Vercel → Settings → Domains.
5. **Recent change?** If a deploy went out just before it broke →
   [roll back](#23-roll-back-a-bad-deploy-developer).

### 29. Nobody can log in
- **CRM (`/crm.html`):**
  1. Firebase status ok? (see [#28](#28-site-is-down)).
  2. Firebase Console → **Authentication → Users**: is the account there and not
     **disabled**?
  3. Reset the password ([#4](#4-reset-a-password--locked-out)).
  4. "No access / board empty after login" → the account is missing its tenant
     link; developer runs `add-team-member.js` ([#1](#1-add-a-new-team-member-crm)).
- **Dashboard (`/dashboard.html`):** same login as the CRM — if it fails here
  too, follow the CRM steps above (same Firebase account).

### 30. Data isn't saving
1. **Refresh** the page and try once more.
2. **Check connection** — a "Save failed / check your connection" toast means the
   change didn't sync. Get back online and redo it.
3. **CRM or Dashboard:** if the console shows "permission denied", the login may
   have lost its tenant link — log out and back in; if it persists, developer
   checks the `tenantId` claim.
4. **Two people editing the same record** can overwrite each other — last save
   wins. Coordinate on hot records.

### 31. Someone deleted something important
- **There is no in-app undo** for deletes.
- **Best recovery:** restore from the most recent Firestore **backup/export**
  ([#24](#24-back-up--restore-the-database-developer)). This is why backups
  matter — set them up if they aren't running.
- If there's no backup, the item must be **re-created by hand** from any notes,
  the Excel export ([#11](#11-export-leads-to-excel)), or email records.
- **Prevent repeats:** turn on scheduled Firestore exports and keep a weekly lead
  export.
```
