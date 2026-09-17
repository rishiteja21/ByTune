/**
 * Supabase auth for ByTune — runs only in the Electron main process.
 *
 * Three identities:
 *  - username + password  → Supabase email auth with a synthetic
 *    `<username>@users.bytune.local` address; uniqueness is guaranteed by a
 *    UNIQUE column in the `profiles` table, not by the auth provider.
 *  - Google OAuth         → PKCE flow through the default browser, coming
 *    back over the bytune:// deep-link protocol.
 *  - guest                → no account at all; a local profile marker only.
 *
 * Session tokens are sealed with Electron safeStorage (DPAPI) into the local
 * `auth` JSON store — the same protection the YouTube cookie gets.
 */
import { app, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import * as persist from "./persist";
import { openSecret, sealSecret } from "./secrets";
import { OAUTH_REDIRECT, SUPABASE_ANON_KEY, SUPABASE_URL, syntheticEmail } from "../src/lib/config";
import { normalizeUsername, passwordProblem, usernameProblem } from "../src/lib/account-validators";

export type AuthMode = "guest" | "account";
export interface LocalProfile {
  mode: AuthMode;
  userId?: string;
  username?: string;
  /** Google sign-ins start with an auto username until the user picks one. */
  pendingUsername?: boolean;
  deviceId: string;
  createdAt: number;
}
export interface SessionInfo {
  mode: AuthMode | null;
  userId: string | null;
  username: string | null;
  /** True right after a reinstall (install dir marker missing, data kept). */
  freshInstall: boolean;
  /** Fresh Google sign-in still using the auto-generated username. */
  needsUsername?: boolean;
}

let client: SupabaseClient | null = null;
let currentSession: Session | null = null;
let freshInstall = false;

/**
 * The install directory is replaced by a reinstall while userData survives —
 * a marker file inside the install dir is therefore a reliable "same
 * install?" signal. Missing marker + surviving profile = fresh install and
 * the renderer should offer the "guest account found — continue?" prompt.
 */
export function initInstallMarker(): void {
  try {
    const appPath = app.getAppPath();
    const installDir = process.env.BYTUNE_GUI_PROFILE || (appPath.endsWith(".asar") ? path.dirname(appPath) : appPath);
    const marker = path.join(installDir, ".bytune-install");
    if (fs.existsSync(marker)) {
      freshInstall = false;
      return;
    }
    fs.writeFileSync(marker, new Date().toISOString(), "utf-8");
    freshInstall = true;
  } catch {
    freshInstall = false; // read-only install dir — never block on this
  }
}

function newDeviceId(): string {
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** For sync.ts — the shared client (null before first use). */
export function getClient(): SupabaseClient | null {
  return client;
}

function supabase(): SupabaseClient {
  if (client) return client;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      autoRefreshToken: true,
      persistSession: false, // we persist ourselves, sealed
    },
  });
  client.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    void persistSession(session);
  });
  return client;
}

/** Restore a sealed session (if any) at boot. */
export async function initAuth(): Promise<void> {
  const sealed = (persist.readData("auth") as { sealed?: string } | null)?.sealed;
  if (!sealed) return;
  const raw = openSecret(sealed);
  if (!raw) return;
  try {
    const stored = JSON.parse(raw) as Session;
    if (!stored?.access_token || !stored?.refresh_token) return;
    const { data, error } = await supabase().auth.setSession({
      access_token: stored.access_token,
      refresh_token: stored.refresh_token,
    });
    if (error) {
      console.warn("[bytune] session restore failed:", error.message);
      return;
    }
    currentSession = data.session;
  } catch (err) {
    console.warn("[bytune] unreadable stored session:", err);
  }
}

async function persistSession(session: Session | null): Promise<void> {
  if (!session) {
    await persist.writeData("auth", null);
    return;
  }
  await persist.writeData("auth", { sealed: sealSecret(JSON.stringify(session)) });
}

/* ------------------------------------------------------------------ */
/* Local profile (guest marker / signed-in marker)                     */
/* ------------------------------------------------------------------ */

export function readProfile(): LocalProfile | null {
  return (persist.readData("profile") as LocalProfile | null) ?? null;
}

