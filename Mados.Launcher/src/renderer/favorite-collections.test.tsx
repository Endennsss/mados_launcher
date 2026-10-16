// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { defaultFavoriteLayout, normalizeFavoriteLayout, moveFavorite, removeFavoriteGroup, orderedFavorites, favoriteLayoutKey } from "./favorite-collections";
import { FavoriteCollection } from "./FavoriteCollection";
import { ConfirmProvider } from "./ConfirmDialog";
const favorites=[{name:"Alpha",address:"ss14://alpha",raiseTime:""},{name:"Beta",address:"ss14://beta",raiseTime:""}];
it("moves entries from trimmed groups to the mandatory default group",()=>{
  const layout=normalizeFavoriteLayout({version:1,groups:Array.from({length:12},(_,i)=>({id:`group-${i}`,name:`Group ${i}`})),entries:[{address:"ss14://alpha",groupId:"group-11"}]});
  expect(layout.groups).toHaveLength(12);
  expect(layout.entries[0].groupId).toBe("main");
});
it("normalizes unsafe addresses and invalid groups without losing usable favorites",()=>{
  const layout=normalizeFavoriteLayout({version:1,groups:[{id:"main",name:"Основные"}],entries:[{address:"ss14://u:secret@alpha?token=secret#x",groupId:"missing"},{address:"ss14://alpha",groupId:"main"},{address:"javascript:x",groupId:"main"}]});
  expect(layout.entries).toEqual([{address:"ss14://alpha",groupId:"main"}]);
  expect(orderedFavorites(favorites,layout).map(item=>item.name)).toEqual(["Alpha","Beta"]);
});
it("moves favorites and preserves them when their group is deleted",()=>{
  const layout=moveFavorite(defaultFavoriteLayout(),favorites,"ss14://beta","ss14://alpha","friends");
  expect(layout.entries.find(item=>item.address==="ss14://beta")?.groupId).toBe("friends");
  const next=removeFavoriteGroup(layout,"friends");
  expect(orderedFavorites(favorites,next).map(item=>item.name)).toEqual(["Beta","Alpha"]);
  expect(next.entries.every(item=>item.groupId==="main")).toBe(true);
  expect(removeFavoriteGroup(next,"main")).toBe(next);
});
it("persists keyboard ordering per account and keeps previous order after storage failure",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);localStorage.clear();
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const render=(accountId:string)=>act(async()=>root.render(<ConfirmProvider><FavoriteCollection accountId={accountId} favorites={favorites} servers={[]} onConnect={()=>{}} onDetails={()=>{}} onRemove={async()=>{}} onBrowse={()=>{}}/></ConfirmProvider>));
  const click=async(selector:string)=>act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());
  try{
    await render("a");await click('[aria-label="Упорядочить избранное"]');await click('[aria-label="Выше: Beta"]');
    expect([...host.querySelectorAll('.collection-card h3')].map(n=>n.textContent)).toEqual(["Beta","Alpha"]);
    expect(localStorage.getItem(favoriteLayoutKey("a"))).toContain('ss14://beta');
    await render("b");expect([...host.querySelectorAll('.collection-card h3')].map(n=>n.textContent)).toEqual(["Alpha","Beta"]);
    await click('[aria-label="Упорядочить избранное"]');vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("disk");});await click('[aria-label="Выше: Beta"]');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("сохранить");
    expect([...host.querySelectorAll('.collection-card h3')].map(n=>n.textContent)).toEqual(["Alpha","Beta"]);
  }finally{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
