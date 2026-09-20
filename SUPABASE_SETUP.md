# ByTune — Accounts & Cloud Backup Setup

The app now has a first-run screen with three options: **Create account** (username +
password), **Continue with Google**, and **Continue as guest**. Guests stay fully
offline (their data survives uninstall/reinstall on the same PC). Signed-in users get
their library, settings and search history backed up to Supabase automatically.

The app cannot talk to the cloud until you complete the ~10 minutes of setup below.

---

## 1. Create the Supabase project (free)

1. Go to <https://supabase.com> → **New project**. Any name; pick a region near you.
2. Save the database password somewhere (you won't need it in the app).

## 2. Create the tables

1. In the project: **SQL Editor** → **New query**.
2. Paste the whole contents of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   It creates `profiles` (unique usernames) and `user_data` (the synced stores) with
   Row-Level Security so every account can only ever touch its own rows.
3. **Existing projects only:** if the project was set up before usernames allowed
   `_` and `@`, run [`supabase/migrations/0001-username-charset.sql`](supabase/migrations/0001-username-charset.sql)
   once to widen the `profiles.username_format` CHECK constraint. Without it, the
   app accepts `rishi_07`-style names but the database rejects them at sign-up.

## 3. Auth settings (important!)

**Authentication → Sign In / Providers:**

- **Email provider:** leave enabled, but **turn OFF "Confirm email"**. Usernames are
  mapped to synthetic `<username>@users.bytune.local` addresses that can never receive
  a confirmation mail, so confirmation must be off.
- **Google provider:** toggle on. It asks for a Client ID + Secret:

  1. <https://console.cloud.google.com/apis/credentials> → **Create credentials → OAuth client ID**.
  2. Application type **Web application**.
  3. **Authorized redirect URI:** `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
     (exact value shown in the Supabase Google provider panel — copy it from there).
  4. Paste the Client ID + Secret into Supabase and save.

**Authentication → URL Configuration → Redirect URLs:** add

```
bytune://oauth/callback
```

This is the deep link that carries the Google sign-in result back into the desktop app.

## 4. Point the app at your project

**Project Settings → API** — copy the **Project URL** and the **anon public key** into
`src/lib/config.ts`:

```ts
export const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

> The anon key is safe to ship inside the app — it's public by design. Row-Level
> Security (step 2) is what protects the data.

## 5. Rebuild

```bash
npm run build      # or: npm run dist   for the installer
```

---

## How the flows behave

| Flow | What happens |
| --- | --- |
| **Username + password** | Availability is checked live while typing; the UNIQUE column makes double-claims impossible even in a race. No email, no OTP, nothing to verify. **No password recovery** — the sign-up screen warns about this. |
| **Google** | Opens the default browser (no embedded webview, no password harvesting), returns via the `bytune://` deep link, exchanges a PKCE code. |
| **Guest** | Creates only a local profile marker — no network. Data lives in `%APPDATA%/bytune-desktop` (userData), which the NSIS installer does **not** delete on uninstall (`deleteAppDataOnUninstall: false`). |
| **Reinstall as guest** | The app distinguishes a reinstall from a normal launch via a marker file in the *install directory* (wiped on uninstall) while the data in *userData* survives → it shows **"Guest account found — continue?"**. |
| **Guest → account** | Signing in later keeps all local data and merges it into the account on the first sync. Nothing is deleted. |
| **Signed-in sync** | Store writes push to the cloud ~10 s after they happen; sign-in pulls cloud data (auto-restore on a fresh PC). On conflict, newest wins and **the losing version is backed up to `userData/data/backups/` first** — a sync can never silently destroy data. |
| **Secrets** | Supabase session tokens are encrypted with Windows DPAPI (`safeStorage`) in the local `auth` store, same as the YouTube cookie. The cookie, downloads and the local-library cache are never uploaded. |

## Testing checklist

- Sign up with a username, watch the "taken" check, verify the row in Supabase → Table Editor → `profiles`.
- Log out (Settings → ByTune account → Sign out), sign back in.
- Google button → browser opens → returns to the app signed in.
- Guest: make a playlist → uninstall → reinstall → "Guest account found" → Continue → playlist is there.
- Signed in on a wiped data folder → everything restores from the cloud.
