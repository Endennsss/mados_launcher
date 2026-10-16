import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Activity, ArrowDown, ArrowUp, Check, FolderHeart, GripVertical, Play, Plus, Settings2, Star, Trash2, Users, X } from "lucide-react";
import type { Favorite, Server } from "../contracts/launcher";
import { favoriteGroupId, moveFavorite, orderedFavorites, removeFavoriteGroup, useFavoriteLayout } from "./favorite-collections";
import { SelectField } from "./SelectField";
import { ViewState } from "./ViewState";
import { useConfirm } from "./ConfirmDialog";
import { sanitizeServerAddress } from "./ui-helpers";
import { queueServerHandoff } from "./server-handoff";

type Props={accountId:string;favorites:Favorite[];servers:Server[];onConnect:(server:Server)=>void;onDetails:(server:Server)=>void;onRemove:(favorite:Favorite)=>Promise<void>;onBrowse:()=>void};
export function FavoriteCollection(props:Props) {return <Collection key={props.accountId} {...props}/>;}
function Collection({accountId,favorites,servers,onConnect,onDetails,onRemove,onBrowse}:Props) {
  const {layout,error:storageError,save}=useFavoriteLayout(accountId);
  const confirm=useConfirm(accountId);
  const [organizing,setOrganizing]=useState(false),[filter,setFilter]=useState("all"),[newGroup,setNewGroup]=useState("");
  const [error,setError]=useState<string|null>(null),[pending,setPending]=useState<string|null>(null),[announcement,setAnnouncement]=useState("");
  const [dragging,setDragging]=useState<string|null>(null),[over,setOver]=useState<string|null>(null);
  const root=useRef<HTMLDivElement>(null),before=useRef(new Map<string,DOMRect>()),animations=useRef<Animation[]>([]),removing=useRef(false),alive=useRef(true);
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const capture=()=>{before.current.clear();root.current?.querySelectorAll<HTMLElement>('[data-collection-address]').forEach(node=>before.current.set(node.dataset.collectionAddress!,node.getBoundingClientRect()));};
  useLayoutEffect(()=>{
    animations.current.forEach(animation=>animation.cancel());animations.current=[];
    if(!document.documentElement.classList.contains("reduce-motion")&&!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches){
      root.current?.querySelectorAll<HTMLElement>('[data-collection-address]').forEach(node=>{const previous=before.current.get(node.dataset.collectionAddress!),current=node.getBoundingClientRect();if(previous&&node.animate&&(previous.x!==current.x||previous.y!==current.y))animations.current.push(node.animate([{transform:`translate(${previous.x-current.x}px,${previous.y-current.y}px)`},{transform:"none"}],{duration:260,easing:"cubic-bezier(.2,.8,.2,1)"}));});
    }
    before.current.clear();return()=>animations.current.forEach(animation=>animation.cancel());
  },[layout]);
  const move=(address:string,target:string|null,groupId:string)=>{capture();if(save(moveFavorite(layout,favorites,address,target,groupId)))setAnnouncement("Порядок избранного сохранён");setDragging(null);setOver(null);};
  const remove=async(favorite:Favorite)=>{
    if(removing.current)return;removing.current=true;setPending(favorite.address);setError(null);
    try{await onRemove(favorite);}catch(caught){if(alive.current)setError(caught instanceof Error?caught.message:"Не удалось убрать сервер из избранного");}finally{removing.current=false;if(alive.current)setPending(null);}
  };
  const deleteGroup=async(id:string)=>{
    if(!await confirm({title:"Удалить группу?",message:"Серверы останутся в избранном и перейдут в «Основные».",confirmLabel:"Удалить группу",destructive:true})||!alive.current)return;
    capture();if(save(removeFavoriteGroup(layout,id)))setFilter("all");
  };
  const addGroup=()=>{const name=newGroup.trim();if(!name)return;if(layout.groups.some(group=>group.name.toLocaleLowerCase()===name.toLocaleLowerCase())){setError("Группа с таким названием уже есть.");return;}if(layout.groups.length>=12){setError("Можно создать до 12 групп.");return;}if(save({...layout,groups:[...layout.groups,{id:crypto.randomUUID(),name}]})){setNewGroup("");setError(null);}};
  const all=orderedFavorites(favorites,layout);
  return <section className="favorite-collection" aria-label="Моя коллекция серверов">
    <header className="collection-heading"><div className="collection-title"><span><FolderHeart size={22}/></span><div><h2>Моя коллекция</h2><p>Любимые станции, собранные по-своему</p></div></div><button className="secondary-button compact-button" aria-label="Упорядочить избранное" aria-pressed={organizing} onClick={()=>{setOrganizing(!organizing);setError(null);}}>{organizing?<Check size={15}/>:<Settings2 size={15}/>} {organizing?"Готово":"Упорядочить"}</button></header>
    {(error||storageError)&&<ViewState compact kind="error" title="Изменение не сохранено" description={error||storageError||undefined} onDismiss={()=>setError(null)}/>}
    <div className="collection-tabs" aria-label="Группы избранного"><button aria-pressed={filter==="all"} onClick={()=>setFilter("all")}>Все <span>{favorites.length}</span></button>{layout.groups.map(group=><button key={group.id} aria-pressed={filter===group.id} className={over===group.id?"drop-target":""} onClick={()=>setFilter(group.id)} onDragOver={event=>{if(dragging){event.preventDefault();event.stopPropagation();setOver(group.id);}}} onDrop={event=>{if(dragging){event.preventDefault();event.stopPropagation();move(dragging,null,group.id);}}}>{group.name}<span>{favorites.filter(f=>favoriteGroupId(layout,f.address)===group.id).length}</span></button>)}</div>
    {organizing&&<div className="collection-customizer"><p><GripVertical size={15}/> Перетащите за точки или используйте стрелки. Перенести в другую группу можно через список на карточке.</p><form onSubmit={event=>{event.preventDefault();addGroup();}}><input aria-label="Название новой группы" value={newGroup} onChange={event=>setNewGroup(event.target.value)} maxLength={32} placeholder="Новая группа"/><button type="submit" className="secondary-button compact-button" disabled={!newGroup.trim()||layout.groups.length>=12}><Plus size={14}/>Добавить группу</button></form></div>}
    <div ref={root} className={`collection-content ${organizing?"organizing":""}`}>{layout.groups.filter(group=>filter==="all"||filter===group.id).map(group=>{
      const items=all.filter(favorite=>favoriteGroupId(layout,favorite.address)===group.id);
      if(!items.length&&!organizing&&filter==="all")return null;
      return <section className="collection-group" key={group.id}><header><h3>{group.name}<span>{items.length}</span></h3>{organizing&&group.id!=="main"&&<button className="icon-button" aria-label={`Удалить группу ${group.name}`} onClick={()=>void deleteGroup(group.id)}><Trash2 size={14}/></button>}</header><div className="collection-grid">{items.map((favorite,index)=>{
        const address=sanitizeServerAddress(favorite.address),known=servers.find(server=>sanitizeServerAddress(server.address)===address);
        const server:Server=known??{address,name:favorite.name,playerCount:0,softMaxPlayerCount:0,tags:[],status:"fetching",hubAddress:"",roundStartTime:null,runLevel:null};
        const name=server.name||address,online=known?.status==="online";
        return <article key={address} data-collection-address={address} className={`collection-card ${dragging===address?"dragging":""} ${over===address?"drop-target":""}`} style={{"--collection-order":Math.min(index,5)} as CSSProperties} onDragOver={event=>{if(dragging){event.preventDefault();event.stopPropagation();setOver(address);}}} onDrop={event=>{if(dragging){event.preventDefault();event.stopPropagation();move(dragging,address,group.id);}}}>
          <div className="collection-card-top"><span className="collection-mark"><Star size={20}/></span><span className={`collection-status ${online?"online":""}`}><i/>{online?"Онлайн":known?.status==="offline"?"Недоступен":"Нет данных"}</span><button className="icon-button collection-remove" disabled={pending!==null} aria-label={`Убрать из избранного ${name}`} onClick={()=>void remove(favorite)}>{pending===address?<span className="spin">…</span>:<X size={15}/>}</button></div>
          <button className="collection-details" onClick={event=>{queueServerHandoff(address,event.currentTarget,"details");onDetails(server);}}><h3>{name}</h3><span>{address}</span></button>
          <div className="collection-metrics"><span><Users size={13}/>{online?`${server.playerCount}${server.softMaxPlayerCount>0?` / ${server.softMaxPlayerCount}`:""}`:"—"}</span><span><Activity size={13}/>{online&&server.pingMs!=null?`${server.pingMs} ms`:"—"}</span></div>
          {organizing?<div className="collection-order"><SelectField label={`Группа сервера ${name}`} value={group.id} onChange={id=>move(address,null,id)} options={layout.groups.map(item=>({value:item.id,label:item.name}))}/><div><span className="collection-drag" draggable aria-hidden="true" onDragStart={event=>{event.stopPropagation();event.dataTransfer.setData("application/x-mados-favorite",address);event.dataTransfer.effectAllowed="move";setDragging(address);}} onDragEnd={()=>{setDragging(null);setOver(null);}}><GripVertical size={17}/></span><button className="icon-button" aria-label={`Выше: ${name}`} disabled={index===0} onClick={()=>move(address,items[index-1].address,group.id)}><ArrowUp size={15}/></button><button className="icon-button" aria-label={`Ниже: ${name}`} disabled={index===items.length-1} onClick={()=>move(address,items[index+1].address,group.id)}><ArrowDown size={15}/></button></div></div>:<button className="secondary-button collection-play" onClick={event=>{queueServerHandoff(address,event.currentTarget,"launch");onConnect(server);}}><Play size={14} className="play-icon" fill="currentColor"/>Играть</button>}
        </article>;
      })}</div>{!items.length&&<p className="collection-group-empty">{organizing?"Перенесите сюда сервер из списка на карточке или перетащите его на название группы.":"В этой группе пока нет серверов."}</p>}</section>;
    })}</div>
    {!favorites.length&&!organizing&&<ViewState icon={<Star size={26}/>} title="Соберите свою коллекцию" description="Нажмите звёздочку у сервера в каталоге. Он появится здесь, и вы сможете выбрать для него группу." action="Открыть каталог" onAction={onBrowse}/>}
    <span className="sr-only" role="status">{announcement}</span>
  </section>;
}
