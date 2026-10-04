// Passphrase screen for the encrypted site (SPEC §2 Encryption). The key is
// derived in the browser; only the derived key is kept, in sessionStorage, or
// localStorage with "remember on this device".
import { useEffect, useRef, useState } from "react";
import type { Unlock } from "../data";

export function LockScreen({ notice, unlock }: { notice: string | null; unlock: Unlock }) {
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // After a wrong passphrase, select it so typing replaces it.
  useEffect(() => {
    if (error && !busy) {
      input.current?.focus();
      input.current?.select();
    }
  }, [error, busy]);

  const open = async (p: string) => {
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    const err = await unlock(p, remember);
    // On success the app re-renders unlocked and this component unmounts.
    if (err) {
      setError(err);
      setBusy(false);
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void open(passphrase);
  };
  // Demo build only (npm run preview:demo); null, and the button compiled away, in every real build.
  const demo = __TJ_DEMO_PASSPHRASE__;

  return (
    <main className="lock">
      <form className="panel lock-box" onSubmit={submit} aria-label="Unlock">
        <div className="lock-brand">TRADE/JRNL</div>
        <h1>LOCKED</h1>
        <p className="muted small">The journal data on this site is encrypted. Enter the site passphrase to decrypt it in this browser.</p>
        {notice && <p className="half small" role="status">{notice}</p>}
        <label className="lock-field">
          <span className="label">PASSPHRASE</span>
          <input
            ref={input}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "lock-error" : undefined}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
          <span>Remember on this device</span>
        </label>
        <p className="dim small">
          {remember
            ? "The derived key is kept in this browser until you press LOCK. Only use this on your own device."
            : "The derived key is kept for this tab only and is gone when you close it."}
        </p>
        {error && <p id="lock-error" className="loss b" role="alert">{error}</p>}
        <button type="submit" className="btn primary lock-btn" disabled={!passphrase || busy}>
          {busy ? "DERIVING KEY…" : "UNLOCK"}
        </button>
        {demo && (
          <>
            <button type="button" className="btn lock-btn" disabled={busy} onClick={() => void open(demo)}>OPEN DEMO</button>
            <p className="dim small">Demo build: synthetic fixture data, unlocked with the public demo passphrase.</p>
          </>
        )}
      </form>
    </main>
  );
}
