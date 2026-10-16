import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ArrowRight, BookOpen, Check, Download, ExternalLink, Newspaper, RefreshCw, Sparkles, X } from "lucide-react";
import type { NewsItem, ShellUpdateState } from "../contracts/launcher";
import { isMadosRelease, newsDate, newsReadKey, readNewsHistory, releaseRelation } from "./news-journal";
import { ReleaseText } from "./ReleaseText";
import { LoadingCards, ViewState } from "./ViewState";

type Props = { accountId: string; update: ShellUpdateState; onOpenUpdate: () => void };
type Filter = "all" | "mados" | "station" | "unread";
export function NewsView(props: Props) { return <NewsJournal key={props.accountId} {...props} />; }

function NewsJournal({ accountId, update, onOpenUpdate }: Props) {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [read, setRead] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<NewsItem | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current; setLoading(true); setError(null);
    try {
      const result = await window.mados.invoke<NewsItem[]>("news.list");
      if (request === sequence.current) setItems(result);
    } catch (caught) { if (request === sequence.current) setError(caught instanceof Error ? caught.message : "Не удалось загрузить новости"); }
    finally { if (request === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    try { setRead(readNewsHistory(accountId)); } catch { setReadError("Не удалось прочитать отметки новостей. Публикации по-прежнему доступны."); }
    void load(); return () => { sequence.current++; };
  }, [accountId, load]);
  const open = (item: NewsItem, trigger: HTMLElement) => {
    opener.current = trigger;
    setSelected(item);
    const next = [...read.filter(id => id !== item.link), item.link].slice(-200);
    try { localStorage.setItem(newsReadKey(accountId), JSON.stringify(next)); setRead(next); setReadError(null); }
    catch { setReadError("Не удалось сохранить отметку о прочтении. Откройте публикацию ещё раз, чтобы повторить."); }
  };
  const matches = (item: NewsItem) => filter === "all" || (filter === "mados" && isMadosRelease(item)) || (filter === "station" && !isMadosRelease(item)) || (filter === "unread" && !read.includes(item.link));
  const latest = items.find(item => isMadosRelease(item) && !item.prerelease);
  const featured = latest && matches(latest) ? latest : null;
  const rest = items.filter(item => item !== featured && matches(item));
  const relation = featured ? releaseRelation(featured, update) : null;
  return <section className="page page-enter news-journal">
    <div className="page-heading"><div><p className="eyebrow">Журнал Mados</p><h1>Новости</h1><p className="page-subtitle">Что нового в лаунчере и на станции.</p></div><button className="icon-button" disabled={loading} onClick={() => void load()} aria-label="Обновить новости"><RefreshCw size={18} className={loading ? "spin" : ""}/></button></div>
    <div className="news-toolbar"><div className="news-filters" aria-label="Источник новостей">{([["all", "Все"], ["mados", "Mados"], ["station", "Space Station 14"], ["unread", "Непрочитанные"]] as const).map(([id, title]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{title}{id === "unread" && <span>{items.filter(item => !read.includes(item.link)).length}</span>}</button>)}</div><span className="news-local-hint"><BookOpen size={13}/> Читайте прямо здесь</span></div>
    {error && <ViewState compact={items.length>0} kind="error" title="Новости пока недоступны" description={error} action="Повторить" actionId="retry-news" onAction={()=>void load()}/>}
    {readError && <p className="journal-feedback" role="alert"><AlertCircle size={16}/>{readError}</p>}
    {loading && items.length === 0 ? <LoadingCards count={3} label="Собираем последние публикации…"/> : <>
      {featured && <article className="news-feature" data-news-read={read.includes(featured.link)}>
        <div className="news-feature-top"><span className="news-source"><Sparkles size={14}/> Последний релиз Mados</span><span className="news-read-state">{read.includes(featured.link) ? <><Check size={13}/> Прочитано</> : <><i/> Новое</>}</span></div>
        <div className="news-feature-body"><span className="news-feature-symbol"><Newspaper size={32} strokeWidth={1.6}/></span><div><div className="news-meta"><time>{newsDate(featured.date)}</time>{relation === "installed" && <span className="news-version-badge installed"><Check size={12}/> Установлено</span>}{relation === "available" && <span className="news-version-badge">Доступно обновление</span>}</div><h2>{featured.title}</h2><p>{featured.summary || "Изменения и улучшения Mados Launcher — в описании релиза."}</p></div></div>
        <div className="news-feature-actions"><button className="secondary-button compact-button" data-action="read-news" onClick={event => open(featured, event.currentTarget)}><BookOpen size={16}/> Читать изменения <ArrowRight size={14}/></button>{relation === "available" && <button className="text-link" data-action="open-update" onClick={onOpenUpdate}><Download size={15}/> К обновлению</button>}</div>
      </article>}
      {rest.length > 0 && <div className="news-feed-heading"><h2>Лента публикаций</h2><span>{rest.length}</span></div>}
      <div className="news-feed">{rest.map((item, index) => <button key={item.link} className="news-feed-item" data-action="read-news" data-news-read={read.includes(item.link)} style={{"--news-order": Math.min(index, 5)} as CSSProperties} onClick={event => open(item, event.currentTarget)}>
        <span className={`news-feed-icon ${isMadosRelease(item) ? "mados" : ""}`}>{isMadosRelease(item) ? <Download size={19}/> : <Newspaper size={19}/>}</span><span className="news-feed-copy"><span className="news-meta"><span>{isMadosRelease(item) ? "Mados Launcher" : item.source || "Space Station 14"}</span><time>{newsDate(item.date)}</time>{item.prerelease && <span>Предварительный релиз</span>}</span><strong>{item.title}</strong>{item.summary && <span className="news-feed-summary">{item.summary}</span>}</span><span className="news-feed-end">{read.includes(item.link) ? <Check size={14} aria-label="Прочитано"/> : <i aria-label="Не прочитано"/>}<ArrowRight size={17}/></span>
      </button>)}</div>
      {!error && !featured && rest.length === 0 && <ViewState icon={<BookOpen size={26}/>} title={filter === "unread" ? "Вы всё прочитали" : "Публикаций пока нет"} description={filter === "unread" ? "Новые новости появятся здесь после обновления ленты." : "Попробуйте другой источник или обновите ленту."} action="Обновить ленту" onAction={()=>void load()}/>}
    </>}
    {selected && <NewsReader item={selected} update={update} returnFocus={opener.current} onClose={() => setSelected(null)} onOpenUpdate={() => { setSelected(null); onOpenUpdate(); }}/>}
  </section>;
}

function NewsReader({ item, update, returnFocus, onClose, onOpenUpdate }: { item: NewsItem; update: ShellUpdateState; returnFocus: HTMLElement | null; onClose: () => void; onOpenUpdate: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const previous = returnFocus; let handoff = false;
    const background = document.querySelector<HTMLElement>(".app-layout");
    const wasInert = background?.inert ?? false;
    if (background) background.inert = true;
    panel.current?.querySelector<HTMLButtonElement>('[aria-label="Закрыть публикацию"]')?.focus({preventScroll:true});
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const buttons = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])];
      const first = buttons[0], last = buttons.at(-1);
      if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const search = () => { handoff = true; close.current(); };
    window.addEventListener("keydown", keydown); window.addEventListener("launcher-search-opened", search);
    return () => {
      window.removeEventListener("keydown", keydown); window.removeEventListener("launcher-search-opened", search);
      if (background) background.inert = wasInert;
      if (!handoff) (previous?.isConnected ? previous : document.querySelector<HTMLElement>('.news-filters [aria-pressed="true"]'))?.focus({preventScroll:true});
    };
  }, []);
  const openExternal = (url: string) => { setError(null); void window.mados.openExternal(url).catch(() => setError("Не удалось открыть ссылку. Попробуйте ещё раз.")); };
  return createPortal(<div className="news-reader-overlay" onClick={event => {if (event.target === event.currentTarget) onClose();}}>
    <aside ref={panel} className="news-reader" role="dialog" aria-modal="true" aria-labelledby="news-reader-title">
      <header className="news-reader-toolbar"><span><BookOpen size={16}/> Публикация</span><button className="icon-button" aria-label="Закрыть публикацию" onClick={onClose}><X size={18}/></button></header>
      <div className="news-reader-scroll" tabIndex={0}><div className="news-reader-heading"><span className="eyebrow">{isMadosRelease(item) ? "Mados Launcher" : item.source || "Space Station 14"}</span><h2 id="news-reader-title">{item.title}</h2><div className="news-meta"><time>{newsDate(item.date)}</time>{item.version && <span>{item.version}</span>}<span><Check size={12}/> Открыто</span></div></div><ReleaseText text={item.body || item.summary || "Описание не добавлено. Публикацию можно открыть в источнике."} markdown={isMadosRelease(item)} onOpenLink={openExternal}/></div>
      {error && <p role="alert" className="journal-feedback">{error}</p>}
      <footer className="news-reader-footer"><button className="secondary-button compact-button" onClick={() => openExternal(item.link)}>Открыть источник <ExternalLink size={14}/></button>{releaseRelation(item, update) === "available" && <button className="primary-button compact-button" onClick={onOpenUpdate}>К обновлению <ArrowRight size={15}/></button>}</footer>
    </aside>
  </div>, document.querySelector(".app-shell") ?? document.body);
}
