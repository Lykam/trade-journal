// Settings (SPEC §6.9): lock, "remember on this device", the GitHub token(s)
// for in-browser import and override edits, and read-only views of config.json
// and symbols.json.
import { useState } from "react";
import { gaugeRules } from "../../core/gauge/gauge";
import type { DataBundle } from "../../core/types";
import { DEMO_TOKEN_NOTE } from "../demo-text";
import { dateTimeOf } from "../format";
import { DEFAULT_DATA_REPO, forgetToken, saveCheckedToken, useToken } from "../github";
import { isRemembered, lock, setRemembered } from "../vault";

/** GitHub pre-fills these fields; repository access must still be picked by hand. */
const NEW_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?" +
  new URLSearchParams({
    name: "trade-journal browser",
    description: "Trade journal web app: CSV import and override edits. Repository access: trade-history only.",
    target_name: "Lykam",
    expires_in: "90",
    contents: "write",
  });
const NEW_ACTIONS_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?" +
  new URLSearchParams({
    name: "trade-journal refresh prices",
    description: "Trade journal web app: Refresh prices button. Repository access: trade-journal only.",
    target_name: "Lykam",
    expires_in: "90",
    actions: "write",
  });

function TokenPanel() {
  const state = useToken();
  const [editing, setEditing] = useState(false);
  const [repo, setRepo] = useState(DEFAULT_DATA_REPO);
  const [token, setToken] = useState("");
  const [actionsToken, setActionsToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await saveCheckedToken(token, repo, actionsToken);
      setToken("");
      setActionsToken("");
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const record = state.status === "ok" ? state.record : null;
  const form = editing || state.status === "none" || state.status === "unreadable";
  return (
    <section className="panel" aria-label="GitHub token">
      <div className="panel-head"><h2>GitHub token</h2></div>
      <div className="body">
        {state.status === "loading" && <p className="muted">…</p>}
        {state.status === "unreadable" && (
          <p className="half">A token is saved in this browser but can't be opened with the current passphrase. Enter it again, or clear it.</p>
        )}
        {record && !editing && (
          <>
            <dl className="kv">
              <dt>Writes to</dt><dd>{record.repo}</dd>
              <dt>Refresh prices</dt><dd>{record.actions ? (record.actionsToken ? "yes (separate Actions token)" : "yes") : "no (no Actions token)"}</dd>
              <dt>Expires</dt>
              <dd>
                {/* GitHub doesn't expose github-authentication-token-expiration to browsers (CORS), so this is usually unknown here. */}
                {record.expiresAt ?? <>see the <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">token page ↗</a> (GitHub doesn't show it to browsers)</>}
              </dd>
              <dt>Checked</dt><dd>{dateTimeOf(record.checkedAt)}</dd>
            </dl>
            {record.mainReachesApp && (
              <p className="half small">
                This token also reaches trade-journal, which gives it Contents: write on the public app repo. Limit it to {record.repo} and use a separate
                Actions token for Refresh prices.
              </p>
            )}
            <div className="row">
              <button type="button" className="btn" onClick={() => { setRepo(record.repo); setEditing(true); }}>REPLACE</button>
              <button type="button" className="btn" onClick={forgetToken}>CLEAR</button>
            </div>
          </>
        )}
        {form && (
          <form className="token-form" onSubmit={save} autoComplete="off">
            <p className="muted small">
              A <b>fine-grained</b> token with <b>Contents: read and write</b> on {DEFAULT_DATA_REPO} only.{" "}
              <a href={NEW_TOKEN_URL} target="_blank" rel="noopener noreferrer">CREATE ONE ↗</a> (permissions are pre-filled; under Repository access pick
              "Only select repositories" and choose trade-history).
            </p>
            <label className="field">
              <span className="label small">Repository</span>
              <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span className="label small">Token</span>
              <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" spellCheck={false} autoComplete="off" required />
            </label>
            <details>
              <summary className="muted small">Optional: Refresh prices (separate Actions token)</summary>
              <p className="muted small">
                A second fine-grained token with <b>Actions: read and write</b> on trade-journal only.{" "}
                <a href={NEW_ACTIONS_TOKEN_URL} target="_blank" rel="noopener noreferrer">CREATE ONE ↗</a> One token for both repos would also get
                Contents: write on the public app repo, so they are kept apart.
              </p>
              <label className="field">
                <span className="label small">Actions token</span>
                <input className="input" type="password" value={actionsToken} onChange={(e) => setActionsToken(e.target.value)} placeholder="github_pat_… (optional)" spellCheck={false} autoComplete="off" />
              </label>
            </details>
            <div className="row">
              <button type="submit" className="btn primary" disabled={busy || !token.trim()}>{busy ? "CHECKING…" : "CHECK AND SAVE"}</button>
              {editing && <button type="button" className="btn" onClick={() => setEditing(false)}>CANCEL</button>}
              {state.status === "unreadable" && <button type="button" className="btn" onClick={forgetToken}>CLEAR</button>}
            </div>
            {error && <p className="loss small">{error}</p>}
            <p className="dim small">
              Saving checks read and write access (it creates an empty, unreferenced blob; no commit). The token is encrypted with a key derived from your
              passphrase and stored in this browser; it is sent only to api.github.com. After LOCK it can't be read until you unlock again.
              {import.meta.env.DEV ? " Dev mode keeps it in this page's memory only." : ""}
            </p>
          </form>
        )}
      </div>
    </section>
  );
}

const HISTORY_REPO = "https://github.com/Lykam/trade-history";

function JsonPanel({ title, file, value }: { title: string; file: string; value: unknown }) {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        <h2>{title}</h2>
        {!__TJ_DEMO__ && <a href={`${HISTORY_REPO}/edit/main/${file}`} target="_blank" rel="noopener noreferrer" className="small">EDIT ON GITHUB ↗</a>}
      </div>
      <pre className="json">{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

export function SettingsPage({ data }: { data: DataBundle }) {
  return __TJ_DEMO__ ? <DemoSettingsPage data={data} /> : <RealSettingsPage data={data} />;
}

/** Demo build (Q50): no lock and no token, one line instead; the read-only views show the demo's files. */
function DemoSettingsPage({ data }: { data: DataBundle }) {
  return (
    <main className="page">
      <header className="page-head"><h1>SETTINGS</h1></header>
      <div className="settings">
        <section className="panel" aria-label="GitHub token">
          <div className="panel-head"><h2>GitHub token</h2></div>
          <div className="body"><p className="muted">{DEMO_TOKEN_NOTE}</p></div>
        </section>
        <section className="panel" aria-label="Data">
          <div className="panel-head"><h2>Data</h2></div>
          <div className="body">
            <dl className="kv">
              <dt>Built</dt><dd>{dateTimeOf(data.loadedAt)}</dd>
              <dt>Prices</dt><dd>{data.quotes ? dateTimeOf(data.quotes.asOf) : "none"}</dd>
            </dl>
          </div>
        </section>
        <GaugeRules data={data} />
        <JsonPair data={data} />
      </div>
    </main>
  );
}

/** The gauge rules in plain words above the raw JSON (#23). */
function GaugeRules({ data }: { data: DataBundle }) {
  return (
    <section className="panel" aria-label="Gauge rules">
      <div className="panel-head"><h2>Gauge rules</h2></div>
      <div className="body">{gaugeRules(data.config).map((l) => <p key={l} className="text-2">{l}</p>)}</div>
    </section>
  );
}

/** config.json and symbols.json side by side across the page, instead of one left alone below (#23). */
function JsonPair({ data }: { data: DataBundle }) {
  return (
    <div className="json-pair">
      <JsonPanel title="config.json" file="config.json" value={data.config} />
      <JsonPanel title="symbols.json" file="symbols.json" value={data.symbols} />
    </div>
  );
}

function RealSettingsPage({ data }: { data: DataBundle }) {
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
              <dt>Prices</dt><dd>{data.quotes ? dateTimeOf(data.quotes.asOf) : "none"}</dd>
              <dt>Generator</dt><dd>{data.derived.generator}</dd>
            </dl>
          </div>
        </section>

        <TokenPanel />
        <GaugeRules data={data} />
        <JsonPair data={data} />
      </div>
    </main>
  );
}
