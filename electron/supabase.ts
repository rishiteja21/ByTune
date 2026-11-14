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
import {
  DISPLAY_NAME_MAX,
  displayNameProblem,
  normalizeDisplayName,
  normalizeUsername,
  passwordProblem,
  usernameProblem,
} from "../src/lib/account-validators";

export type AuthMode = "guest" | "account";
export interface LocalProfile {
  mode: AuthMode;
  userId?: string;
  username?: string;
  /** Google sign-ins start with an auto username until the user picks one. */
  pendingUsername?: boolean;
  /** What people see (Rooms, the avatar). An account's is kept on the server too (display_names). */
  displayName?: string;
  /** Saved here while the server couldn't take it: sent at the next sync. */
  displayNamePending?: boolean;
  /** A new Google account's name (or the guest's, carried over), offered while it picks a username. */
  suggestedDisplayName?: string;
  deviceId: string;
  createdAt: number;
}
export interface SessionInfo {
  mode: AuthMode | null;
  userId: string | null;
  username: string | null;
  displayName?: string | null;
  /** Offered as the display name: a guest's own as they create an account, or a new Google account's. */
  suggestedDisplayName?: string;
  /** True right after a reinstall (install dir marker missing, data kept). */
  freshInstall: boolean;
  /** Fresh Google sign-in still using the auto-generated username. */
  needsUsername?: boolean;
  /**
   * True only when this call CREATED the account (sign-up, or a first-ever
   * Google sign-in). A guest's local data migrates up into a new account, but
   * must never be mixed into an existing one — the account's own cloud copy
   * is what should appear.
   */
  isNewAccount?: boolean;
}

let client: SupabaseClient | null = null;
let currentSession: Session | null = null;
let freshInstall = false;
/** A guest's display name while they go through sign-up (clearGuestProfile empties the profile first). */
let carriedName: string | null = null;

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

/** False in a build without ByTune's Supabase project (config.ts): it runs guest-only. */
const cloudConfigured = (): boolean => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

function supabase(): SupabaseClient {
  if (client) return client;
  if (!cloudConfigured()) throw new Error("Accounts aren't available in this build of ByTune.");
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
  if (!cloudConfigured()) return;
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
  if (!profile) {
    return { mode: null, userId: null, username: null, displayName: null, freshInstall, ...(carriedName ? { suggestedDisplayName: carriedName } : {}) };
  }
  if (profile.mode === "guest") {
    return { mode: "guest", userId: null, username: null, displayName: profile.displayName ?? null, freshInstall };
  }
  const username = profile.username ?? null;
  return {
    mode: "account",
    userId: currentSession?.user?.id ?? profile.userId ?? null,
    username,
    displayName: profile.displayName ?? null,
    freshInstall,
    needsUsername: profile.pendingUsername === true,
    ...(profile.pendingUsername && profile.suggestedDisplayName ? { suggestedDisplayName: profile.suggestedDisplayName } : {}),
  };
}

/**
 * The profile for an account just signed in. Its display name is the account's own: one left by
 * another identity doesn't come along, and a guest's name carried for a sign-up is used up.
 */
async function accountProfile(userId: string, patch: Partial<LocalProfile>): Promise<LocalProfile> {
  carriedName = null;
  const same = readProfile()?.userId === userId;
  return writeProfile({
    ...(same ? {} : { displayName: undefined, displayNamePending: undefined, suggestedDisplayName: undefined }),
    ...patch,
    mode: "account",
    userId,
  });
}

/* ------------------------------------------------------------------ */
/* Display name                                                        */
/* ------------------------------------------------------------------ */

function nameError(message: string): Error {
  // The migration isn't on the server yet: PostgREST can't find the table.
  if (/schema cache|could not find the table|does not exist/i.test(message)) {
    return new Error("Display names aren't set up on ByTune's server yet.");
  }
  return new Error(message);
}

async function fetchDisplayName(userId: string): Promise<string | null> {
  const { data, error } = await supabase().from("display_names").select("name").eq("user_id", userId).maybeSingle();
  if (error) throw nameError(error.message);
  return typeof data?.name === "string" ? data.name : null;
}

async function pushDisplayName(userId: string, name: string): Promise<void> {
  const { error } = await supabase().from("display_names").upsert({ user_id: userId, name });
  if (error) throw nameError(error.message);
}

/** Writes only while the profile is still this account's: an answer after a sign-out mustn't sign it back in. */
async function patchAccount(userId: string, patch: Partial<LocalProfile>): Promise<void> {
  const profile = readProfile();
  if (profile?.mode === "account" && profile.userId === userId) await writeProfile({ ...patch, mode: "account" });
}

/** A new account's name: to the server, or (it can't take it now) kept here and sent at the next sync. */
async function claimDisplayName(userId: string, name: string): Promise<void> {
  let pending = false;
  try {
    await pushDisplayName(userId, name);
  } catch (err) {
    pending = true;
    console.warn("[bytune] display name not saved on the server yet:", err instanceof Error ? err.message : err);
  }
  await patchAccount(userId, { displayName: name, displayNamePending: pending || undefined, suggestedDisplayName: undefined });
}

