// Settings (SPEC §6.9): lock, "remember on this device", and read-only views of
// config.json and symbols.json. The GitHub PAT field arrives in milestone 5.
import { useState } from "react";
import type { DataBundle } from "../../core/types";
import { dateTimeOf } from "../format";
import { isRemembered, lock, setRemembered } from "../vault";

const HISTORY_REPO = "https://github.com/Lykam/trade-history";

function JsonPanel({ title, file, value }: { title: string; file: string; value: unknown }) {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        <h2>{title}</h2>
        <a href={`${HISTORY_REPO}/edit/main/${file}`} target="_blank" rel="noopener noreferrer" className="small">EDIT ON GITHUB ↗</a>
      </div>
      <pre className="json">{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

export function SettingsPage({ data }: { data: DataBundle }) {
  const dev = import.meta.env.DEV;
  const [remember, setRemember] = useState(() => !dev && isRemembered());
  const toggle = (on: boolean) => {
    setRemembered(on);
    setRemember(isRemembered());
  };

  return (
    <main className="page">
      <header className="page-head"><h1>SETTINGS</h1></header>
      <div className="settings">
        <section className="panel" aria-label="Lock">
          <div className="panel-head"><h2>Lock</h2></div>
          <div className="body">
            {dev ? (
              <p className="muted">Dev mode: data comes in plaintext from your local trade-history and Playbook checkouts, so there is nothing to lock. The deployed site asks for the passphrase.</p>
            ) : (
              <>
                <p className="muted">
                  Unlocked. The derived key (never the passphrase) is kept {remember ? "in this browser until you lock it" : "for this tab only"}.
                </p>
                <label className="check">
                  <input type="checkbox" checked={remember} onChange={(e) => toggle(e.target.checked)} />
                  <span>Remember on this device</span>
                </label>
                <div>
                  <button type="button" className="btn primary" onClick={lock}>LOCK NOW</button>
                </div>
                <p className="dim small">LOCK forgets the key in this browser and clears the decrypted data from memory.</p>
              </>
            )}
          </div>
        </section>

        <section className="panel" aria-label="Data">
          <div className="panel-head"><h2>Data</h2></div>
          <div className="body">
            <dl className="kv">
              <dt>{dev ? "Loaded" : "Built"}</dt><dd>{dateTimeOf(data.loadedAt)}</dd>
              <dt>Quotes as of</dt><dd>{data.quotes ? dateTimeOf(data.quotes.asOf) : "none"}</dd>
              <dt>Generator</dt><dd>{data.derived.generator}</dd>
            </dl>
          </div>
        </section>

        <section className="panel" aria-label="GitHub token">
          <div className="panel-head"><h2>GitHub token</h2></div>
          <div className="body"><p className="muted">In-browser import and override editing arrive in milestone 5.</p></div>
        </section>

        <JsonPanel title="config.json" file="config.json" value={data.config} />
        <JsonPanel title="symbols.json" file="symbols.json" value={data.symbols} />
      </div>
    </main>
  );
}
