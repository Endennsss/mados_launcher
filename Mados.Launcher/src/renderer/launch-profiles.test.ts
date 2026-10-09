import { describe, expect, it } from "vitest";
import {
  deduplicateLaunchProfiles,
  hasLaunchProfileValidationErrors,
  normalizeLaunchProfileDraft,
  sortLaunchProfiles,
  validateLaunchProfileDraft,
  type LaunchProfile,
} from "./launch-profiles";

const profile = (overrides: Partial<LaunchProfile> = {}): LaunchProfile => ({
  id: "default",
  address: "ss14://station.example:1212/?token=secret",
  name: " Station ",
  createdAt: "2026-10-01T12:00:00Z",
  lastUsedAt: null,
  ...overrides,
});

describe("launch profiles", () => {
  it("normalizes names and removes credentials/query from server addresses", () => {
    expect(normalizeLaunchProfileDraft({
      name: "  My   Station  ",
      address: "ss14://user:pass@station.example:1212/path/?token=secret",
    })).toEqual({ name: "My Station", address: "ss14://station.example/path" });
  });

  it("validates required values and supported protocols", () => {
    const errors = validateLaunchProfileDraft({ name: " ", address: "example.org" });
    expect(errors).toEqual({ name: "Введите название профиля.", address: "Адрес должен начинаться с ss14:// или ss14s://." });
    expect(hasLaunchProfileValidationErrors(errors)).toBe(true);
    expect(hasLaunchProfileValidationErrors(validateLaunchProfileDraft({ name: "Station", address: "ss14://station.example" }))).toBe(false);
  });

  it("sorts profiles by last use, then creation date, without mutating input", () => {
    const items = [
      profile({ id: "old", name: "Old", createdAt: "2026-10-01T00:00:00Z" }),
      profile({ id: "new", name: "New", lastUsedAt: "2026-10-09T00:00:00Z" }),
      profile({ id: "middle", name: "Middle", createdAt: "2026-10-08T00:00:00Z" }),
    ];
    const sorted = sortLaunchProfiles(items);
    expect(sorted.map((item) => item.id)).toEqual(["new", "middle", "old"]);
    expect(items.map((item) => item.id)).toEqual(["old", "new", "middle"]);
  });

  it("deduplicates normalized addresses and keeps the most recently used profile", () => {
    const result = deduplicateLaunchProfiles([
      profile({ id: "old", address: "ss14://station.example?old=1", lastUsedAt: "2026-10-01T00:00:00Z" }),
      profile({ id: "new", address: "ss14://station.example/", lastUsedAt: "2026-10-09T00:00:00Z" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "new", address: "ss14://station.example" });
  });
});
