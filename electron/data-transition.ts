import { createHash, randomUUID } from "crypto";
import * as persist from "./persist";
import { SYNCED_STORES } from "../src/lib/config";

const accountStores = new Set<string>([...SYNCED_STORES, "player", "artist-meta-cache"]);
let owner = "guest";
let generation = randomUUID();
const documents = new Map<string, string>();
let tail: Promise<unknown> = Promise.resolve();

/** All account switches, cloud operations and renderer writes share this queue. */
export function serializeData<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.catch(() => undefined).then(work);
  tail = result;
  return result;
}

/** Wait for accepted work, including work appended while draining. Stop producers first. */
export async function drainData(): Promise<void> {
  let observed: Promise<unknown>;
  do {
    observed = tail;
    await observed.catch(() => undefined);
  } while (observed !== tail);
}

function archive(identity: string, name: string): string {
  return `owner-${createHash("sha256").update(identity).digest("hex")}-${name}`;
}

export function initializeOwner(): void {
  const saved = persist.readData("data-owner") as { owner?: string } | null;
  const profile = persist.readData("profile") as { mode?: string; userId?: string } | null;
  const meta = persist.readData("sync-meta") as { lastUserId?: string } | null;
  owner = saved?.owner ?? (profile?.mode === "account" ? profile.userId : undefined) ?? meta?.lastUserId ?? "guest";
}

export function documentScope(): string {
  const token = `${generation}:${randomUUID()}`;
  documents.set(token, owner);
  return token;
}

function documentOwner(token: string): string {
  const identity = documents.get(token);
  if (!identity || !token.startsWith(`${generation}:`)) throw new Error("App data was reset. Reload this document before editing.");
  return identity;
}

export function readForDocument(name: string, token: string): unknown {
  const identity = documentOwner(token);
  return persist.readData(accountStores.has(name) && identity !== owner ? archive(identity, name) : name);
}

/** A late write is saved for its original account, never discarded or assigned to the new one. */
export async function writeForDocument(name: string, data: unknown, token: string): Promise<boolean> {
  const identity = documentOwner(token);
  const current = !accountStores.has(name) || identity === owner;
  await persist.writeData(current ? name : archive(identity, name), data);
  return current;
}

export function isCurrentDocument(token: string): boolean {
  try { return documentOwner(token) === owner; } catch { return false; }
}

export function currentOwner(): string { return owner; }

export async function changeOwner(next: string, migrateGuest: boolean): Promise<void> {
  if (next === owner) return;
  const previous = owner;
  if (previous === "guest" && migrateGuest) {
    for (const [token, identity] of documents) if (identity === previous) documents.set(token, next);
  } else {
    for (const name of accountStores) {
      const local = persist.readData(name) as any;
      await persist.writeData(archive(previous, name), local);
      const saved = persist.readData(archive(next, name)) as any;
      let value = saved;
      if (name === "library") value = { state: { ...(saved?.state ?? {}), downloads: local?.state?.downloads ?? {} }, version: 1 };
      if (name === "settings") {
        const device = Object.fromEntries(["downloadDir", "localMusicFolder"].filter((key) => local?.state?.[key] !== undefined).map((key) => [key, local.state[key]]));
        value = { state: { ...(saved?.state ?? {}), ...device }, version: saved?.version ?? 0 };
      }
      await persist.writeData(name, value);
    }
  }
  owner = next;
  await persist.writeData("data-owner", { owner });
}

export function invalidateResetDocuments(): void {
  generation = randomUUID();
  documents.clear();
  owner = "guest";
}
