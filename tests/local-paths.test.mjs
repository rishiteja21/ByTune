import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnderPath } from "../.test-build/local-paths.mjs";

test("a child folder is under its root at any depth", () => {
  assert.equal(isUnderPath("D:\\Music\\English\\Pop", "D:\\Music"), true);
  assert.equal(isUnderPath("D:\\Music\\English", "D:\\Music"), true);
});

test("the root itself counts as under (a folder entry covers its own path)", () => {
  assert.equal(isUnderPath("D:\\Music", "D:\\Music"), true);
});

test("siblings and unrelated drives are not under", () => {
  assert.equal(isUnderPath("D:\\Music\\English", "D:\\Music\\Hindi"), false);
  assert.equal(isUnderPath("E:\\Music\\English", "D:\\Music"), false);
  assert.equal(isUnderPath("D:\\MusicX\\a.mp3", "D:\\Music"), false);
});

test("prefix sharing must not pass without a separator", () => {
  assert.equal(isUnderPath("D:\\Music2\\a.mp3", "D:\\Music"), false);
});

test("matching is case-insensitive (Windows paths, same as track-id hashing)", () => {
  assert.equal(isUnderPath("d:\\music\\english\\song.mp3", "D:\\MUSIC"), true);
});

test("posix separators work", () => {
  assert.equal(isUnderPath("/home/user/Music/english/song.mp3", "/home/user/Music"), true);
  assert.equal(isUnderPath("/home/user/MusicX/song.mp3", "/home/user/Music"), false);
});

test("mixed separators (forward-slash root stored by an old version)", () => {
  assert.equal(isUnderPath("D:\\Music\\english\\song.mp3", "D:/Music"), true);
});

test("empty inputs are never under anything", () => {
  assert.equal(isUnderPath("", "D:\\Music"), false);
  assert.equal(isUnderPath("D:\\Music", ""), false);
  assert.equal(isUnderPath(undefined, "D:\\Music"), false);
  assert.equal(isUnderPath("D:\\Music", undefined), false);
});
