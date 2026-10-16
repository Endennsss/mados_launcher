import { useEffect, useState } from "react";
import type { Favorite } from "../contracts/launcher";
import { sanitizeServerAddress } from "./ui-helpers";

export type FavoriteGroup = { id: string; name: string };
export type FavoriteLayout = { version: 1; groups: FavoriteGroup[]; entries: Array<{ address: string; groupId: string }> };
export const favoriteLayoutKey = (accountId: string) => `mados.favoriteLayout.v1.${accountId}`;
export const defaultFavoriteLayout = (): FavoriteLayout => ({version:1,groups:[{id:"main",name:"Основные"},{id:"friends",name:"С друзьями"},{id:"try",name:"Попробовать"}],entries:[]});
export function normalizeFavoriteLayout(value: unknown): FavoriteLayout {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return defaultFavoriteLayout();
  const raw = value as Partial<FavoriteLayout>;
  const groups: FavoriteGroup[] = [];
  if (Array.isArray(raw.groups)) for (const group of raw.groups.slice(0,12)) {
    if (group && typeof group.id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(group.id) && typeof group.name === "string" && group.name.trim() && !groups.some(item=>item.id===group.id)) groups.push({id:group.id,name:group.name.trim().slice(0,32)});
  }
  if (!groups.some(group=>group.id==="main")) groups.unshift({id:"main",name:"Основные"});
  groups.splice(12);
  const entries: FavoriteLayout["entries"] = [];
  if (Array.isArray(raw.entries)) for (const entry of raw.entries.slice(0,2000)) {
    if (!entry || typeof entry.address !== "string") continue;
    const address = sanitizeServerAddress(entry.address);
    if (address && !entries.some(item=>item.address===address)) entries.push({address,groupId:groups.some(group=>group.id===entry.groupId)?entry.groupId:"main"});
  }
  return {version:1,groups,entries};
}
export const favoriteGroupId = (layout: FavoriteLayout, address: string) => layout.entries.find(entry=>entry.address===sanitizeServerAddress(address))?.groupId ?? "main";
export function orderedFavorites(favorites: Favorite[], layout: FavoriteLayout): Favorite[] {
  const ranks = new Map(layout.entries.map((entry,index)=>[entry.address,index]));
  return [...favorites].sort((a,b)=>(ranks.get(sanitizeServerAddress(a.address)) ?? Number.MAX_SAFE_INTEGER)-(ranks.get(sanitizeServerAddress(b.address)) ?? Number.MAX_SAFE_INTEGER));
}
export function moveFavorite(layout: FavoriteLayout, favorites: Favorite[], source: string, target: string | null, groupId: string): FavoriteLayout {
  source = sanitizeServerAddress(source); target = target ? sanitizeServerAddress(target) : null;
  if (!layout.groups.some(group=>group.id===groupId) || !favorites.some(favorite=>sanitizeServerAddress(favorite.address)===source)) return layout;
  const entries = orderedFavorites(favorites,layout).map(favorite=>({address:sanitizeServerAddress(favorite.address),groupId:favoriteGroupId(layout,favorite.address)}));
  const from=entries.findIndex(item=>item.address===source), to=entries.findIndex(item=>item.address===target);
  entries[from]={...entries[from],groupId};
  if (target && from!==to && to>=0) {const [entry]=entries.splice(from,1);entries.splice(to,0,entry);}
  return {...layout,entries};
}
export function removeFavoriteGroup(layout: FavoriteLayout, id: string): FavoriteLayout {
  if (id === "main") return layout;
  return {...layout,groups:layout.groups.filter(group=>group.id!==id),entries:layout.entries.map(entry=>entry.groupId===id?{...entry,groupId:"main"}:entry)};
}
function read(accountId: string) {
  try {return {layout:normalizeFavoriteLayout(JSON.parse(localStorage.getItem(favoriteLayoutKey(accountId)) ?? "null")),error:null as string|null};}
  catch {return {layout:defaultFavoriteLayout(),error:"Не удалось прочитать группы избранного. Серверы сохранены и доступны."};}
}
export function useFavoriteLayout(accountId: string) {
  const [state,setState]=useState(()=>({accountId,...read(accountId)}));
  useEffect(()=>{
    setState({accountId,...read(accountId)});
    const changed=(event:Event)=>{if((event as CustomEvent<string>).detail===accountId)setState({accountId,...read(accountId)});};
    window.addEventListener("mados-favorites-layout",changed);
    return()=>window.removeEventListener("mados-favorites-layout",changed);
  },[accountId]);
  const current=state.accountId===accountId?state:{accountId,...read(accountId)};
  const save=(layout:FavoriteLayout)=>{
    try {localStorage.setItem(favoriteLayoutKey(accountId),JSON.stringify(layout));setState({accountId,layout,error:null});window.dispatchEvent(new CustomEvent("mados-favorites-layout",{detail:accountId}));return true;}
    catch {setState({...current,error:"Не удалось сохранить группы и порядок. Предыдущее оформление сохранено; повторите изменение."});return false;}
  };
  return {...current,save};
}
