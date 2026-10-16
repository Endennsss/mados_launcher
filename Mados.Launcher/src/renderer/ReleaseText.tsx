import type { ReactNode } from "react";

// Deliberately limited Markdown: remote HTML and images never become executable DOM.
// Links are opened through the main process's existing external-URL validation.
function inline(text: string, open: (url: string) => void): ReactNode[] {
  return text.split(/(!?\[[^\]\n]{1,300}\]\(https?:\/\/[^\s)]{1,2048}\)|\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = /^(!?)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return link[1] ? <span key={index}>{link[2]}</span> : <button key={index} className="release-inline-link" onClick={() => open(link[3])}>{link[2]}</button>;
    return part;
  });
}
export function ReleaseText({ text, markdown = true, onOpenLink }: { text: string; markdown?: boolean; onOpenLink: (url: string) => void }) {
  const source = text.slice(0, 64000).replace(/\r/g, "");
  if (!markdown) return <div className="release-text">{source.split(/\n\s*\n/).map((part, index) => <p key={index}>{part}</p>)}</div>;
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++; blocks.push(<pre key={i}><code>{code.join("\n")}</code></pre>); continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { blocks.push(<h3 key={i}>{inline(heading[1], onOpenLink)}</h3>); i++; continue; }
    const bullet = /^(?:[-*+] |\d+\. )/.test(line);
    if (bullet) {
      const rows: ReactNode[] = [];
      while (i < lines.length && /^(?:[-*+] |\d+\. )/.test(lines[i])) {
        rows.push(<li key={i}>{inline(lines[i++].replace(/^(?:[-*+] |\d+\. )/, ""), onOpenLink)}</li>);
      }
      blocks.push(/^\d+\./.test(line) ? <ol key={i}>{rows}</ol> : <ul key={i}>{rows}</ul>); continue;
    }
    const paragraph: string[] = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#|```|[-*+] |\d+\. )/.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={i}>{inline(paragraph.join("\n"), onOpenLink)}</p>);
  }
  return <div className="release-text">{blocks}</div>;
}
