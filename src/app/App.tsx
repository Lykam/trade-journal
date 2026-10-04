import { useEffect, useMemo } from "react";
import { parseView } from "../core/journal/filter";
import { buildJournal } from "../core/journal/journal";
import { etDate } from "../core/normalize/util";
import { appNow, useBundle, useRoute } from "./data";
import { timeOf } from "./format";
import { CalendarPage } from "./pages/CalendarPage";
import { Dashboard } from "./pages/Dashboard";
import { JournalPage, ReviewPage } from "./pages/JournalPage";
import { OpenPage } from "./pages/OpenPage";
import { Stub } from "./pages/Stub";
import { TradeDetail } from "./pages/TradeDetail";
import { TradesPage } from "./pages/TradesPage";

const NAV = [
  { path: "/", label: "DASH" },
  { path: "/open", label: "OPEN" },
  { path: "/cal", label: "CAL" },
  { path: "/trades", label: "TRADES" },
  { path: "/reports", label: "REPORTS" },
  { path: "/journal", label: "JOURNAL" },
  { path: "/settings", label: "SETTINGS" },
];

const STUBS: Record<string, { title: string; milestone: number }> = {
  "/reports": { title: "REPORTS", milestone: 7 },
  "/settings": { title: "SETTINGS", milestone: 4 },
  "/import": { title: "IMPORT", milestone: 5 },
};

export function App() {
  const load = useBundle();
  const { path, params } = useRoute();
  const now = useMemo(appNow, []);
  const asOf = load.status === "ready" ? load.data.quotes?.asOf : undefined;
  const journal = useMemo(() => (load.status === "ready" ? buildJournal(load.data, etDate(now)) : null), [load, now]);
  const view = useMemo(() => parseView(params), [params]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);
  const pinned = new URLSearchParams(window.location.search).has("now");

  let page: React.ReactNode;
  if (load.status === "loading") page = <div className="center-msg">LOADING…</div>;
  else if (load.status === "error")
    page = (
      <div className="center-msg">
        <div className="loss b">COULD NOT LOAD DATA</div>
        <pre>{load.message}</pre>
      </div>
    );
  else if (path === "/") page = <Dashboard data={load.data} journal={journal!} now={now} />;
  else if (path === "/open") page = <OpenPage data={load.data} now={now} />;
  else if (path === "/trades") page = <TradesPage data={load.data} journal={journal!} view={view} />;
  else if (path.startsWith("/trade/")) page = <TradeDetail key={path} data={load.data} journal={journal!} id={decodeURIComponent(path.slice(7))} view={view} now={now} />;
  else if (path === "/cal") page = <CalendarPage journal={journal!} view={view} params={params} />;
  else if (path === "/journal") page = <JournalPage journal={journal!} view={view} />;
  else if (path.startsWith("/journal/")) page = <ReviewPage key={path} journal={journal!} id={decodeURIComponent(path.slice(9))} view={view} />;
  else page = <Stub {...(STUBS[path] ?? { title: "NOT FOUND", milestone: 3 })} params={params} />;

  const active = path.startsWith("/trade/") ? "/trades" : path.startsWith("/journal/") ? "/journal" : path;
  return (
    <>
      <nav className="nav" aria-label="Main">
        <span className="brand">TRADE/JRNL</span>
        {NAV.map((n) => (
          <a key={n.path} href={`#${n.path}`} className={active === n.path ? "active" : ""} aria-current={active === n.path ? "page" : undefined}>
            {n.label}
          </a>
        ))}
        <span className="spacer" />
        {pinned && <span className="half">NOW PINNED {now.slice(0, 16)}Z</span>}
        <span className="muted">{asOf ? `QUOTES ${timeOf(asOf)}` : "NO QUOTES"}</span>
        <a className="btn primary" href="#/import">IMPORT</a>
        <button type="button" className="btn" disabled title="Encryption arrives in milestone 4">LOCK</button>
      </nav>
      {page}
    </>
  );
}
