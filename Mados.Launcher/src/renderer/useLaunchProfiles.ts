import { useCallback, useEffect, useRef, useState } from "react";
import type { LaunchProfile, LaunchProfileDraft } from "./launch-profiles";
import type { useConfirm } from "./ConfirmDialog";
import { captureAccountOperation } from "./account-transition";

/** Profile requests belong to the account that issued them, including delayed launches. */
export function useLaunchProfiles(accountId: string | undefined, confirm: ReturnType<typeof useConfirm>) {
  const scope=useRef({accountId,epoch:0});
  if(scope.current.accountId!==accountId)scope.current={accountId,epoch:scope.current.epoch+1};
  const epoch=scope.current.epoch;
  const [data,setData]=useState({epoch,profiles:[] as LaunchProfile[],loading:!!accountId,error:null as string|null,busy:false});
  const current=data.epoch===epoch?data:{epoch,profiles:[],loading:!!accountId,error:null,busy:false};
  const sequence=useRef(0),mutation=useRef<symbol|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const valid=useCallback(()=>alive.current&&scope.current.epoch===epoch,[epoch]);
  const requireScope=()=>{if(!valid())throw Error("Аккаунт изменился. Повторите действие для выбранного аккаунта.");};
  const reload=useCallback(async()=>{
    const request=++sequence.current;
    if(!accountId){setData({epoch,profiles:[],loading:false,error:null,busy:false});return;}
    setData(old=>({...old,epoch,profiles:old.epoch===epoch?old.profiles:[],loading:true,error:null}));
    try{const profiles=await window.mados.launchProfiles.list();if(valid()&&request===sequence.current)setData(old=>({...old,profiles,loading:false,error:null}));}
    catch(caught){if(valid()&&request===sequence.current)setData(old=>({...old,loading:false,error:caught instanceof Error?caught.message:"Не удалось загрузить профили"}));}
  },[accountId,epoch,valid]);
  useEffect(()=>{mutation.current=null;setData({epoch,profiles:[],loading:!!accountId,error:null,busy:false});void reload();const unsubscribe=window.mados.onEvent(event=>{if(event.event==="launchProfiles.updated")void reload();});return()=>{sequence.current++;unsubscribe();};},[reload,epoch,accountId]);
  const run=async(action:(assertAccount:()=>void)=>Promise<void>)=>{
    requireScope();if(!accountId)throw Error("Войдите в аккаунт");if(mutation.current)throw Error("Дождитесь завершения предыдущего действия");
    const accountUnchanged=captureAccountOperation();
    const assertAccount=()=>{requireScope();accountUnchanged();};
    const token=Symbol();mutation.current=token;setData(old=>({...old,busy:true}));
    try{await action(assertAccount);assertAccount();}finally{if(mutation.current===token)mutation.current=null;if(valid())setData(old=>({...old,busy:false}));}
  };
  const upsert=(profile:LaunchProfile)=>{requireScope();sequence.current++;setData(old=>({...old,loading:false,profiles:[profile,...old.profiles.filter(item=>item.id!==profile.id&&item.address!==profile.address)]}));};
  const create=(draft:LaunchProfileDraft)=>run(async assertAccount=>{const profile=await window.mados.launchProfiles.create(draft.name,draft.address);assertAccount();upsert(profile);});
  const update=(id:string,draft:LaunchProfileDraft)=>run(async assertAccount=>{const profile=await window.mados.launchProfiles.update(id,draft.name,draft.address);assertAccount();upsert(profile);});
  const remove=async(profile:LaunchProfile)=>{
    const accountUnchanged=captureAccountOperation();
    requireScope();if(!await confirm({title:"Удалить профиль?",message:`Профиль «${profile.name}» исчезнет из быстрых действий. Игровые файлы сохранятся.`,confirmLabel:"Удалить",destructive:true}))return;
    requireScope();accountUnchanged();await run(async assertAccount=>{await window.mados.launchProfiles.remove(profile.id);assertAccount();sequence.current++;setData(old=>({...old,loading:false,profiles:old.profiles.filter(item=>item.id!==profile.id)}));});
  };
  const launch=(id:string)=>run(async assertAccount=>{
    const selected=await window.mados.launchProfiles.use(id);assertAccount();upsert(selected);
    await window.mados.invoke("servers.connect",{address:selected.address,name:selected.name});
  });
  return {profiles:current.profiles,busy:current.busy,create,update,remove,launch,useProfile:(profile:LaunchProfile)=>launch(profile.id),
    status:{loading:current.loading,error:current.error,onRetry:()=>void reload(),scopeKey:accountId??"anonymous"}};
}
