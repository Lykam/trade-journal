// "Deploying…" after a commit or a prices refresh (SPEC §4.5A step 5): polls
// data.enc until the new data is live, then offers a reload; after ~5 minutes it
// links to the Actions runs instead of spinning forever.
import { useEffect, useState } from "react";
import { freshReload } from "../data";
import { dismissDeploy, useDeploy } from "../github";

export function DeployBanner() {
  const s = useDeploy();
  const [, tick] = useState(0);
  useEffect(() => {
    if (s?.phase !== "waiting") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [s?.phase]);
  if (!s) return null;
  const secs = Math.round((Date.now() - s.startedAt) / 1000);
  return (
    <div className={`deploy-banner ${s.phase}`} role="status" aria-live="polite">
      <b>{s.label.toUpperCase()}</b>
      {s.commitUrl && <a href={s.commitUrl} target="_blank" rel="noopener noreferrer">COMMIT ↗</a>}
      {s.phase === "waiting" && <span className="muted">DEPLOYING… {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>}
      {s.phase === "ready" && (
        <>
          <span className="gain">NEW DATA IS LIVE</span>
          <button type="button" className="btn primary" onClick={freshReload}>RELOAD</button>
        </>
      )}
      {s.phase === "timeout" && (
        <span className="half">
          {s.note ?? "Still not deployed after 5 minutes."}{" "}
          <a href={s.link} target="_blank" rel="noopener noreferrer">ACTIONS RUNS ↗</a>
        </span>
      )}
      {s.note && s.phase !== "timeout" && <span className="dim small">{s.note}</span>}
      <span className="grow" />
      <button type="button" className="btn ghost" onClick={dismissDeploy} aria-label="Dismiss">✕</button>
    </div>
  );
}