async function writeProfile(patch: Partial<LocalProfile> & { mode: AuthMode }): Promise<LocalProfile> {
  const existing = readProfile();
  const next: LocalProfile = {
    deviceId: existing?.deviceId ?? newDeviceId(),
    createdAt: existing?.createdAt ?? Date.now(),
    ...existing,
    ...patch,
  } as LocalProfile;
  await persist.writeData("profile", next);
  return next;
}

export function sessionInfo(): SessionInfo {
  const profile = readProfile();
  if (!profile) return { mode: null, userId: null, username: null, freshInstall };
  if (profile.mode === "guest") return { mode: "guest", userId: null, username: null, freshInstall };
  const username = profile.username ?? null;
  return {
    mode: "account",
    userId: currentSession?.user?.id ?? profile.userId ?? null,
    username,
    freshInstall,
    needsUsername: profile.pendingUsername === true,
  };
}

/**
 * The user id that cloud operations may act as: a LIVE verified session whose
 * user matches the local profile marker. The plain sessionInfo() fallback to
 * the stored profile userId is display-only — a stale/expired token must never
 * authorize pushing or pulling another identity's cloud rows.
 */
export function authenticatedUserId(): string | null {
  const session = currentSession;
  if (!session?.user?.id || !session.access_token) return null;
  const expiresAt = typeof session.expires_at === "number" ? session.expires_at * 1000 : 0;
  if (expiresAt && expiresAt <= Date.now()) return null;
  const profile = readProfile();
  if (profile?.mode !== "account") return null;
  // The profile must already carry the signed-in identity; on first sign-in
  // writeProfile runs before any sync call, so the equality holds then too.
  return profile.userId === session.user.id ? session.user.id : null;
}

/* ------------------------------------------------------------------ */
/* Username + password                                                 */
/* ------------------------------------------------------------------ */

export function validateUsername(username: string): string | null {
  return usernameProblem(username);
}

/** Is the name free? Hits the `profiles` table's UNIQUE backing index. */
export async function usernameAvailable(username: string): Promise<boolean> {
  const clean = normalizeUsername(username);
  const { data, error } = await supabase()
    .from("profiles")
    .select("username")
    .eq("username", clean)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data == null;
}

/**
 * Availability for RENAMING / first-time claim by a signed-in user: the name
 * is free unless it belongs to someone ELSE (claiming your own current name
 * is a no-op, not a conflict).
 */
export async function usernameAvailableToUser(username: string, userId: string | null): Promise<boolean> {
  const clean = normalizeUsername(username);
  const { data, error } = await supabase()
    .from("profiles")
    .select("id")
    .eq("username", clean)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data == null || (userId != null && data.id === userId);
}

export async function signUp(username: string, password: string): Promise<SessionInfo> {
  const clean = normalizeUsername(username);
  const problem = usernameProblem(clean) ?? passwordProblem(password);
  if (problem) throw new Error(problem);
  if (!(await usernameAvailable(clean))) throw new Error("That username is already taken.");

  const { data, error } = await supabase().auth.signUp({
    email: syntheticEmail(clean),
    password,
  });
  if (error) throw new Error(error.message);
  const userId = data.user?.id;
  if (!userId) throw new Error("Sign-up failed — no user returned.");

  // Claim the username; the UNIQUE constraint makes double-claims impossible.
  const { error: pErr } = await supabase()
    .from("profiles")
    .insert({ id: userId, username: clean });
  if (pErr) throw new Error(pErr.message);

  if (!data.session) {
    // Project requires email confirmation — impossible for a synthetic
    // address. Setup instructions say to disable it; surface a clear error.
    throw new Error(
      "Account created but email confirmation is enabled in Supabase. " +
        "Disable 'Confirm email' in Authentication → Sign In / Providers."
    );
  }
  currentSession = data.session;
  await persistSession(data.session);
  const profile = await writeProfile({ mode: "account", userId, username: clean });
  return { mode: profile.mode, userId, username: clean, freshInstall: false };
}

export async function signIn(username: string, password: string): Promise<SessionInfo> {
  const clean = normalizeUsername(username);
  if (!clean || !password) throw new Error("Enter your username and password.");
  const { data, error } = await supabase().auth.signInWithPassword({
    email: syntheticEmail(clean),
    password,
  });
  if (error) throw new Error("Wrong username or password.");
  currentSession = data.session;
  await persistSession(data.session);
  const userId = data.user.id;
  const profile = await writeProfile({ mode: "account", userId, username: clean });
  return { mode: profile.mode, userId, username: profile.username ?? clean, freshInstall: false };
}

