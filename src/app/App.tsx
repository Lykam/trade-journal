import { useMemo } from "react";
import { appNow, useBundle, useRoute } from "./data";
import { timeOf } from "./format";
import { Dashboard } from "./pages/Dashboard";
import { OpenPage } from "./pages/OpenPage";
import { Stub, TradeStub } from "./pages/Stub";

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
  "/cal": { title: "CALENDAR", milestone: 3 },
  "/trades": { title: "TRADES", milestone: 3 },
  "/journal": { title: "JOURNAL", milestone: 3 },
  "/reports": { title: "REPORTS", milestone: 7 },
  "/settings": { title: "SETTINGS", milestone: 4 },
  "/import": { title: "IMPORT", milestone: 5 },
};

export function App() {
  const load = useBundle();
  const { path, params } = useRoute();
  const now = useMemo(appNow, []);
  const asOf = load.status === "ready" ? load.data.quotes?.asOf : undefined;
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
  else if (path === "/") page = <Dashboard data={load.data} now={now} />;
  else if (path === "/open") page = <OpenPage data={load.data} now={now} />;
  else if (path.startsWith("/trade/")) page = <TradeStub data={load.data} id={path.slice(7)} />;
  else page = <Stub {...(STUBS[path] ?? { title: "NOT FOUND", milestone: 3 })} params={params} />;

  const active = path.startsWith("/trade/") ? "/trades" : path;
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
