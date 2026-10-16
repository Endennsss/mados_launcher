// @vitest-environment jsdom
import {act,StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {LauncherApi,StorageScan} from "../contracts/launcher";
import {DiagnosticsView} from "./DiagnosticsView";
import {StorageView} from "./StorageView";
import {ConfirmProvider} from "./ConfirmDialog";
import {ToolsView} from "./ToolsView";

it("consumes an error diagnostic once under StrictMode and preserves it across tool tabs",async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const invoke=vi.fn(async(method:string)=>method==='diagnostics.run'?{address:'ss14://original',checkedAt:new Date().toISOString(),checks:[{id:'server',status:'passed',title:'Server result',message:'done'}]}:{capturedAt:new Date().toISOString(),totalBytes:0,freeBytes:1000,blockedReason:null,warnings:[],categories:[],items:[]});
 window.mados={invoke,onEvent:()=>()=>{},localServers:{list:async()=>[],getStatus:async()=>({status:'idle'})}} as unknown as LauncherApi;
 const consumed=vi.fn();
 try{
  await act(async()=>root.render(<StrictMode><ConfirmProvider><ToolsView onError={()=>{}} diagnosticRequest={{address:'ss14://original',revision:1}} autoDiagnose onDiagnosticStarted={consumed}/></ConfirmProvider></StrictMode>));
  expect(invoke.mock.calls.filter(([m])=>m==='diagnostics.run')).toHaveLength(1);expect(host.textContent).toContain('Server result');expect(consumed).toHaveBeenCalledOnce();
  const input=host.querySelector<HTMLInputElement>('[aria-label="Адрес для диагностики"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'ss14://changed');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-maintenance-tab="storage"]')!.click());
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-maintenance-tab="diagnostics"]')!.click());
  expect(invoke.mock.calls.filter(([m])=>m==='diagnostics.run')).toHaveLength(1);expect(host.querySelector<HTMLInputElement>('[aria-label="Адрес для диагностики"]')!.value).toBe('ss14://changed');
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it("diagnoses only on request and discards a response after changing address",async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let resolve!:(v:unknown)=>void;
 const invoke=vi.fn(()=>new Promise(r=>{resolve=r}));window.mados={invoke,onEvent:()=>()=>{}} as unknown as LauncherApi;
 try{
  await act(async()=>root.render(<DiagnosticsView onStorage={()=>{}}/>));expect(invoke).not.toHaveBeenCalled();const input=host.querySelector('input')!;
  const set=async(value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await set('ss14://first');await act(async()=>host.querySelector<HTMLButtonElement>('[data-action="diagnose"]')!.click());expect(invoke).toHaveBeenCalledWith('diagnostics.run',{address:'ss14://first'});
  await set('ss14://second');await act(async()=>resolve({address:'ss14://first',checkedAt:new Date().toISOString(),checks:[{id:'server',status:'passed',title:'Old response',message:'old'}]}));expect(host.textContent).not.toContain('Old response');
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it("requires a preview and confirmation, sends only opaque IDs, retains selection on failure",async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const item={id:'content:1',name:'Station old',category:'content',bytes:100,lastUsed:'2024-01-01',canDelete:true,protectedReason:null};
 const scan:StorageScan={capturedAt:new Date().toISOString(),totalBytes:500,freeBytes:1000,blockedReason:null,warnings:[],categories:[{id:'content',name:'Сборки',bytes:500,description:'Cache'}],items:[item,{...item,id:'content:2',canDelete:false,protectedReason:'Последняя версия'}]};
 const invoke=vi.fn(async(method:string)=>{if(method==='storage.scan')return scan;if(method==='storage.preview')return {planId:'a'.repeat(32),estimatedBytes:100,expiresAt:new Date(Date.now()+300000).toISOString(),items:[item]};throw Error('Файлы изменились');});window.mados={invoke,onEvent:()=>()=>{}} as unknown as LauncherApi;
 try{
  await act(async()=>root.render(<ConfirmProvider><StorageView/></ConfirmProvider>));expect(host.querySelector<HTMLInputElement>('[data-storage-id="content:2"]')!.disabled).toBe(true);
  await act(async()=>host.querySelector<HTMLInputElement>('[data-storage-id="content:1"]')!.click());await act(async()=>host.querySelector<HTMLButtonElement>('[data-action="preview-clean"]')!.click());expect(invoke).toHaveBeenCalledWith('storage.preview',{ids:['content:1']});expect(invoke.mock.calls.some(([m])=>m==='storage.clean')).toBe(false);
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-action="clean-storage"]')!.click());expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();await act(async()=>document.querySelector<HTMLButtonElement>('[role="alertdialog"] .primary-button')!.click());
  expect(invoke).toHaveBeenCalledWith('storage.clean',{planId:'a'.repeat(32)});expect(host.textContent).toContain('Файлы изменились');expect(host.querySelector<HTMLInputElement>('[data-storage-id="content:1"]')!.checked).toBe(true);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
