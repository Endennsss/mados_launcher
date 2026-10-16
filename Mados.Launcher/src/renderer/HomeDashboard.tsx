import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, GripVertical, Pin, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { Favorite } from "../contracts/launcher";
import { defaultHomeLayout, homeBlocks, homeStorageKey, moveHomeBlock, normalizeHomeLayout, orderHomeFavorites, type HomeBlock, type HomeLayout } from "./home-personalization";
import { sanitizeServerAddress } from "./ui-helpers";
import { orderedFavorites, useFavoriteLayout } from "./favorite-collections";

function readLayout(accountId: string) {
  try {
    const stored = localStorage.getItem(homeStorageKey(accountId));
    return { layout: stored ? normalizeHomeLayout(JSON.parse(stored)) : defaultHomeLayout(), error: null as string | null };
  } catch { return { layout: defaultHomeLayout(), error: "Не удалось прочитать оформление главной. Используется стандартный вид." }; }
}

export function HomeDashboard({ accountId, favorites, renderBlocks }: {
  accountId: string; favorites: Favorite[]; renderBlocks: (favorites: Favorite[]) => Record<HomeBlock, ReactNode>;
}) {
  const [initial] = useState(() => readLayout(accountId));
  const collection = useFavoriteLayout(accountId);
  const [layout, setLayout] = useState(initial.layout);
  const [error, setError] = useState(initial.error);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<HomeBlock | null>(null);
  const [over, setOver] = useState<HomeBlock | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const before = useRef(new Map<string, number>());
  const animations = useRef<Animation[]>([]);
  const save = (next: HomeLayout) => {
    before.current.clear();
    root.current?.querySelectorAll<HTMLElement>("[data-home-motion]").forEach(node => before.current.set(node.dataset.homeMotion!, node.getBoundingClientRect().top));
    setLayout(next);
    try { localStorage.setItem(homeStorageKey(accountId), JSON.stringify(next)); setError(null); }
    catch { setError("Изменения действуют сейчас, но не сохранились. Проверьте доступ к данным лаунчера."); }
  };
  useLayoutEffect(() => {
    animations.current.forEach(animation => animation.cancel()); animations.current = [];
    if (document.documentElement.classList.contains("reduce-motion") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    root.current?.querySelectorAll<HTMLElement>("[data-home-motion]").forEach(node => {
      const top = before.current.get(node.dataset.homeMotion!);
      const dy = top == null ? 0 : top - node.getBoundingClientRect().top;
      if (dy && node.animate) animations.current.push(node.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" }));
    });
    before.current.clear();
    return () => animations.current.forEach(animation => animation.cancel());
  }, [layout]);
  const move = (source: HomeBlock, target: HomeBlock) => {
    const order = moveHomeBlock(layout.order, source, target);
    save({ ...layout, order }); setAnnouncement(`${homeBlocks[source]}: позиция ${order.indexOf(source) + 1} из ${order.length}`);
  };
  const blocks = renderBlocks(orderHomeFavorites(orderedFavorites(favorites, collection.layout), layout.pinned));
  const pinned = layout.pinned.filter(address => favorites.some(favorite => sanitizeServerAddress(favorite.address) === address));
  return <div className="home-dashboard" ref={root}>
    <div className="home-toolbar"><span>Ваше пространство</span><button className={`secondary-button compact-button ${editing ? "active" : ""}`} aria-label="Настроить главную" aria-expanded={editing} aria-controls="home-customizer" onClick={() => setEditing(value => !value)}><SlidersHorizontal size={16} />Настроить главную</button></div>
    {error && <p className="home-feedback" role="alert">{error}</p>}
    {editing && <section id="home-customizer" className="home-customizer" aria-label="Оформление главной">
      <div className="home-editor-heading"><div><h2>Главная под вас</h2><p>Перетащите за точки или используйте стрелки. Изменения сохраняются для этого аккаунта.</p></div><button className="secondary-button compact-button" onClick={() => setEditing(false)}><Check size={16} />Готово</button></div>
      <div className="home-editor-columns"><ol className="home-block-options">{layout.order.map((id, index) => <li key={id} data-home-motion={`option-${id}`} className={`${dragging === id ? "dragging" : ""} ${over === id && dragging !== id ? "drop-target" : ""}`}
        onDragOver={event => { if (!dragging) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setOver(id); }}
        onDrop={event => { if (!dragging) return; event.preventDefault(); event.stopPropagation(); move(dragging, id); setDragging(null); setOver(null); }}>
        <span className="home-drag-handle" draggable aria-hidden="true" onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData("application/x-mados-home-block", id); event.dataTransfer.effectAllowed = "move"; setDragging(id); }} onDragEnd={() => { setDragging(null); setOver(null); }}><GripVertical size={17} /></span>
        <span className="home-option-label">{homeBlocks[id]}</span><div className="home-order-actions"><button className="icon-button" disabled={index === 0} aria-label={`Выше: ${homeBlocks[id]}`} data-tooltip="Выше" onClick={() => move(id, layout.order[index - 1])}><ArrowUp size={15} /></button><button className="icon-button" disabled={index === layout.order.length - 1} aria-label={`Ниже: ${homeBlocks[id]}`} data-tooltip="Ниже" onClick={() => move(id, layout.order[index + 1])}><ArrowDown size={15} /></button></div>
        <button className="home-visibility" role="switch" aria-checked={!layout.hidden.includes(id)} aria-label={`Показывать блок ${homeBlocks[id]}`} onClick={() => save({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter(value => value !== id) : [...layout.hidden, id] })}><span /></button>
      </li>)}</ol><div className="home-pin-options"><h3><Pin size={16} />Закрепить на главной</h3><p>До четырёх избранных серверов будут первыми в блоке.</p>{favorites.length ? <div className="home-pin-list">{favorites.map(favorite => {
        const address = sanitizeServerAddress(favorite.address), selected = address != null && pinned.includes(address);
        return <button key={favorite.address} className={`home-pin-button ${selected ? "selected" : ""}`} aria-pressed={selected} disabled={!address || (!selected && pinned.length >= 4)} onClick={() => address && save({ ...layout, pinned: selected ? pinned.filter(value => value !== address) : [...pinned, address] })}><span>{favorite.name || address}</span><Pin key={String(selected)} size={15} /></button>;
      })}</div> : <p className="home-pin-empty">Добавьте серверы в избранное в каталоге — здесь можно будет их закрепить.</p>}</div></div>
      <div className="home-editor-footer"><span>{layout.order.length - layout.hidden.length} из {layout.order.length} блоков показано</span><button className="ghost-button" onClick={() => { save(defaultHomeLayout()); setAnnouncement("Стандартное оформление восстановлено"); }}><RotateCcw size={15} />Вернуть по умолчанию</button></div>
    </section>}
    <span className="home-sr-only" role="status">{announcement}</span>
    <div className="home-blocks">{layout.order.filter(id => !layout.hidden.includes(id)).map(id => <div key={id} className="home-block" data-home-block={id} data-home-motion={`block-${id}`}>{blocks[id]}</div>)}</div>
    {layout.hidden.length === layout.order.length && <div className="home-empty-layout"><SlidersHorizontal size={26} /><h2>Главная — чистый лист</h2><p>Все блоки скрыты. Выберите то, что хотите видеть здесь.</p><button className="secondary-button" onClick={() => setEditing(true)}>Выбрать блоки</button></div>}
  </div>;
}
