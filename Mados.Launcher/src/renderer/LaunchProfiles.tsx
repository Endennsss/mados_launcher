import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, Edit3, Play, Plus, Trash2, X } from "lucide-react";
import {
  hasLaunchProfileValidationErrors,
  normalizeLaunchProfileDraft,
  sortLaunchProfiles,
  validateLaunchProfileDraft,
  type LaunchProfile,
  type LaunchProfileDraft,
  type LaunchProfileValidation,
} from "./launch-profiles";

export type LaunchProfilesProps = {
  profiles: LaunchProfile[];
  busy?: boolean;
  onUse: (profile: LaunchProfile) => void | Promise<void>;
  onCreate: (draft: LaunchProfileDraft) => void | Promise<void>;
  onUpdate: (id: string, draft: LaunchProfileDraft) => void | Promise<void>;
  onRemove: (profile: LaunchProfile) => void | Promise<void>;
};

const emptyDraft: LaunchProfileDraft = { name: "", address: "" };

/** Controlled profile list and editor. Persistence stays in the worker callbacks. */
export function LaunchProfiles({ profiles, busy = false, onUse, onCreate, onUpdate, onRemove }: LaunchProfilesProps) {
  const sortedProfiles = useMemo(() => sortLaunchProfiles(profiles), [profiles]);
  const [draft, setDraft] = useState<LaunchProfileDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<LaunchProfileValidation>({});

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(emptyDraft);
    setErrors({});
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeLaunchProfileDraft(draft);
    const nextErrors = validateLaunchProfileDraft(draft);
    setErrors(nextErrors);
    if (hasLaunchProfileValidationErrors(nextErrors)) return;
    if (editingId) await onUpdate(editingId, normalized);
    else await onCreate(normalized);
    cancelEdit();
  };

  const edit = (profile: LaunchProfile) => {
    setEditingId(profile.id);
    setDraft({ name: profile.name, address: profile.address });
    setErrors({});
  };

  return <section className="launch-profiles" aria-label="Профили запуска"><div className="launch-profiles-heading"><div><h2>Профили запуска</h2><span>Быстрое подключение к сохранённым серверам</span></div><span className="launch-profiles-count">{sortedProfiles.length}</span></div><div className="launch-profile-list">{sortedProfiles.map((profile) => <article className="launch-profile-card" key={profile.id}><div className="launch-profile-copy"><strong>{profile.name}</strong><span>{profile.address}</span>{profile.lastUsedAt && <small>Последний запуск: {new Date(profile.lastUsedAt).toLocaleString()}</small>}</div><div className="launch-profile-actions"><button type="button" className="primary-button compact-button" disabled={busy} onClick={() => void onUse(profile)}><Play className="play-icon" size={14} fill="currentColor" /> Запустить</button><button type="button" className="icon-button" disabled={busy} aria-label={`Изменить профиль ${profile.name}`} onClick={() => edit(profile)}><Edit3 size={15} /></button><button type="button" className="icon-button danger-icon" disabled={busy} aria-label={`Удалить профиль ${profile.name}`} onClick={() => void onRemove(profile)}><Trash2 size={15} /></button></div></article>)}{sortedProfiles.length === 0 && <p className="launch-profiles-empty">Профилей пока нет. Добавьте сервер, к которому часто подключаетесь.</p>}</div><form className="launch-profile-form" onSubmit={(event) => void submit(event)}><div className="launch-profile-form-heading"><strong>{editingId ? "Изменить профиль" : "Новый профиль"}</strong>{editingId && <button type="button" className="ghost-button" onClick={cancelEdit}><X size={14} /> Отмена</button>}</div><label>Название<input value={draft.name} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Например, Вечерняя смена" aria-invalid={Boolean(errors.name)} />{errors.name && <small className="form-error">{errors.name}</small>}</label><label>Адрес сервера<input value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} placeholder="ss14://station.example" aria-invalid={Boolean(errors.address)} />{errors.address && <small className="form-error">{errors.address}</small>}</label><button type="submit" className="secondary-button" disabled={busy}><Check size={14} /> {editingId ? "Сохранить" : <><Plus size={14} /> Добавить профиль</>}</button></form></section>;
}
