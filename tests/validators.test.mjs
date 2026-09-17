import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityState,
  normalizeUsername,
  usernameProblem,
  passwordProblem,
  usernameTypable,
} from "../.test-build/account-validators.mjs";

test("normalizeUsername lowercases and trims", () => {
  assert.equal(normalizeUsername("  Rishi21 "), "rishi21");
});

test("usernameTypable strips illegal characters as the user types", () => {
  assert.equal(usernameTypable("ri_shi.21"), "rishi21");
  assert.equal(usernameTypable("rishi 21!"), "rishi21");
});

test("valid usernames pass", () => {
  for (const name of ["rishi", "Rishi21", "rishi2026", "abc", "a".repeat(20)]) {
    assert.equal(usernameProblem(name), null, name);
  }
});

test("underscores, spaces, dots, hyphens and symbols are rejected", () => {
  for (const name of ["rishi_21", "rishi 21", "rishi.21", "rishi-21", "rishi@21", "rishi🎉"]) {
    assert.notEqual(usernameProblem(name), null, name);
  }
});

test("length bounds enforced", () => {
  assert.notEqual(usernameProblem("ab"), null); // too short
  assert.notEqual(usernameProblem("a".repeat(21)), null); // too long
});

test("uniqueness is case-insensitive: same normalized form", () => {
  assert.equal(normalizeUsername("Rishi21"), normalizeUsername("rishi21"));
});

test("password minimum length", () => {
  assert.equal(passwordProblem("longenough1"), null);
  assert.notEqual(passwordProblem("short"), null);
});

test("failed availability lookups read as unknown, never taken (H3)", () => {
  assert.equal(availabilityState(true), "free");
  assert.equal(availabilityState(false), "taken");
  // Offline / network error: the form must stay submittable, not show "Taken".
  assert.equal(availabilityState(null), "idle");
  assert.equal(availabilityState(undefined), "idle");
});