/* ------------------------------------------------------------------ */
/* Google OAuth (PKCE through the default browser)                     */
/* ------------------------------------------------------------------ */

let pendingOAuthResolve: ((info: SessionInfo) => void) | null = null;
let pendingOAuthReject: ((err: Error) => void) | null = null;
let pendingOAuthTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Valid callbacks that arrived while no flow was waiting. signInWithOAuth
 * must round-trip before signInGoogle registers its handlers, so a very fast
 * redirect (cached consent, a still-open tab) can beat that registration —
 * park it here and drain it on registration instead of losing the sign-in.
 */
const earlyOAuthCallbacks: string[] = [];

function clearPendingOAuth(): void {
  pendingOAuthResolve = null;
  pendingOAuthReject = null;
  if (pendingOAuthTimer) {
    clearTimeout(pendingOAuthTimer);
    pendingOAuthTimer = null;
  }
}

export async function signInGoogle(): Promise<SessionInfo> {
  const { data, error } = await supabase().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: OAUTH_REDIRECT,
      skipBrowserRedirect: true,
      // Never silently reuse the browser's Google session — always let the
      // user choose which account signs in (shared-PC friendly).
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data?.url) throw new Error(error?.message ?? "Could not start Google sign-in.");

  return new Promise<SessionInfo>((resolve, reject) => {
    // Establish the pending listener BEFORE opening the browser so a very
    // fast redirect can never race an unregistered handler.
    clearPendingOAuth();
    pendingOAuthResolve = resolve;
    pendingOAuthReject = reject;
    // A callback may have landed while signInWithOAuth was still resolving —
    // complete that sign-in instead of opening a second browser tab.
    const early = earlyOAuthCallbacks.splice(0).pop();
    if (early) {
      void handleOAuthCallback(early).catch((err) => console.warn("[bytune] oauth callback:", err.message));
      return;
    }
    void shell.openExternal(data.url).catch((err) => {
      if (pendingOAuthResolve !== resolve) return;
      clearPendingOAuth();
      reject(err instanceof Error ? err : new Error("Could not open the sign-in browser."));
    });
    // The browser tab may simply be closed — give up after 5 minutes.
    pendingOAuthTimer = setTimeout(() => {
      if (pendingOAuthResolve === resolve) clearPendingOAuth();
      reject(new Error("Google sign-in timed out. Please try again."));
    }, 5 * 60 * 1000);
  });
}

/** Deep-link entry point — main.ts hands us the callback URL. */
export async function handleOAuthCallback(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // malformed input — ignore instead of throwing out of the event handler
  }
  const redirect = new URL(OAUTH_REDIRECT);
  // Only the exact registered redirect is accepted: a look-alike scheme/host
  // (or a different path on it) must not be able to complete a sign-in, and
  // the authorization code never travels in a fragment or userinfo.
  if (
    parsed.protocol !== redirect.protocol ||
    parsed.hostname !== redirect.hostname ||
    parsed.pathname.replace(/\/+$/, "") !== redirect.pathname.replace(/\/+$/, "") ||
    parsed.username || parsed.password || parsed.hash ||
    typeof parsed.searchParams.get("code") !== "string" ||
    (parsed.searchParams.get("code") ?? "").length > 512
  ) {
    return;
  }
  // The PKCE verifier and owner-transition continuation belong to this live
  // request. A repeated callback or a cold launch cannot resume that flow —
  // but a VALID one is parked for a sign-in that is still starting up.
  if (!pendingOAuthResolve) {
    earlyOAuthCallbacks.push(url);
    if (earlyOAuthCallbacks.length > 3) earlyOAuthCallbacks.shift();
    return;
  }
  const resolve = pendingOAuthResolve;
  const reject = pendingOAuthReject;
  clearPendingOAuth();
  const code = parsed.searchParams.get("code") as string;
  if (!code) {
    const desc = parsed.searchParams.get("error_description") ?? "Google sign-in didn't complete.";
    const err = new Error(desc.slice(0, 300));
    reject?.(err);
    throw err;
  }
  try {
    const info = await finishGoogleSignIn(code);
    resolve?.(info);
  } catch (err) {
    reject?.(err instanceof Error ? err : new Error("Google sign-in didn't complete."));
    throw err;
  }
}

