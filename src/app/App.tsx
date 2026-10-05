import { useEffect, useMemo } from "react";
import { parseView } from "../core/journal/filter";
import { buildJournal } from "../core/journal/journal";
import { dayOfWeek } from "../core/calendar";
import { importBehind } from "../core/market";
import { etDate } from "../core/normalize/util";
import type { Broker, DataBundle } from "../core/types";
import { appNow, useBundle, useRoute } from "./data";
import { DOW, stamp } from "./format";
import { lock } from "./vault";
import { CalendarPage } from "./pages/CalendarPage";
import { DeployBanner } from "./components/DeployBanner";
import { Dashboard } from "./pages/Dashboard";
import { ImportPage } from "./pages/ImportPage";
import { JournalPage, ReviewPage } from "./pages/JournalPage";
import { LockScreen } from "./pages/LockScreen";
import { OpenPage } from "./pages/OpenPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SettingsPage } from "./pages/SettingsPage";
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

const BROKERS: Broker[] = ["webull", "schwab"];

/**
 * "PRICES FRI 10-02 16:00 ET · WEBULL 10-02 · SCHWAB 10-02": how fresh the prices and each
 * broker's last import are. An import older than the latest closed session turns amber (#15).
 */
function DataStamps({ data, now }: { data: DataBundle; now: string }) {
  const asOf = data.quotes?.asOf;
  return (
    <span className="stamps">
      <span className="muted">{asOf ? `PRICES ${DOW[dayOfWeek(etDate(asOf))]} ${stamp(asOf)} ET` : "NO PRICES"}</span>
      {BROKERS.map((b) => {
        const at = data.imports?.[b];
        if (!at) return null;
        const behind = importBehind(at, now);
        return (
          <span key={b} className={behind ? "accent" : "muted"} title={`Last ${b} import ${stamp(at)} ET${behind ? ": older than the last market close" : ""}`}>
            {b.toUpperCase()} {etDate(at).slice(5)}{behind ? " !" : ""}
          </span>
        );
      })}
    </span>
  );
}

export function App() {
  const load = useBundle();
  const { path, params } = useRoute();
  const now = useMemo(appNow, []);

  const journal = useMemo(() => (load.status === "ready" ? buildJournal(load.data, etDate(now)) : null), [load, now]);
  const view = useMemo(() => parseView(params), [params]);
  useEffect(() => {
    window.scrollTo(0, 0);
    // On a phone the nav scrolls sideways (#17): keep the active tab in view.
    document.querySelector(".nav a.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [path]);

  const pinned = new URLSearchParams(window.location.search).has("now");

  // The encrypted site shows nothing but the passphrase screen until unlocked. (The demo never locks.)
  if (load.status === "locked") return __TJ_DEMO__ ? null : <LockScreen notice={load.notice} unlock={load.unlock} />;

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
  else if (path === "/reports") page = <ReportsPage journal={journal!} view={view} params={params} />;
  else if (path === "/settings") page = <SettingsPage data={load.data} />;
  else if (path === "/import") page = <ImportPage data={load.data} />;
  else page = <Stub title="NOT FOUND" />;

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
        {load.status === "ready" && <DataStamps data={load.data} now={now} />}
        <a className="btn primary" href="#/import">IMPORT</a>
        {__TJ_DEMO__ ? (
          <span className="chip accent chip-lg" title="This demo runs on synthetic data generated in your browser">DEMO</span>
        ) : import.meta.env.DEV ? (
          <button type="button" className="btn" disabled title="Dev mode reads local plaintext; the deployed site locks">LOCK</button>
        ) : (
          <button type="button" className="btn" onClick={lock} disabled={load.status !== "ready"} title="Forget the key in this browser">LOCK</button>
        )}
      </nav>
      {__TJ_DEMO__ ? <div className="marker-line" role="note">DEMO · synthetic data</div> : <DeployBanner />}
      {page}
    </>
  );
}
