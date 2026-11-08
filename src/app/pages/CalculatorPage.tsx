// Share-size calculator: how many shares a 1% max-risk / 3% max-capital rule allows,
// in tenths of a share. No trade data needed, so it's reachable even while locked (quick
// phone access) — see the App.tsx route guard.
import { useMemo, useState } from "react";
import { computeSizing } from "../../core/calc/sizing";
import { usePersistedText } from "../data";
import { money, pct } from "../format";

const clamp0 = (n: number) => (n > 0 ? n : 0);

export function CalculatorPage() {
  // Settings-like fields persist across visits; entry/stop are per-calculation and start blank.
  const [account, setAccount] = usePersistedText("tj.calc.account", "");
  const [excludeOn, setExcludeOn] = usePersistedText("tj.calc.excludeOn", "");
  const [excludeAmount, setExcludeAmount] = usePersistedText("tj.calc.excludeAmount", "2000");
  const [riskPct, setRiskPct] = usePersistedText("tj.calc.riskPct", "1");
  const [capPct, setCapPct] = usePersistedText("tj.calc.capPct", "3");
  const [baselineDays, setBaselineDays] = usePersistedText("tj.calc.baselineDays", "");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [recentDays, setRecentDays] = useState("");

  const accountNum = Number(account);
  const effective = clamp0(excludeOn === "1" ? accountNum - Number(excludeAmount || "0") : accountNum);

  const result = useMemo(() => {
    if (!account.trim() || !entry.trim() || !stop.trim()) return null;
    try {
      return {
        value: computeSizing({
          entry: Number(entry),
          stop: Number(stop),
          account: effective,
          riskPct: Number(riskPct) / 100,
          capPct: Number(capPct) / 100,
          recentAvgDaysHeld: Number(recentDays || "0"),
          baselineAvgDaysHeld: Number(baselineDays || "0"),
        }),
        error: null as string | null,
      };
    } catch (e) {
      return { value: null, error: (e as Error).message };
    }
  }, [account, entry, stop, effective, riskPct, capPct, recentDays, baselineDays]);

  return (
    <main className="page">
      <header className="page-head"><h1>SHARE CALCULATOR</h1></header>
      <div className="settings">
        <section className="panel" aria-label="Account">
          <div className="panel-head"><h2>Account</h2></div>
          <div className="body">
            <label className="field">
              <span className="label small">Account size</span>
              <input className="input narrow" inputMode="decimal" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="500" />
            </label>
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={excludeOn === "1"} onChange={(e) => setExcludeOn(e.target.checked ? "1" : "")} />
                <span>Temporarily exclude $</span>
              </label>
              <input
                className="input tiny"
                inputMode="decimal"
                value={excludeAmount}
                onChange={(e) => setExcludeAmount(e.target.value)}
                disabled={excludeOn !== "1"}
                aria-label="Amount to exclude"
              />
            </div>
            <p className="dim small">e.g. extra cash sitting in the account that isn't meant to be risked right now.</p>
            <p className="muted small">Sizing against: <span className="text-2 b">{money(effective, { sign: false })}</span></p>
          </div>
        </section>

        <section className="panel" aria-label="Trade">
          <div className="panel-head"><h2>Trade</h2></div>
          <div className="body">
            <label className="field">
              <span className="label small">Entry price</span>
              <input className="input narrow" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="10.00" />
            </label>
            <label className="field">
              <span className="label small">Stop-loss price</span>
              <input className="input narrow" inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} placeholder="9.50" />
            </label>
          </div>
        </section>

        <section className="panel" aria-label="Limits">
          <div className="panel-head"><h2>Limits</h2></div>
          <div className="body">
            <label className="field">
              <span className="label small">Max risk, % of account</span>
              <input className="input tiny" inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
            </label>
            <label className="field">
              <span className="label small">Max capital, % of account</span>
              <input className="input tiny" inputMode="decimal" value={capPct} onChange={(e) => setCapPct(e.target.value)} />
            </label>
            <p className="dim small">Shares are rounded down to a tenth, so the position never exceeds either limit.</p>
          </div>
        </section>

        <section className="panel" aria-label="Turnover">
          <div className="panel-head"><h2>Turnover</h2></div>
          <div className="body">
            <label className="field">
              <span className="label small">Typical avg days held</span>
              <input className="input tiny" inputMode="decimal" value={baselineDays} onChange={(e) => setBaselineDays(e.target.value)} placeholder="5" />
            </label>
            <label className="field">
              <span className="label small">Recent avg days held</span>
              <input className="input tiny" inputMode="decimal" value={recentDays} onChange={(e) => setRecentDays(e.target.value)} placeholder="2" />
            </label>
            <p className="dim small">
              If your recent trades are closing faster than typical, the market's probably choppier — size down.
              Leave either blank to skip this.
            </p>
          </div>
        </section>

        <section className="panel" aria-label="Result">
          <div className="panel-head"><h2>Result</h2></div>
          <div className="body">
            {!result && <p className="muted">Enter account size, entry and stop to calculate.</p>}
            {result?.error && <p className="loss">{result.error}</p>}
            {result?.value && (() => {
              const r = result.value;
              return (
                <>
                  <p className="calc-shares">{r.shares.toFixed(1)} shares</p>
                  <dl className="kv">
                    <dt>Risk-based max</dt>
                    <dd>{r.sharesByRisk.toFixed(1)} sh (risk {money(r.maxRiskDollars, { sign: false })} ÷ {money(r.riskPerShare, { sign: false })}/sh)</dd>
                    <dt>Capital-based max</dt>
                    <dd>{r.sharesByCapital.toFixed(1)} sh (cap {money(r.maxCapitalDollars, { sign: false })} ÷ {money(Number(entry), { sign: false })}/sh)</dd>
                    <dt>Limited by</dt>
                    <dd>{r.limitedBy === "risk" ? "Risk" : r.limitedBy === "capital" ? "Capital" : "Both (tie)"}</dd>
                    {r.turnoverMultiplier < 1 && (
                      <>
                        <dt>Before turnover</dt>
                        <dd>{r.sharesBeforeTurnover.toFixed(1)} sh</dd>
                        <dt>Turnover adjustment</dt>
                        <dd>&times;{r.turnoverMultiplier.toFixed(2)} (choppier than typical)</dd>
                      </>
                    )}
                    <dt>Position cost</dt>
                    <dd>{money(r.positionCost, { sign: false })} ({pct(r.pctOfAccountUsed, 1)} of account)</dd>
                    <dt>Risk if stopped</dt>
                    <dd>{money(r.actualRisk, { sign: false })} ({pct(r.actualRisk / effective, 1)} of account)</dd>
                  </dl>
                </>
              );
            })()}
          </div>
        </section>
      </div>
    </main>
  );
}