async function finishGoogleSignIn(code: string): Promise<SessionInfo> {
  const { data, error } = await supabase().auth.exchangeCodeForSession(code);
  if (error) throw new Error(error.message);
  currentSession = data.session;
  await persistSession(data.session);

  const userId = data.user.id;
  // Google users get their Google display name (or email stem) as a default
  // username if the profile row doesn't exist yet — letters/digits only.
  let username = (data.user.user_metadata?.user_name ?? data.user.user_metadata?.name ?? "")
    .toString()
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 20);
  if (username.length < 3) username = `user${userId.slice(0, 8).replace(/[^a-z0-9]/g, "")}`;
  const { data: existing } = await supabase()
    .from("profiles")
    .select("username")
    .eq("id", userId)
    .maybeSingle();
  if (!existing) {
    let finalName = username;
    for (let i = 0; i < 5 && !(await usernameAvailable(finalName)); i++) {
      finalName = `${username}${Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(2, 6)}`;
    }
    const { error: pErr } = await supabase()
      .from("profiles")
      .insert({ id: userId, username: finalName });
    if (pErr) console.warn("[bytune] profile insert failed:", pErr.message);
    username = finalName;
    // Fresh Google user — let them choose a real username once.
    const profile = await writeProfile({ mode: "account", userId, username, pendingUsername: true });
    return { mode: profile.mode, userId, username, freshInstall: false, needsUsername: true };
  }
  username = existing.username;
  const profile = await writeProfile({ mode: "account", userId, username });
  return { mode: profile.mode, userId, username, freshInstall: false };
}

/**
 * One-time username choice for Google sign-ups: claims a username (letters
 * and digits only, UNIQUE-checked) and clears the pending flag.
 */
export async function setUsername(username: string): Promise<SessionInfo> {
  const clean = normalizeUsername(username);
  const problem = usernameProblem(clean);
  if (problem) throw new Error(problem);
  const profile = readProfile();
  const userId = sessionInfo().userId ?? profile?.userId ?? null;
  if (profile?.mode !== "account" || !userId) throw new Error("Sign in with Google first.");
  if (!(await usernameAvailableToUser(clean, userId))) throw new Error("That username is already in use.");
  const { error } = await supabase()
    .from("profiles")
    .update({ username: clean })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  const next = await writeProfile({ mode: "account", username: clean, pendingUsername: false });
  return { mode: next.mode, userId, username: clean, freshInstall: false };
}

/** Offline-safe escape from the pick-username screen: keep the auto name. */
export async function skipUsernameClaim(): Promise<SessionInfo> {
  const profile = readProfile();
  if (profile?.mode === "account" && profile.pendingUsername) {
    await writeProfile({ mode: "account", pendingUsername: false });
  }
  return sessionInfo();
}

/* ------------------------------------------------------------------ */
/* Guest + sign-out                                                    */
/* ------------------------------------------------------------------ */

export async function continueAsGuest(): Promise<SessionInfo> {
  // An account session must not survive a switch to guest: drop the live
  // session and its sealed copy so no later flow can act as the account.
  currentSession = null;
  await persist.writeData("auth", null);
  const profile = await writeProfile({ mode: "guest" });
  // The user answered the resume prompt (if any) — don't ask again.
  freshInstall = false;
  return { mode: profile.mode, userId: null, username: null, freshInstall: false };
}

/** Wipe the guest marker so onboarding shows (used by "Sign in instead"). */
export async function clearGuestProfile(): Promise<void> {
  const profile = readProfile();
  if (profile?.mode === "guest") await persist.writeData("profile", null);
}

export async function signOut(): Promise<SessionInfo> {
  try {
    await supabase().auth.signOut();
  } catch {
    /* offline — clear locally anyway */
  }
  // The local session mirror and sealed copy are cleared unconditionally so
  // an offline sign-out can never leave an authorizing session behind.
  currentSession = null;
  await persistSession(null);
  // Signing out returns to onboarding; data stays on disk.
  await persist.writeData("profile", null);
  return { mode: null, userId: null, username: null, freshInstall: false };
}

/** OS-level protocol registration so bytune:// reaches the running app. */
export function registerProtocol(): void {
  if (process.defaultApp) {
    // electron dev: argv[1] is the entry script.
    app.setAsDefaultProtocolClient("bytune", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("bytune");
  }
}
