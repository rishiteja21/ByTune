/**
 * First-run onboarding — three ways in: username + password account
 * (Supabase-backed, no email involved), Google OAuth through the default
 * browser, or guest mode (fully offline; data stays in this PC's app-data
 * folder and survives uninstall/reinstall). Also renders the "guest account
 * found — continue?" prompt shown on relaunches after a reinstall.
 *
 * Loading states reflect real operations only: the post-auth
 * "Restoring your library…" screen waits for the actual cloud merge.
 */
import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, ShieldCheck, UserRound } from "lucide-react";
import { CaptionButtons } from "../components/TopBar";
import { useSession } from "../lib/session";
import {
  availabilityState,
  passwordProblem,
  usernameProblem,
  usernameTypable,
  USERNAME_MAX,
  USERNAME_MIN,
} from "../lib/account-validators";
import brandLogo from "../assets/brand/bytune-logo.svg";

type Screen = "choose" | "signup" | "signin" | "resume" | "restoring" | "pickusername";

/** Raw provider/engine errors → short, human, actionable messages. */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.replace(/^\[.*?\]\s*/, "");
  if (/failed to fetch|fetch failed|networkerror|network error|timeout|timed out/i.test(msg)) {
    return "Couldn't connect right now. Check your connection and try again.";
  }
  if (/invalid login credentials/i.test(msg)) return "That username or password doesn't match.";
  if (/already registered|already exists|duplicate/i.test(msg)) return "That username is already in use.";
  if (/user already|username is already taken/i.test(msg)) return "That username is already in use.";
  if (/email confirmation is enabled/i.test(msg)) {
    return "Sign-up is temporarily unavailable. Please try again later.";
  }
  if (/at least \d+ characters|letters, numbers/i.test(msg)) return msg;
  return "Something went wrong. Please try again.";
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.32A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.32Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3 2.32C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

function BrandHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="text-center mb-8">
      <img
        src={brandLogo}
        alt="ByTune"
        className="ob-item w-[76px] h-[76px] mx-auto mb-5 animate-[spin_6s_linear_infinite]"
        style={{ ["--ob-delay" as string]: "0ms" }}
      />
      <h2
        className="ob-item font-display text-[26px] font-bold tracking-[-0.02em] mb-1.5 bg-clip-text text-transparent bg-gradient-to-b from-ink-hi to-ink-hi/60"
        style={{ ["--ob-delay" as string]: "70ms" }}
      >
        {title}
      </h2>
      <p
        className="ob-item text-[13.5px] text-ink-dim max-w-[360px] mx-auto leading-relaxed"
        style={{ ["--ob-delay" as string]: "130ms" }}
      >
        {sub}
      </p>
    </div>
  );
}

/** All onboarding buttons share this base — one press/hover/disabled system.
    Hover lifts 1px with a soft white glow; press settles back down. */
const btnBase =
  "w-full flex items-center justify-center gap-2.5 rounded-xl py-3 text-[14.5px] font-semibold transition-all duration-200 ease-out hover:-translate-y-[1.5px] active:translate-y-0 active:scale-[0.99] disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:active:scale-100 select-none";
const btnPrimary = `${btnBase} bg-primary text-on-primary hover:brightness-110 hover:shadow-[0_10px_36px_-10px_rgb(var(--primary)/0.55)]`;
const btnSecondary = `${btnBase} bg-panel border border-ink-hi/[0.09] hover:bg-ink-hi/[0.05] hover:border-ink-hi/[0.2] hover:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.8)] text-ink-hi`;
const btnGhost = "text-[13px] text-ink-dim hover:text-ink-hi py-2 transition-colors disabled:opacity-40";

function Spinner() {
  return <Loader2 className="w-4 h-4 animate-spin" />;
}

function ErrorNote({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p
      role="alert"
      className="text-[12.5px] text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2 mt-3 break-words animate-rise-in"
    >
      {msg}
    </p>
  );
}

