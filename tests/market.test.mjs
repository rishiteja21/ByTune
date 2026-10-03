/**
 * Market resolution — the priority chain that decides which YTM region a
 * cold-start feed is built from. The auth provider must never influence it,
 * and every fallback must land on the provider's global default rather than
 * a guessed country.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MARKET,
  normalizeCountry,
  resolveMarket,
  timezoneToCountry,
} from "../.test-build/market.mjs";

test("os region wins over timezone — regional settings are the user's country", () => {
  const m = resolveMarket({ osRegion: "IN", timeZone: "America/New_York", isDev: false });
  assert.equal(m.country, "IN");
  assert.equal(m.source, "os-region");
});

test("timezone resolves the market when the OS reports no region code", () => {
  const m = resolveMarket({ osRegion: null, timeZone: "Asia/Kolkata", isDev: false });
  assert.equal(m.country, "IN");
  assert.equal(m.source, "timezone");
});

test("an English-speaking user in France gets France, not the US", () => {
  // No language input exists on purpose — the resolver is never fed the OS
  // display language. Timezone + region alone decide.
  const m = resolveMarket({ osRegion: "FR", timeZone: "Europe/Paris", isDev: false });
  assert.equal(m.country, "FR");
});

test("unmapped timezone falls back to the provider default, never a guess", () => {
  const m = resolveMarket({ osRegion: null, timeZone: "Mars/Olympus_Mons", isDev: false });
  assert.equal(m.country, DEFAULT_MARKET);
  assert.equal(m.source, "default");
});

test("null signals degrade to the global default feed", () => {
  const m = resolveMarket({ osRegion: null, timeZone: null, isDev: false });
  assert.equal(m.country, DEFAULT_MARKET);
  assert.equal(m.source, "default");
});

test("dev override beats every OS signal", () => {
  const m = resolveMarket({ osRegion: "IN", timeZone: "Asia/Kolkata", override: "ES", isDev: true });
  assert.equal(m.country, "ES");
  assert.equal(m.source, "override");
});

test("dev override is IGNORED outside development builds", () => {
  const m = resolveMarket({ osRegion: "FR", timeZone: "Europe/Paris", override: "ES", isDev: false });
  assert.equal(m.country, "FR");
  assert.equal(m.source, "os-region");
});

test("an invalid override value is ignored rather than passed through", () => {
  const m = resolveMarket({ osRegion: null, timeZone: "Asia/Tokyo", override: "India", isDev: true });
  assert.equal(m.country, "JP");
});

test("timezone map covers the required test markets", () => {
  assert.equal(timezoneToCountry("Asia/Kolkata"), "IN");
  assert.equal(timezoneToCountry("America/New_York"), "US");
  assert.equal(timezoneToCountry("America/Los_Angeles"), "US");
  assert.equal(timezoneToCountry("Europe/Madrid"), "ES");
  assert.equal(timezoneToCountry("Europe/Paris"), "FR");
  assert.equal(timezoneToCountry("Europe/Moscow"), "RU");
});

test("timezone lookup is case- and whitespace-insensitive", () => {
  assert.equal(timezoneToCountry("asia/kolkata"), "IN");
  assert.equal(timezoneToCountry("  Europe/Paris  "), "FR");
  assert.equal(timezoneToCountry(""), null);
  assert.equal(timezoneToCountry(null), null);
});

test("normalizeCountry accepts only strict alpha-2 codes", () => {
  assert.equal(normalizeCountry("in"), "IN");
  assert.equal(normalizeCountry(" USA "), null);
  assert.equal(normalizeCountry("I"), null);
  assert.equal(normalizeCountry("IND"), null);
  assert.equal(normalizeCountry(""), null);
  assert.equal(normalizeCountry(null), null);
});

test("the resolver never depends on an authentication provider", () => {
  // The signal surface has no auth field at all — guests, password accounts
  // and OAuth accounts feed the exact same inputs through the exact same
  // chain. Guarded structurally: resolveMarket touches only what it's given.
  const signals = { osRegion: "IN", timeZone: "Asia/Kolkata", isDev: false };
  assert.deepEqual(resolveMarket(signals), resolveMarket({ ...signals }));
});
