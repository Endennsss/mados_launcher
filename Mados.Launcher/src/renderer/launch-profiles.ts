import { sanitizeServerAddress } from "./ui-helpers";

/** The renderer-facing representation of a saved server launch profile. */
export type LaunchProfile = {
  id: string;
  address: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type LaunchProfileDraft = {
  name: string;
  address: string;
};

export type LaunchProfileValidation = {
  name?: string;
  address?: string;
};

/**
 * Normalizes user input before it is sent to the worker. Empty values are
 * preserved so the form can show a useful validation message instead of
 * silently creating a profile with a different address.
 */
export function normalizeLaunchProfileDraft(draft: LaunchProfileDraft): LaunchProfileDraft {
  return {
    name: draft.name.trim().replace(/\s+/g, " ").slice(0, 80),
    address: sanitizeServerAddress(draft.address.trim()),
  };
}

export function validateLaunchProfileDraft(draft: LaunchProfileDraft): LaunchProfileValidation {
  const normalized = normalizeLaunchProfileDraft(draft);
  const errors: LaunchProfileValidation = {};
  if (!normalized.name) errors.name = "Введите название профиля.";
  const rawAddress = draft.address.trim();
  if (!rawAddress) errors.address = "Укажите адрес сервера.";
  else if (!/^ss14s?:\/\//i.test(rawAddress)) errors.address = "Адрес должен начинаться с ss14:// или ss14s://.";
  else if (!normalized.address) errors.address = "Проверьте адрес сервера.";
  return errors;
}

export function hasLaunchProfileValidationErrors(errors: LaunchProfileValidation): boolean {
  return Object.values(errors).some(Boolean);
}

/** Sorts most recently used profiles first without mutating the source array. */
export function sortLaunchProfiles(profiles: LaunchProfile[]): LaunchProfile[] {
  return [...profiles].sort((left, right) => {
    const lastUsedOrder = compareDatesDescending(left.lastUsedAt, right.lastUsedAt);
    if (lastUsedOrder !== 0) return lastUsedOrder;
    const createdOrder = compareDatesDescending(left.createdAt, right.createdAt);
    if (createdOrder !== 0) return createdOrder;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

/** Keeps one profile per normalized server address, retaining the newest entry. */
export function deduplicateLaunchProfiles(profiles: LaunchProfile[]): LaunchProfile[] {
  const byAddress = new Map<string, LaunchProfile>();
  for (const profile of profiles) {
    const normalizedAddress = sanitizeServerAddress(profile.address);
    const current = byAddress.get(normalizedAddress);
    if (!current || compareDatesDescending(profile.lastUsedAt, current.lastUsedAt) < 0) {
      byAddress.set(normalizedAddress, { ...profile, address: normalizedAddress });
    }
  }
  return sortLaunchProfiles([...byAddress.values()]);
}

function compareDatesDescending(left: string | null, right: string | null): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
  if (Number.isNaN(leftTime)) return 1;
  if (Number.isNaN(rightTime)) return -1;
  return rightTime - leftTime;
}