function Field({
  icon: Icon,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="relative">
      <Icon className="absolute left-4 top-1/2 -translate-y-1/2 w-[17px] h-[17px] text-ink-dim pointer-events-none" />
      <input
        {...props}
        className="w-full bg-panel border border-ink-hi/[0.1] focus:border-primary/60 rounded-xl pl-11 pr-4 py-3 text-[14px] outline-none transition-colors placeholder:text-ink-dim/60 disabled:opacity-50"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Username + password form (sign up / sign in)                        */
/* ------------------------------------------------------------------ */

function UsernamePasswordForm({
  mode,
  onBack,
  navigate,
}: {
  mode: "signup" | "signin";
  onBack: () => void;
  navigate: (s: Screen) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameState, setUsernameState] = useState<"idle" | "checking" | "free" | "taken">("idle");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const formatProblem = mode === "signup" && username.length > 0 ? usernameProblem(username) : null;

  // Live "is this name free?" — debounced, only for well-formed names.
  useEffect(() => {
    if (mode !== "signup" || formatProblem || username.trim().length < USERNAME_MIN) {
      setUsernameState("idle");
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    setUsernameState("checking");
    debounce.current = setTimeout(async () => {
      try {
        const res = (await window.bytune?.authUsernameAvailable(username.trim())) as
          | { available: boolean | null; reason?: string }
          | undefined;
        setUsernameState(availabilityState(res?.available));
      } catch {
        setUsernameState("idle");
      }
    }, 450);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [username, mode, formatProblem]);

  const canSubmit =
    username.trim().length >= USERNAME_MIN &&
    password.length > 0 &&
    (mode === "signin" || (confirm.length > 0 && usernameState !== "taken" && !formatProblem)) &&
    !busy;

  const google = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const info = (await window.bytune?.authSignInGoogle()) as { needsUsername?: boolean } | undefined;
      if (info?.needsUsername) {
        navigate("pickusername");
        return;
      }
      await window.bytune?.syncNow().catch(() => undefined);
      navigate("restoring");
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    if (mode === "signup") {
      const pwProblem = passwordProblem(password);
      if (pwProblem) {
        setError(pwProblem);
        return;
      }
      if (password !== confirm) {
        setError("Passwords don't match.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const fn = mode === "signup" ? window.bytune?.authSignUp : window.bytune?.authSignIn;
      const info = (await fn?.(username.trim(), password)) as { needsUsername?: boolean } | undefined;
      if (info?.needsUsername) {
        navigate("pickusername");
        return;
      }
      // Real work: pull/merge the account's cloud data before entry.
      navigate("restoring");
      await window.bytune?.syncNow().catch(() => undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="animate-rise-in">
      <BrandHeader
        title={mode === "signup" ? "Create your account" : "Sign in to continue"}
        sub={
          mode === "signup"
            ? "Your library, playlists and history back up to your account automatically."
            : "Your library picks up right where you left it."
        }
      />
      <div className="space-y-3">
        <div className="relative">
          <Field
            icon={UserRound}
            autoFocus
            value={username}
            onChange={(e) => setUsername(usernameTypable(e.target.value))}
            placeholder="Username"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label="Username"
          />
          {usernameState === "checking" && (
            <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-dim animate-spin" />
          )}
          {usernameState === "free" && (
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[11.5px] text-emerald-400" role="status">
              Available
            </span>
          )}
          {usernameState === "taken" && (
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[11.5px] text-amber-400" role="alert">
              Taken
            </span>
          )}
        </div>
        {mode === "signup" && username.length > 0 && formatProblem && (
          <p className="text-[12px] text-ink-dim px-1" role="status">
            {formatProblem === `Username must be at least ${USERNAME_MIN} characters.`
              ? `At least ${USERNAME_MIN} characters. Letters and numbers only.`
              : formatProblem}
          </p>
        )}
        <Field
          icon={KeyRound}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === "signup" ? "Password" : "Password"}
          disabled={busy}
          aria-label="Password"
        />
        {mode === "signup" && (
          <Field
            icon={KeyRound}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            disabled={busy}
            aria-label="Confirm password"
          />
        )}
      </div>
      <ErrorNote msg={error} />
      {mode === "signup" && (
        <p className="text-[12px] text-ink-dim px-1 mt-3 leading-relaxed flex gap-1.5">
          <ShieldCheck className="w-4 h-4 shrink-0 mt-[1px]" />
          <span>
            There's no email on this account, so your password can't be recovered. Save it somewhere safe.
          </span>
        </p>
      )}
      <button type="submit" disabled={!canSubmit} className={`${btnPrimary} mt-5`}>
        {busy ? (
          <>
            <Spinner /> {mode === "signup" ? "Creating account…" : "Signing in…"}
          </>
        ) : mode === "signup" ? (
          "Create account"
        ) : (
          "Sign in"
        )}
      </button>
      <button
        type="button"
        onClick={() => void google()}
        className={`${btnSecondary} mt-2.5`}
        disabled={busy}
      >
        {busy ? <Spinner /> : <GoogleG className="w-[18px] h-[18px]" />} Continue with Google
      </button>
      <div className="flex items-center justify-center mt-3">
        <button type="button" onClick={onBack} className={btnGhost}>
          Back
        </button>
        <span className="text-ink-dim/40 mx-2">·</span>
        <button
          type="button"
          onClick={() => navigate(mode === "signup" ? "signin" : "signup")}
          className={btnGhost}
        >
          {mode === "signup" ? "Sign in instead" : "Create account"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Choose screen                                                       */
/* ------------------------------------------------------------------ */

function ChooseScreen({ onPick, navigate }: { onPick: (screen: "signup" | "signin") => void; navigate: (s: Screen) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"none" | "guest" | "google">("none");

  const guest = async (): Promise<void> => {
    if (busy !== "none") return;
    setBusy("guest");
    setError(null);
    try {
      await window.bytune?.authContinueGuest();
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy("none");
    }
  };

  const google = async (): Promise<void> => {
    if (busy !== "none") return;
    setBusy("google");
    setError(null);
    try {
      const info = (await window.bytune?.authSignInGoogle()) as { needsUsername?: boolean } | undefined;
      if (info?.needsUsername) {
        // Fresh Google user — one-time username choice before entry.
        navigate("pickusername");
        return;
      }
      // Resolves when the browser round-trip lands (or errors out).
      await window.bytune?.syncNow().catch(() => undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("none");
    }
  };

  return (
    <div className="animate-rise-in">
      <BrandHeader
        title="Your music. Your space."
        sub="Create an account to back up your library and playlists, or jump straight in."
      />
      <div className="space-y-2.5">
        <button
          onClick={() => onPick("signup")}
          className={`${btnPrimary} ob-item`}
          style={{ ["--ob-delay" as string]: "200ms" }}
          disabled={busy !== "none"}
        >
          <UserRound className="w-[18px] h-[18px]" /> Create account
        </button>
        <button
          onClick={() => onPick("signin")}
          className={`${btnSecondary} ob-item`}
          style={{ ["--ob-delay" as string]: "270ms" }}
          disabled={busy !== "none"}
        >
          <KeyRound className="w-[18px] h-[18px]" /> Sign in
        </button>
        <button
          onClick={() => void google()}
          className={`${btnSecondary} ob-item`}
          style={{ ["--ob-delay" as string]: "340ms" }}
          disabled={busy !== "none"}
        >
          {busy === "google" ? <Spinner /> : <GoogleG className="w-[18px] h-[18px]" />} Continue with Google
        </button>
      </div>
      <div
        className="my-5 flex items-center gap-3 ob-item"
        style={{ ["--ob-delay" as string]: "410ms" }}
        aria-hidden="true"
      >
        <div className="h-px flex-1 bg-ink-hi/[0.08]" />
        <span className="text-[11px] uppercase tracking-[0.12em] text-ink-dim/70">or</span>
        <div className="h-px flex-1 bg-ink-hi/[0.08]" />
      </div>
      <button
        onClick={() => void guest()}
        className={`${btnGhost} w-full ob-item`}
        style={{ ["--ob-delay" as string]: "470ms" }}
        disabled={busy !== "none"}
      >
        {busy === "guest" ? (
          <span className="inline-flex items-center gap-2">
            <Spinner /> Starting…
          </span>
        ) : (
          "Continue as guest"
        )}
      </button>
      <p
        className="text-[11.5px] text-ink-dim/80 text-center mt-3 leading-relaxed ob-item"
        style={{ ["--ob-delay" as string]: "530ms" }}
      >
        Guests stay on this PC. Data survives reinstall, but isn't backed up.
      </p>
      <ErrorNote msg={error} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Guest resume (reinstall)                                            */
/* ------------------------------------------------------------------ */

function ResumeScreen({ onSignInInstead }: { onSignInInstead: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="animate-rise-in">
      <BrandHeader title="Welcome back" sub="We found guest data from a previous install on this PC." />
      <div className="rounded-2xl bg-panel border border-ink-hi/[0.08] px-5 py-4 flex items-center gap-4">
        <UserRound className="w-7 h-7 text-primary shrink-0" />
        <div>
          <div className="text-[15px] font-semibold">Guest account found</div>
          <div className="text-[12.5px] text-ink-dim mt-0.5 leading-snug">
            Your library, playlists and history from before are still here.
          </div>
        </div>
      </div>
      <div className="mt-5 space-y-2.5">
        <button
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError(null);
            try {
              await window.bytune?.authContinueGuest();
              await useSession.getState().refresh();
            } catch (err) {
              setError(friendlyError(err));
              setBusy(false);
            }
          }}
          className={btnPrimary}
        >
          Continue as guest
        </button>
        <button disabled={busy} onClick={onSignInInstead} className={btnSecondary}>
          Sign in with an account instead
        </button>
        <p className="text-[11.5px] text-ink-dim/80 text-center leading-relaxed pt-1">
          Signing in later carries your guest data over. Nothing is deleted either way.
        </p>
        <ErrorNote msg={error} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Restoring — real state, shown while the cloud merge runs            */
/* ------------------------------------------------------------------ */

function RestoringScreen() {
  return (
    <div className="animate-rise-in text-center">
      <Loader2 className="w-7 h-7 animate-spin text-primary mx-auto mb-4" />
      <h2 className="text-[17px] font-semibold mb-1.5">Restoring your library…</h2>
      <p className="text-[13px] text-ink-dim">Liking songs, playlists and history are coming back.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pick username — one-time choice for fresh Google sign-ins           */
/* ------------------------------------------------------------------ */

function PickUsernameScreen() {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "free" | "taken">("idle");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const formatProblem = username.length > 0 ? usernameProblem(username) : null;

  useEffect(() => {
    if (formatProblem || username.trim().length < USERNAME_MIN) {
      setState("idle");
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    setState("checking");
    debounce.current = setTimeout(async () => {
      try {
        const res = (await window.bytune?.authUsernameAvailable(username.trim())) as
          | { available: boolean | null }
          | undefined;
        setState(availabilityState(res?.available));
      } catch {
        setState("idle");
      }
    }, 450);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [username, formatProblem]);

  const save = async (): Promise<void> => {
    if (busy || state === "taken" || formatProblem) return;
    setBusy(true);
    setError(null);
    try {
      await window.bytune?.authSetUsername(username.trim());
      // Username claimed — now pull/merge the account and enter.
      await window.bytune?.syncNow().catch(() => undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  // Offline-safe escape: keep the auto-generated name (changeable later in
  // Settings) rather than trapping the user without network.
  const skip = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.bytune?.authSkipUsername();
      await window.bytune?.syncNow().catch(() => undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <div className="animate-rise-in">
      <BrandHeader
        title="Set your username"
        sub="This is how you'll be known in ByTune. Letters and numbers only. You can change it later in Settings."
      />
      <div className="relative">
        <Field
          icon={UserRound}
          autoFocus
          value={username}
          onChange={(e) => setUsername(usernameTypable(e.target.value))}
          placeholder="Username"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-label="Username"
        />
        {state === "checking" && (
          <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-dim animate-spin" />
        )}
        {state === "free" && (
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[11.5px] text-emerald-400" role="status">
            Available
          </span>
        )}
        {state === "taken" && (
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[11.5px] text-amber-400" role="alert">
            Taken
          </span>
        )}
      </div>
      <ErrorNote msg={error ?? formatProblem} />
      <button
        onClick={() => void save()}
        disabled={busy || state === "taken" || !!formatProblem || username.trim().length < USERNAME_MIN}
        className={`${btnPrimary} mt-5`}
      >
        {busy ? (
          <>
            <Spinner /> Saving…
          </>
        ) : (
          "Continue"
        )}
      </button>
      <button onClick={() => void skip()} disabled={busy} className={`${btnGhost} w-full mt-1`}>
        Skip for now
      </button>
      <p className="text-[11.5px] text-ink-dim/80 text-center mt-3 leading-relaxed">
        Your library is syncing in the background. This won't take long.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

/** Equalizer strip along the bottom edge — stable pseudo-random timings so
    bars never re-randomise between renders. Purely decorative. */
function EqualizerStrip() {
  const bars = useRef(
    Array.from({ length: 42 }, (_, i) => ({
      duration: 0.8 + ((i * 7919) % 13) / 10,
      delay: ((i * 104729) % 23) / 10,
      height: 0.35 + ((i * 6151) % 65) / 100,
    }))
  ).current;

  return (
    <div className="absolute inset-x-0 bottom-0 h-20 flex items-end justify-center gap-[7px] px-12" aria-hidden="true">
      {bars.map((b, i) => (
        <div
          key={i}
          className="ob-eq-bar eq-bar"
          style={{
            height: `${b.height * 100}%`,
            animationDuration: `${b.duration}s`,
            animationDelay: `${b.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

export function Onboarding({ initial }: { initial: Screen }) {
  const [screen, setScreen] = useState<Screen>(initial);

  return (
    <div className="h-screen flex flex-col bg-canvas text-ink overflow-hidden select-none relative">
      {/* Backdrop stage: drifting light fields, a giant half-cropped vinyl
          turning in the dark, film grain and a vignette. Purely decorative. */}
      <div aria-hidden="true" className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="ob-aurora ob-aurora-a" />
        <div className="ob-aurora ob-aurora-b" />
        <div className="ob-aurora ob-aurora-c" />
        <div className="ob-vinyl-bg ob-vinyl" />
        <div className="ob-vinyl-sheen absolute" style={{ width: 560, height: 560, right: -220, top: "50%", marginTop: -280 }} />
        <div className="ob-grain" />
        <div className="ob-vignette" />
        <EqualizerStrip />
      </div>

      {/* Frameless-window chrome: a drag strip with the caption buttons — the
          main shell gets these from TopBar; onboarding renders none otherwise. */}
      <div className="app-drag h-12 shrink-0 flex items-start justify-end relative z-10">
        <CaptionButtons />
      </div>
      <div className="flex-1 flex items-center justify-center overflow-y-auto relative z-10">
        <div className="w-[400px] max-w-[92vw] py-6">
          {screen === "choose" && <ChooseScreen onPick={setScreen} navigate={setScreen} />}
          {screen === "signup" && (
            <UsernamePasswordForm mode="signup" onBack={() => setScreen("choose")} navigate={setScreen} />
          )}
          {screen === "signin" && (
            <UsernamePasswordForm mode="signin" onBack={() => setScreen("choose")} navigate={setScreen} />
          )}
          {screen === "resume" && <ResumeScreen onSignInInstead={() => setScreen("choose")} />}
          {screen === "restoring" && <RestoringScreen />}
          {screen === "pickusername" && <PickUsernameScreen />}
        </div>
      </div>
    </div>
  );
}