/** Settings: an account's name goes to the server first (every device and room gets it there); a guest's stays here. */
export async function setDisplayName(raw: string): Promise<SessionInfo> {
  const name = normalizeDisplayName(raw);
  const problem = displayNameProblem(name);
  if (problem) throw new Error(problem);
  const profile = readProfile();
  if (profile?.mode === "guest") {
    await writeProfile({ mode: "guest", displayName: name });
    return sessionInfo();
  }
  const userId = authenticatedUserId();
  if (profile?.mode !== "account" || !userId) throw new Error("Sign in again to change your display name.");
  await pushDisplayName(userId, name);
  await patchAccount(userId, { displayName: name, displayNamePending: undefined });
  return sessionInfo();
}

/**
 * Puts this computer's copy of the account's name in step with the server's: one saved here while the
 * server couldn't take it is sent now; otherwise the server's counts (another device may have changed
 * it, and a name it doesn't have isn't this account's). True when the name shown here changed.
 */
export async function syncDisplayName(): Promise<boolean> {
  const profile = readProfile();
  const userId = authenticatedUserId();
  if (profile?.mode !== "account" || !userId) return false;
  try {
    if (profile.displayNamePending && profile.displayName) {
      await pushDisplayName(userId, profile.displayName);
      await patchAccount(userId, { displayNamePending: undefined });
      return false;
    }
    const remote = await fetchDisplayName(userId);
    if ((remote ?? undefined) === profile.displayName) return false;
    await patchAccount(userId, { displayName: remote ?? undefined });
    return true;
  } catch (err) {
    console.warn("[bytune] display name sync failed:", err instanceof Error ? err.message : err);
    return false;
  }
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

export async function signUp(username: string, password: string, displayName: string): Promise<SessionInfo> {
  const clean = normalizeUsername(username);
  const name = normalizeDisplayName(displayName);
  const problem = usernameProblem(clean) ?? passwordProblem(password) ?? displayNameProblem(name);
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
  const profile = await accountProfile(userId, { username: clean });
  await claimDisplayName(userId, name);
  return { mode: profile.mode, userId, username: clean, displayName: name, freshInstall: false, isNewAccount: true };
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
  const profile = await accountProfile(userId, { username: clean });
  return { mode: profile.mode, userId, username: profile.username ?? clean, freshInstall: false, isNewAccount: false };
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
    // The display name offered with the username choice: the guest's own if they had one, else the
    // name on the Google account (cut to the length a display name can be).
    const meta = data.user.user_metadata ?? {};
    const fromGoogle = normalizeDisplayName([...normalizeDisplayName(String(meta.full_name ?? meta.name ?? ""))].slice(0, DISPLAY_NAME_MAX).join(""));
    const suggested = carriedName ?? (fromGoogle || undefined);
    // Fresh Google user — let them choose a real username once.
    const profile = await accountProfile(userId, { username, pendingUsername: true, suggestedDisplayName: suggested });
    return { mode: profile.mode, userId, username, freshInstall: false, needsUsername: true, isNewAccount: true };
  }
  username = existing.username;
  const profile = await accountProfile(userId, { username });
  return { mode: profile.mode, userId, username, freshInstall: false, isNewAccount: false };
}

/**
 * One-time username choice for Google sign-ups: claims a username (letters
 * and digits only, UNIQUE-checked) and clears the pending flag. Settings
 * renames through here too. The Google screen sends the display name along.
 */
export async function setUsername(username: string, displayName?: string): Promise<SessionInfo> {
  const clean = normalizeUsername(username);
  const name = displayName === undefined ? null : normalizeDisplayName(displayName);
  const problem = usernameProblem(clean) ?? (name === null ? null : displayNameProblem(name));
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
  if (name !== null) await claimDisplayName(userId, name);
  return { mode: next.mode, userId, username: clean, freshInstall: false };
}

/** Offline-safe escape from the pick-username screen: keep the auto name (and the display name, if one was given). */
export async function skipUsernameClaim(displayName?: string): Promise<SessionInfo> {
  const profile = readProfile();
  if (profile?.mode === "account" && profile.pendingUsername) {
    await writeProfile({ mode: "account", pendingUsername: false, suggestedDisplayName: undefined });
    const name = normalizeDisplayName(displayName ?? "");
    if (profile.userId && !displayNameProblem(name)) await claimDisplayName(profile.userId, name);
  }
  return sessionInfo();
}

/* ------------------------------------------------------------------ */
/* Guest + sign-out                                                    */
/* ------------------------------------------------------------------ */

/** A guest's display name is optional: given, it's checked; left out, a guest keeps the one they had. */
export async function continueAsGuest(displayName?: string): Promise<SessionInfo> {
  const given = normalizeDisplayName(displayName ?? "");
  const problem = given ? displayNameProblem(given) : null;
  if (problem) throw new Error(problem);
  // An account session must not survive a switch to guest: drop the live
  // session and its sealed copy so no later flow can act as the account.
  currentSession = null;
  await persist.writeData("auth", null);
  const was = readProfile();
  const kept = was?.mode === "guest" ? was.displayName : (carriedName ?? undefined);
  const profile = await writeProfile({ mode: "guest", displayName: given || kept, displayNamePending: undefined, suggestedDisplayName: undefined });
  carriedName = null;
  // The user answered the resume prompt (if any) — don't ask again.
  freshInstall = false;
  return { mode: profile.mode, userId: null, username: null, displayName: profile.displayName ?? null, freshInstall: false };
}

/** Wipe the guest marker so onboarding shows (used by "Sign in instead"). The guest's name is offered at sign-up. */
export async function clearGuestProfile(): Promise<void> {
  const profile = readProfile();
  if (profile?.mode === "guest") {
    carriedName = profile.displayName ?? null;
    await persist.writeData("profile", null);
  }
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
