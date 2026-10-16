import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, Clock3, Command, FolderHeart, Gamepad2, Search, Settings, Star, Rocket, X } from "lucide-react";
import catLogo from "./assets/cat-logo.png";

export const GUIDE_STORAGE_KEY="mados.guide.v1";
export function useLauncherGuide(ready:boolean) {
  const [open,setOpen]=useState(false),[error,setError]=useState<string|null>(null);
  const dismissed=useRef(false);
  useEffect(()=>{
    if(!ready){setOpen(false);return;}
    if(dismissed.current)return;
    try{if(localStorage.getItem(GUIDE_STORAGE_KEY)!=="done")setOpen(true);}catch{setOpen(true);}
  },[ready]);
  const close=()=>{
    dismissed.current=true;
    try{localStorage.setItem(GUIDE_STORAGE_KEY,"done");setError(null);}catch{setError("Не удалось запомнить прохождение гайда. При следующем запуске он может появиться снова.");}
    setOpen(false);
  };
  return {open,setOpen,close,error,clearError:()=>setError(null)};
}
const steps=[
  {icon:Search,title:"Найдите свою станцию",description:"Откройте «Серверы», выберите язык и нужные фильтры. Нажмите на карточку, чтобы прочитать описание, узнать карту и режим.",hint:"Кнопка «Играть» запустит подключение; загрузку файлов покажем отдельно.",labels:["Поиск и фильтры","Описание сервера","Подключение"],icons:[Search,Gamepad2,ArrowRight]},
  {icon:FolderHeart,title:"Соберите любимые серверы",description:"Нажмите звёздочку у сервера. В «Моей коллекции» можно создавать группы, менять порядок и быстро возвращаться на знакомые станции.",hint:"Группы и порядок сохраняются для вашего аккаунта.",labels:["Основные","С друзьями","Попробовать"],icons:[Star,FolderHeart,Gamepad2]},
  {icon:Rocket,title:"Один клик до новой смены",description:"Создайте профиль запуска: дайте ему имя и укажите адрес сервера. Профили доступны на главной, в каталоге и через Ctrl+K.",hint:"Аккаунты переключаются внизу боковой панели. У каждого свои профили.",labels:["Имя профиля","Адрес станции","Играть"],icons:[Rocket,Gamepad2,ArrowRight]},
  {icon:Command,title:"Всё остальное — под рукой",description:"Ctrl+K ищет серверы, профили и настройки. «Время игры» хранит вашу статистику, а «Инструменты» помогают запускать локальный сервер.",hint:"Темы и анимации — в настройках. Этот гайд всегда можно открыть через справку на главной.",labels:["Ctrl+K","Время игры","Настройки"],icons:[Command,Clock3,Settings]},
];
export function LauncherGuide({onClose}:{onClose:()=>void}) {
  const [index,setIndex]=useState(0);const panel=useRef<HTMLElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null,root=document.getElementById("root"),wasInert=root?.inert??false;
    if(root)root.inert=true;panel.current?.querySelector<HTMLButtonElement>('[data-action="guide-next"]')?.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();event.stopImmediatePropagation();close.current();return;}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();event.stopImmediatePropagation();return;}
      if(event.key!=="Tab")return;const buttons=[...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],first=buttons[0],last=buttons.at(-1);
      if(!panel.current?.contains(document.activeElement)){event.preventDefault();first?.focus();}
      else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    window.addEventListener("keydown",key,true);return()=>{window.removeEventListener("keydown",key,true);if(root)root.inert=wasInert;if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[]);
  const step=steps[index],Icon=step.icon;
  return createPortal(<div className="launcher-guide-overlay"><section ref={panel} className="launcher-guide" role="dialog" aria-modal="true" aria-labelledby="launcher-guide-title">
    <header><span><img src={catLogo} alt=""/>Mados Launcher</span><button className="icon-button" aria-label="Закрыть гайд" onClick={onClose}><X size={18}/></button></header>
    <div className="guide-step-content" key={index}><div className="guide-illustration" aria-hidden="true"><span className="guide-main-symbol"><Icon size={42} strokeWidth={1.5}/></span><div className="guide-mini-cards">{step.labels.map((label,i)=>{const ItemIcon=step.icons[i];return <span key={label} style={{animationDelay:`${i*55}ms`}}><ItemIcon size={19}/><small>{label}</small></span>;})}</div></div>
      <p className="eyebrow">Быстрое знакомство · {index+1} из {steps.length}</p><h2 id="launcher-guide-title">{step.title}</h2><p className="guide-description">{step.description}</p><p className="guide-hint">{step.hint}</p></div>
    <nav className="guide-dots" aria-label="Шаги гайда">{steps.map((item,i)=><button key={item.title} aria-label={`Шаг ${i+1}: ${item.title}`} aria-current={i===index?"step":undefined} onClick={()=>setIndex(i)}><span/></button>)}</nav>
    <footer><button className="text-link" data-action="skip-guide" onClick={onClose}>Пропустить</button><div>{index>0&&<button className="secondary-button compact-button" onClick={()=>setIndex(index-1)}><ArrowLeft size={15}/>Назад</button>}<button className="primary-button" data-action="guide-next" onClick={()=>index===steps.length-1?onClose():setIndex(index+1)}>{index===steps.length-1?<><Check size={16}/>Начать</>:<>Далее<ArrowRight size={16}/></>}</button></div></footer>
  </section></div>,document.body);
}
