/**
 * First-run onboarding — three ways in: username + password account
 * (Supabase-backed, no email involved), Google OAuth through the default
 * browser, or guest mode (fully offline; data stays in this PC's app-data
 * folder and survives uninstall/reinstall). Also renders the "guest account
 * found — continue?" prompt shown on relaunches after a reinstall, and the
 * one-time username choice for fresh Google sign-ins.
 *
 * Composition: one centered column — brand lockup, one-line message, then a
 * single auth card holding whichever step is active. The page is constant
 * while the card's content swaps (short keyed enter, direction-aware), so
 * every screen reads as the same place.
 *
 * Loading states reflect real operations only: the post-auth
 * "Restoring your library…" card waits for the actual cloud merge.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  CircleUserRound,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { CaptionButtons } from "../components/TopBar";
import { useSession } from "../lib/session";
import {
  availabilityState,
  passwordProblem,
  usernameProblem,
  usernameTypable,
  USERNAME_MIN,
  type UsernameAvailability,
} from "../lib/account-validators";
import brandLogo from "../assets/brand/bytune-logo.svg";
import brandText from "../assets/brand/bytune-Text.svg";

type Screen = "choose" | "signup" | "signin" | "resume" | "restoring" | "pickusername";

/** Raw provider/engine errors → short, human, actionable messages. */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.replace(/^\[.*?\]\s*/, "");
  if (/failed to fetch|fetch failed|networkerror|network error|timeout|timed out/i.test(msg)) {
    return "Couldn't connect right now. Check your connection and try again.";
  }
  if (/invalid login credentials|wrong username or password/i.test(msg)) {
    return "That username or password doesn't match.";
  }
  if (/already registered|already exists|duplicate|username is already taken/i.test(msg)) {
    return "That username is already in use.";
  }
  if (/username_format|violates check constraint/i.test(msg)) {
    // The live database still runs the old username CHECK (see
    // supabase/migrations/0001-username-charset.sql).
    return "That username isn't accepted yet. Try letters and numbers.";
  }
  if (/email confirmation is enabled/i.test(msg)) {
    return "Sign-up is temporarily unavailable. Please try again later.";
  }
  if (/at least \d+ characters|letters, numbers/i.test(msg)) return msg;
  return "Something went wrong. Please try again.";
}

/** Staggered entrance delay for .ob-item elements. */
const dly = (ms: number): React.CSSProperties => ({ ["--ob-delay" as string]: `${ms}ms` });

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

function Spinner() {
  return <Loader2 className="w-4 h-4 animate-spin" />;
}

function ErrorNote({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p
      role="alert"
      className="ob-note text-[12.5px] text-red-400 bg-red-400/[0.08] border border-red-400/20 rounded-[10px] px-3 py-2 mt-3 break-words"
    >
      {msg}
    </p>
  );
}

/** Card buttons — one press/hover/disabled/focus system. Flat desktop press;
    the primary is the only loud element in the card. */
const btnBase =
  "ob-btn h-11 w-full flex items-center justify-center gap-2 rounded-xl px-4 text-[13.5px] font-semibold transition-[background-color,border-color,filter,box-shadow,transform] duration-150 ease-out active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 select-none";
const btnPrimary = `${btnBase} bg-primary text-on-primary hover:brightness-[0.94] disabled:hover:brightness-100`;
const btnSecondary = `${btnBase} bg-ink-hi/[0.06] text-ink-hi border border-ink-hi/[0.1] hover:bg-ink-hi/[0.1] hover:border-ink-hi/[0.18]`;
const btnTertiary = `${btnBase} text-ink border border-ink-hi/[0.16] hover:bg-ink-hi/[0.07] hover:border-ink-hi/[0.3] hover:shadow-[0_0_24px_-6px_rgb(var(--primary)/0.35)]`;
const btnGhost =
  "ob-btn h-9 inline-flex items-center justify-center gap-2 rounded-lg px-3 text-[13px] text-ink-dim hover:text-ink-hi transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed select-none";

/** Card title + optional one-line hint. */
function CardHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-[17px] font-bold tracking-[-0.01em] text-ink-hi">{title}</h2>
      {hint && <p className="text-[13px] text-ink-dim mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
}

