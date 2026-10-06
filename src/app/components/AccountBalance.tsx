// Settings → Account value (Q68): an account's starting balance, and the actual
// value entered from the broker now and then to correct drift. Both live under
// `balances` in trade-history's config.json; COMMIT reads trade-history fresh,
// previews, then writes config.json in one commit (Q40), like the other edits.
//
// Everything that talks to GitHub lives in BalanceCommit, which the demo build
// never renders, so the demo bundle carries no token or GitHub code (Q50).
import { useMemo, useState } from "react";
import { accountValues, checkpointGap, heldAtClose } from "../../core/account/value";
import type { BalanceCommitPlan } from "../../core/account/commit";
import { etDate } from "../../core/normalize/util";
import type { AccountBalance, AccountCheckpoint, DataBundle } from "../../core/types";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { money, pct } from "../format";
import { ACTIONS_URL, clientFor, feedsSite, useToken, watchDeploy } from "../github";

type Editing = { kind: "start"; account: string } | { kind: "actual"; account: string } | { kind: "remove"; account: string; date: string };

const num = (s: string) => (s.trim() === "" ? NaN : Number(s.replace(/[$,\s]/g, "")));

/** Settings panel: each account's balance, value now and the actual values entered. */
export function AccountsPanel({ data }: { data: DataBundle }) {
  const now = new Date().toISOString();
  const quotes = data.quotes?.quotes ?? {};
  const values = useMemo(() => accountValues(data.derived.trades, data.config, quotes, now), [data]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const balances = data.config.balances ?? {};
  return (
    <section className="panel" aria-label="Account value">
      <div className="panel-head"><h2>Account value</h2></div>
      <div className="scroll-x">
        <table className="grid dense">
          <thead><tr><th>ACCOUNT</th><th>START</th><th className="num">VALUE</th><th className="num">CASH</th><th>LAST ACTUAL</th><th /></tr></thead>
          <tbody>
            {data.config.accounts.map((a) => {
              const b = balances[a];
              const v = values.get(a);
              return (
                <tr key={a}>
                  <td><b>{a}</b> <span className="dim small">{data.config.styleByAccount[a]?.toUpperCase()}</span></td>
                  <td>{b ? <>{money(b.start.amount, { sign: false })} <span className="muted">on {b.start.date}</span></> : <span className="dim">not set</span>}</td>
                  <td className="num b">{v ? money(v.value, { sign: false }) : "—"}</td>
                  <td className="num">{v ? <>{money(v.cash, { sign: false })} <span className="muted">({pct(v.value > 0 ? v.cash / v.value : null, 1)})</span></> : "—"}</td>
                  <td>{v?.checkpoint ? <>{money(v.checkpoint.value, { sign: false })} <span className="muted">{v.checkpoint.date} · corr. {money(v.adjustment)}</span></> : <span className="dim">—</span>}</td>
                  <td className="row">
                    <button type="button" className="btn ghost tiny" onClick={() => setEditing({ kind: "start", account: a })}>{b ? "EDIT START" : "SET START"}</button>
                    {b && <button type="button" className="btn ghost tiny" onClick={() => setEditing({ kind: "actual", account: a })}>ENTER ACTUAL VALUE</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && (
        <div className="body">
          <BalanceForm key={JSON.stringify(editing)} data={data} editing={editing} onClose={() => setEditing(null)} />
        </div>
      )}
      <CheckpointList data={data} onRemove={(account, date) => setEditing({ kind: "remove", account, date })} />
      <div className="body dim small">
        Value = start + every buy and sale since (cash) + open positions at the last price (at cost without one). Enter the broker's
        total after a close to correct anything the fills miss; the gap carries forward until the next one.
      </div>
    </section>
  );
}

function CheckpointList({ data, onRemove }: { data: DataBundle; onRemove: (account: string, date: string) => void }) {
  const rows = Object.entries(data.config.balances ?? {}).flatMap(([a, b]) => (b.checkpoints ?? []).map((c) => ({ a, b, c })));
  if (!rows.length) return null;
  rows.sort((x, y) => y.c.date.localeCompare(x.c.date));
  return (
    <div className="scroll-x">
      <table className="grid dense">
        <thead><tr><th>ACTUAL VALUES</th><th>DATE</th><th className="num">ENTERED</th><th className="num">CORRECTION</th><th>PRICES</th><th /></tr></thead>
        <tbody>
          {rows.map(({ a, b, c }) => (
            <tr key={`${a}-${c.date}`}>
              <td>{a}</td><td>{c.date}</td><td className="num">{money(c.value, { sign: false })}</td>
              <td className="num">{money(checkpointGap(data.derived.trades, a, b, c))}</td>
              <td className="muted small">{Object.entries(c.marks).map(([s, p]) => `${s} ${p}`).join(", ") || "—"}</td>
              <td><button type="button" className="btn ghost tiny" onClick={() => onRemove(a, c.date)} aria-label={`Remove the actual value for ${c.date}`}>REMOVE</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The form for one change; it builds the account's whole new balance for the commit. */
function BalanceForm({ data, editing, onClose }: { data: DataBundle; editing: Editing; onClose: () => void }) {
  const { account } = editing;
  const existing = data.config.balances?.[account];
  const today = etDate(new Date().toISOString());
  const firstFill = data.derived.trades.filter((t) => t.account === account).map((t) => etDate(t.openedAt)).sort()[0] ?? today;
  const [startDate, setStartDate] = useState(existing?.start.date ?? firstFill);
  const [amount, setAmount] = useState(existing ? String(existing.start.amount) : "");
  const [date, setDate] = useState(today);
  const [value, setValue] = useState("");
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const off = busy || undefined;

  const held = useMemo(
    () => (existing && editing.kind === "actual" ? heldAtClose(data.derived.trades, account, existing, date) : []),
    [data, account, existing, editing.kind, date],
  );
  // Today's form starts from the latest quotes; the owner types the closing prices if they differ.
  const markText = (s: string) => marks[s] ?? (date === today && data.quotes?.quotes[s] ? String(data.quotes.quotes[s]!.price) : "");

  let next: AccountBalance | null = null;
  let error: string | null = null;
  if (editing.kind === "start") {
    const amt = num(amount);
    if (!Number.isFinite(amt) || amt < 0) error = "Enter the starting balance.";
    next = { start: { date: startDate, amount: amt }, ...(existing?.checkpoints?.length ? { checkpoints: existing.checkpoints } : {}) };
  } else if (editing.kind === "actual" && existing) {
    const v = num(value);
    const m: Record<string, number> = {};
    for (const h of held) {
      const p = num(markText(h.symbol));
      if (Number.isFinite(p)) m[h.symbol] = p;
    }
    if (!Number.isFinite(v)) error = "Enter the account value the broker shows.";
    const cp: AccountCheckpoint = { date, value: v, marks: m };
    next = { start: existing.start, checkpoints: [...(existing.checkpoints ?? []).filter((c) => c.date !== date), cp] };
  } else if (editing.kind === "remove" && existing) {
    const rest = (existing.checkpoints ?? []).filter((c) => c.date !== editing.date);
    next = { start: existing.start, ...(rest.length ? { checkpoints: rest } : {}) };
  }

  return (
    <div className="symmap" role="group" aria-label={`Account value for ${account}`}>
      {editing.kind === "start" && (
        <div className="row">
          <label className="field"><span className="label small">START DATE</span>
            <input type="date" className="input" value={startDate} disabled={off} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="field"><span className="label small">STARTING BALANCE ($)</span>
            <input className="input narrow" inputMode="decimal" value={amount} disabled={off} onChange={(e) => setAmount(e.target.value)} placeholder="500" autoFocus />
          </label>
          <span className="dim small">Cash in {account} on that day, before its trades. Trades opened earlier are left out.</span>
        </div>
      )}
      {editing.kind === "actual" && (
        <>
          <div className="row">
            <label className="field"><span className="label small">AT THE CLOSE OF</span>
              <input type="date" className="input" value={date} max={today} min={existing?.start.date} disabled={off} onChange={(e) => { setDate(e.target.value); setMarks({}); }} />
            </label>
            <label className="field"><span className="label small">ACCOUNT VALUE ($)</span>
              <input className="input narrow" inputMode="decimal" value={value} disabled={off} onChange={(e) => setValue(e.target.value)} placeholder="from the broker" autoFocus />
            </label>
            {held.map((h) => (
              <label key={h.symbol} className="field"><span className="label small">{h.symbol} PRICE <span className="dim">({h.shares} sh)</span></span>
                <input className="input narrow" inputMode="decimal" value={markText(h.symbol)} disabled={off} onChange={(e) => setMarks({ ...marks, [h.symbol]: e.target.value })} placeholder="at cost" />
              </label>
            ))}
          </div>
          <span className="dim small">
            {held.length ? "Prices at that close (pre-filled from the latest quotes for today); a blank one counts at cost." : "No positions held at that close."}
          </span>
        </>
      )}
      {editing.kind === "remove" && <div className="text-2">Remove the actual value entered for {editing.date} ({account})?</div>}
      {__TJ_DEMO__ ? (
        <div className="row">
          <button type="button" className="btn primary" disabled>COMMIT…</button>
          <span className="note-line">{DEMO_COMMIT_NOTE}</span>
          <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
        </div>
      ) : (
        <BalanceCommit account={account} next={next} error={error} onBusy={setBusy} onClose={onClose} />
      )}
    </div>
  );
}

type Remote = import("../remote").RemoteHistory;
type Phase =
  | { kind: "edit"; error?: string }
  | { kind: "reading" }
  | { kind: "review"; plan: BalanceCommitPlan; remote: Remote; notice?: string }
  | { kind: "committing" }
  | { kind: "done"; url: string | null };

/** Read trade-history fresh, preview, then commit (never rendered in the demo). */
function BalanceCommit({ account, next, error, onBusy, onClose }: {
  account: string;
  next: AccountBalance | null;
  error: string | null;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const token = useToken();
  const [phase, setPhaseRaw] = useState<Phase>({ kind: "edit" });
  const setPhase = (p: Phase) => {
    setPhaseRaw(p);
    onBusy(p.kind !== "edit");
  };
  if (token.status !== "ok") {
    return (
      <div className="row">
        <span className="dim small">{token.status === "loading" ? "…" : <>To commit, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}</span>
        <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
      </div>
    );
  }
  const record = token.record;

  const review = async () => {
    if (error) return setPhase({ kind: "edit", error });
    setPhase({ kind: "reading" });
    try {
      const { gh, repo } = clientFor(record);
      const remote = await import("../remote");
      const r = await remote.read(gh, repo);
      setPhase({ kind: "review", plan: remote.computeBalance(r, account, next), remote: r });
    } catch (e) {
      setPhase({ kind: "edit", error: (e as Error).message });
    }
  };

  const commit = async (p: Extract<Phase, { kind: "review" }>) => {
    setPhase({ kind: "committing" });
    try {
      const remote = await import("../remote");
      const out = await remote.commitBalance(clientFor(record).gh, p.remote, p.plan, account, next);
      if (out.commit) {
        const site = feedsSite(record);
        watchDeploy({
          label: "Account value committed",
          want: site ? { sha: out.commit.sha, date: out.commit.date } : { date: out.commit.date },
          link: `${ACTIONS_URL}/workflows/deploy.yml`,
          commitUrl: out.commit.url,
          note: site ? undefined : `Committed to ${record.repo}, which the site doesn't read; the reload shows the same data.`,
        });
      }
      setPhase({ kind: "done", url: out.commit?.url ?? null });
    } catch (e) {
      const err = e as Error & { plan?: BalanceCommitPlan; remote?: Remote };
      if (err.name === "PreviewChangedError" && err.plan && err.remote) setPhase({ ...p, plan: err.plan, remote: err.remote, notice: err.message });
      else setPhase({ kind: "edit", error: err.message });
    }
  };

  switch (phase.kind) {
    case "done":
      return (
        <div className="row" role="status">
          <span className="gain small">
            COMMITTED{phase.url ? <> · <a href={phase.url} target="_blank" rel="noopener noreferrer">VIEW COMMIT ↗</a></> : " (nothing needed changing)"}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>CLOSE</button>
        </div>
      );
    case "committing":
      return <span className="accent small">COMMITTING…</span>;
    case "review": {
      const { plan, remote, notice } = phase;
      const none = plan.files.length === 0;
      return (
        <div className="commit-review" role="group" aria-label="Commit preview">
          {notice && <div className="half small">{notice}</div>}
          <div><span className="label small">COMMIT PREVIEW</span> against {record.repo} main @ <code>{remote.state.headSha.slice(0, 7)}</code></div>
          <div className="muted">config.json: balances.{account}{none ? " (unchanged)" : ""}</div>
          <div className="muted small">Message: <code>{plan.message}</code></div>
          <div className="row">
            <button type="button" className="btn primary" disabled={none} onClick={() => commit(phase)}>CONFIRM COMMIT</button>
            <button type="button" className="btn" onClick={() => setPhase({ kind: "edit" })}>BACK</button>
            {none && <span className="dim small">Nothing to change: trade-history already has this.</span>}
          </div>
        </div>
      );
    }
    default: {
      const reading = phase.kind === "reading";
      return (
        <>
          <div className="row">
            <button type="button" className="btn primary" disabled={reading} onClick={() => void review()}>{reading ? "READING…" : "COMMIT…"}</button>
            <button type="button" className="btn ghost" disabled={reading} onClick={onClose}>CANCEL</button>
          </div>
          {phase.kind === "edit" && phase.error && <div className="loss small">{phase.error}</div>}
        </>
      );
    }
  }
}
