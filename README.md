# admin.threepin.in

A single static page — no build step, no framework. Vercel deploys plain
HTML with zero configuration.

## 1. Push to GitHub

```
cd admin-threepin
git init
git add .
git commit -m "Initial admin landing page"
```

Then on github.com: New repository → name it e.g. `threepin-admin` →
**do not** initialize with a README (you already have one) → Create.

GitHub will show you two lines like these — run them:
```
git remote add origin https://github.com/<your-username>/threepin-admin.git
git branch -M main
git push -u origin main
```

## 2. Import into Vercel

1. Go to https://vercel.com → **Add New → Project**.
2. Connect your GitHub account if prompted, then select `threepin-admin`.
3. Framework preset: Vercel will detect "Other" — that's correct, leave all
   build settings blank/default. Click **Deploy**.
4. You'll get a live URL immediately, like `threepin-admin.vercel.app`
   — check it looks right before touching any DNS.

## 3. Add the subdomain in Vercel

1. In the project → **Settings → Domains** → type `admin.threepin.in` → Add.
2. Vercel will show you a record to create — for a subdomain it's usually:
   - **Type**: CNAME
   - **Name**: `admin`
   - **Value**: `cname.vercel-dns.com`
   (Vercel shows the exact value on screen — use exactly what it displays,
   it occasionally differs slightly.)

## 4. Add that record in GoDaddy

1. GoDaddy → **My Products → DNS** next to threepin.in.
2. **Add record**:
   - Type: `CNAME`
   - Name: `admin`
   - Value: (paste exactly what Vercel showed you)
   - TTL: default is fine.
3. Save.

This only creates a new record for the `admin` subdomain — your existing
`@` (root) and `www` records for threepin.in are untouched, so your current
site keeps running exactly as it is.

## 5. Wait and verify

DNS usually propagates in a few minutes, sometimes up to an hour. Back in
Vercel → Settings → Domains, it'll show a green checkmark next to
`admin.threepin.in` once it's live. Visit it directly to confirm.

---

Once this pipeline works end to end, redeploying is just:
```
git add .
git commit -m "update"
git push
```
Vercel auto-deploys on every push to `main` — no manual redeploy step ever
needed again.