/** Text input with a leading glyph and an optional trailing affordance. */
function Field({
  icon: Icon,
  trailing,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  icon: React.ComponentType<{ className?: string }>;
  trailing?: ReactNode;
}) {
  return (
    <div className="relative">
      <Icon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-dim pointer-events-none" />
      <input
        {...props}
        className="h-11 w-full bg-black/25 border border-ink-hi/[0.09] rounded-xl pl-10 pr-4 text-[14px] text-ink-hi outline-none transition-[border-color,background-color,box-shadow] duration-150 placeholder:text-ink-ghost disabled:opacity-50 focus:border-ink-hi/35 focus:bg-black/40 focus:shadow-[0_0_0_3px_rgb(var(--ink-hi)/0.06)]"
      />
      {trailing}
    </div>
  );
}

/** Password input with a reveal toggle — desktop apps never make you type
    a long password blind. */
function PasswordField(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-dim pointer-events-none" />
      <input
        type={show ? "text" : "password"}
        {...props}
        className="h-11 w-full bg-black/25 border border-ink-hi/[0.09] rounded-xl pl-10 pr-12 text-[14px] text-ink-hi outline-none transition-[border-color,background-color,box-shadow] duration-150 placeholder:text-ink-ghost disabled:opacity-50 focus:border-ink-hi/35 focus:bg-black/40 focus:shadow-[0_0_0_3px_rgb(var(--ink-hi)/0.06)]"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-lg text-ink-dim hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Username availability                                               */
/* ------------------------------------------------------------------ */

/**
 * Debounced live availability for a well-formed username. Clearing the timer
 * doesn't cancel a request already in flight, so a slow answer for an earlier
 * name must never overwrite the current one's verdict (stale-guard). A failed
 * lookup reads as "unknown": the form stays submittable and the database
 * UNIQUE constraint decides for real at sign-up.
 */
function useUsernameAvailability(username: string, active: boolean): UsernameAvailability {
  const [state, setState] = useState<UsernameAvailability>("idle");
  useEffect(() => {
    if (!active) {
      setState("idle");
      return;
    }
    let stale = false;
    setState("checking");
    const t = setTimeout(async () => {
      try {
        const res = (await window.bytune?.authUsernameAvailable(username.trim())) as
          | { available: boolean | null; reason?: string }
          | undefined;
        if (!stale) setState(availabilityState(res?.available));
      } catch {
        if (!stale) setState("unknown");
      }
    }, 450);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [username, active]);
  return state;
}

/** Reserved-height status row under the username field. Every state has a
    home here, so availability feedback never shifts the layout. */
function UsernameHint({
  name,
  state,
  formatProblem,
}: {
  name: string;
  state: UsernameAvailability;
  formatProblem: string | null;
}) {
  let content: ReactNode = <>Letters, numbers, _ and @.</>;
  if (formatProblem) {
    content =
      formatProblem === `Username must be at least ${USERNAME_MIN} characters.` ? (
        <>At least {USERNAME_MIN} characters.</>
      ) : (
        <>{formatProblem}</>
      );
  } else if (state === "checking") {
    content = (
      <>
        <Loader2 className="w-3 h-3 animate-spin" /> Checking availability…
      </>
    );
  } else if (state === "free") {
    content = (
      <>
        <Check className="w-3.5 h-3.5" /> {name} is available
      </>
    );
  } else if (state === "taken") {
    content = <>{name} is already taken</>;
  } else if (state === "unknown") {
    content = <>Couldn't check availability. You can still continue.</>;
  }
  return (
    <div
      aria-live="polite"
      className={`h-[18px] mt-1.5 px-1 flex items-center gap-1.5 text-[12px] leading-none ${
        state === "free" && !formatProblem
          ? "text-emerald-400/90"
          : state === "taken" && !formatProblem
            ? "text-amber-400/90"
            : "text-ink-ghost"
      }`}
    >
      {content}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card: username + password form (sign up / sign in)                  */
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

  const formatProblem = mode === "signup" && username.length > 0 ? usernameProblem(username) : null;
  const availability = useUsernameAvailability(
    username,
    mode === "signup" && !formatProblem && username.trim().length >= USERNAME_MIN
  );

  const canSubmit =
    username.trim().length >= USERNAME_MIN &&
    password.length > 0 &&
    (mode === "signin" || (confirm.length > 0 && availability !== "taken" && !formatProblem)) &&
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
    <form onSubmit={(e) => void submit(e)}>
      <CardHead
        title={mode === "signup" ? "Create your account" : "Welcome back"}
        hint={mode === "signup" ? undefined : "Pick up right where you left off."}
      />
      <div className="space-y-3">
        <div>
          <Field
            icon={UserRound}
            autoFocus
            value={username}
            onChange={(e) => setUsername(usernameTypable(e.target.value))}
            placeholder="Username"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            aria-label="Username"
            trailing={
              availability === "checking" ? (
                <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-dim animate-spin" />
              ) : undefined
            }
          />
          {mode === "signup" && (
            <UsernameHint name={username.trim()} state={availability} formatProblem={formatProblem} />
          )}
        </div>
        <PasswordField
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          disabled={busy}
          aria-label="Password"
        />
        {mode === "signup" && (
          <PasswordField
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            autoComplete="new-password"
            disabled={busy}
            aria-label="Confirm password"
          />
        )}
      </div>
      <ErrorNote msg={error} />
      {mode === "signup" && (
        <p className="text-[12px] text-ink-dim mt-3.5 leading-relaxed flex gap-2">
          <ShieldCheck className="w-4 h-4 shrink-0 mt-[1px] text-ink-ghost" />
          <span>There's no email on this account, so your password can't be recovered. Save it somewhere safe.</span>
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
      <button type="button" onClick={() => void google()} className={`${btnSecondary} mt-2.5`} disabled={busy}>
        {busy ? <Spinner /> : <GoogleG className="w-[17px] h-[17px]" />} Continue with Google
      </button>
      <div className="flex items-center justify-between mt-4">
        <button type="button" onClick={onBack} className={btnGhost}>
          Back
        </button>
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
/* Card: choose screen                                                 */
/* ------------------------------------------------------------------ */

function ChooseContent({
  onPick,
  navigate,
}: {
  onPick: (screen: "signup" | "signin") => void;
  navigate: (s: Screen) => void;
}) {
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
    <div>
      <div className="space-y-2.5">
        <button
          onClick={() => onPick("signup")}
          className={`${btnPrimary} ob-item`}
          style={dly(60)}
          disabled={busy !== "none"}
        >
          <UserRound className="w-4 h-4" /> Create account
        </button>
        <button
          onClick={() => onPick("signin")}
          className={`${btnSecondary} ob-item`}
          style={dly(110)}
          disabled={busy !== "none"}
        >
          <KeyRound className="w-4 h-4" /> Sign in
        </button>
        <button
          onClick={() => void google()}
          className={`${btnSecondary} ob-item`}
          style={dly(160)}
          disabled={busy !== "none"}
        >
          {busy === "google" ? <Spinner /> : <GoogleG className="w-[17px] h-[17px]" />} Continue with Google
        </button>
      </div>
      <div className="my-5 flex items-center gap-3 ob-item" style={dly(210)} aria-hidden="true">
        <div className="h-px flex-1 bg-ink-hi/[0.09]" />
        <span className="micro-label text-ink-ghost">or</span>
        <div className="h-px flex-1 bg-ink-hi/[0.09]" />
      </div>
      <button
        onClick={() => void guest()}
        className={`${btnTertiary} ob-item`}
        style={dly(250)}
        disabled={busy !== "none"}
      >
        {busy === "guest" ? (
          <span className="inline-flex items-center gap-2">
            <Spinner /> Starting…
          </span>
        ) : (
          <>
            <CircleUserRound className="w-4 h-4" /> Continue as guest
          </>
        )}
      </button>
      <p className="text-[12px] text-ink-ghost mt-2 leading-relaxed text-center ob-item" style={dly(290)}>
        Guest mode keeps your data on this PC. It survives reinstall, but isn't backed up.
      </p>
      <ErrorNote msg={error} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card: guest resume (reinstall)                                      */
/* ------------------------------------------------------------------ */

function ResumeContent({ onSignInInstead }: { onSignInInstead: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <CardHead title="Welcome back" hint="We found your guest library from a previous install on this PC." />
      <div className="space-y-2.5">
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
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Spinner /> Starting…
            </span>
          ) : (
            "Continue as guest"
          )}
        </button>
        <button disabled={busy} onClick={onSignInInstead} className={btnSecondary}>
          Sign in with an account instead
        </button>
      </div>
      <p className="text-[12px] text-ink-ghost leading-relaxed mt-3.5">
        Signing in later carries your guest data over. Nothing is deleted either way.
      </p>
      <ErrorNote msg={error} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card: restoring — real state, shown while the cloud merge runs      */
/* ------------------------------------------------------------------ */

function RestoringContent() {
  return (
    <div>
      <CardHead title="Restoring your library" />
      <div className="flex items-center gap-3 py-2">
        <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
        <p className="text-[13.5px] text-ink-dim leading-relaxed">
          Playlists, likes and history are coming back.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card: pick username — one-time choice for fresh Google sign-ins     */
/* ------------------------------------------------------------------ */

function PickUsernameContent() {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formatProblem = username.length > 0 ? usernameProblem(username) : null;
  const availability = useUsernameAvailability(
    username,
    !formatProblem && username.trim().length >= USERNAME_MIN
  );

  const save = async (): Promise<void> => {
    if (busy || availability === "taken" || formatProblem) return;
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
    <div>
      <CardHead title="Choose your username" hint="This is how you'll appear in ByTune. You can change it later in Settings." />
      <Field
        icon={UserRound}
        autoFocus
        value={username}
        onChange={(e) => setUsername(usernameTypable(e.target.value))}
        placeholder="Username"
        autoComplete="username"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={busy}
        aria-label="Username"
        trailing={
          availability === "checking" ? (
            <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-dim animate-spin" />
          ) : undefined
        }
      />
      <UsernameHint name={username.trim()} state={availability} formatProblem={formatProblem} />
      <ErrorNote msg={error} />
      <button
        onClick={() => void save()}
        disabled={busy || availability === "taken" || !!formatProblem || username.trim().length < USERNAME_MIN}
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
      <button onClick={() => void skip()} disabled={busy} className={`${btnGhost} w-full mt-2`}>
        Skip for now
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

/** Fine soundwave along the bottom edge — the app's now-playing motif,
    redrawn as a quiet horizon. Stable pseudo-random timings so bars never
    re-randomise between renders, edge-faded so it never reads as a widget. */
function EqualizerStrip() {
  const bars = useState(
    Array.from({ length: 56 }, (_, i) => ({
      duration: 0.9 + ((i * 7919) % 17) / 12,
      delay: ((i * 104729) % 29) / 10,
      height: 0.16 + ((i * 6151) % 84) / 100,
    }))
  )[0];

  return (
    <div className="ob-eq-strip" aria-hidden="true">
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
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const navigate = (s: Screen, d: "fwd" | "back" = "fwd"): void => {
    setDir(d);
    setScreen(s);
  };

  return (
    <div className="ob-root h-screen flex flex-col bg-canvas text-ink overflow-hidden select-none relative">
      {/* Atmosphere: one slow light field above, film grain and a vignette,
          and a fine soundwave on the horizon. Nothing else. */}
      <div aria-hidden="true" className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="ob-light" />
        <div className="ob-light ob-light-b" />
        <div className="ob-grain" />
        <div className="ob-vignette" />
        <EqualizerStrip />
      </div>

      {/* Frameless-window chrome: a bare drag strip with the caption buttons.
          Branding lives in the page, not the title bar. */}
      <div className="app-drag h-12 shrink-0 flex items-start justify-end relative z-10">
        <CaptionButtons />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto relative z-10 flex flex-col">
        <div className="ob-page">
          <div className="ob-hero">
            <div className="ob-lockup">
              <img src={brandLogo} alt="" aria-hidden className="ob-lockup-logo ob-item" />
              <img src={brandText} alt="ByTune" className="ob-lockup-text ob-item" style={dly(70)} />
            </div>
            <h1 className="ob-headline ob-item" style={dly(140)}>
              Your music lives here.
            </h1>
            <p className="ob-tagline ob-item" style={dly(200)}>
              One player for streaming and your own library.
            </p>
          </div>

          <div className="ob-card ob-item" style={dly(260)}>
            <div key={screen} className={`ob-screen ${dir === "back" ? "ob-back" : "ob-fwd"}`}>
              {screen === "choose" && <ChooseContent onPick={(s) => navigate(s)} navigate={navigate} />}
              {screen === "signup" && (
                <UsernamePasswordForm mode="signup" onBack={() => navigate("choose", "back")} navigate={navigate} />
              )}
              {screen === "signin" && (
                <UsernamePasswordForm mode="signin" onBack={() => navigate("choose", "back")} navigate={navigate} />
              )}
              {screen === "resume" && <ResumeContent onSignInInstead={() => navigate("choose", "back")} />}
              {screen === "restoring" && <RestoringContent />}
              {screen === "pickusername" && <PickUsernameContent />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
