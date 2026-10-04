
/** Placeholder for pages that arrive in a later milestone (SPEC §9). */
export function Stub({ title, milestone, params }: { title: string; milestone: number; params?: URLSearchParams }) {
  const filter = params && [...params].map(([k, v]) => `${k}=${v}`).join(" · ");
  return (
    <main className="page">
      <header className="page-head"><h1>{title}</h1></header>
      <div className="panel empty">
        Arrives in milestone {milestone}.{filter ? <> Requested filter: <span className="accent">{filter}</span></> : null}
      </div>
    </main>
  );
}

