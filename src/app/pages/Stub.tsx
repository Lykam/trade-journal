/** Shown for an unknown route. */
export function Stub({ title }: { title: string }) {
  return (
    <main className="page">
      <header className="page-head"><h1>{title}</h1></header>
      <div className="panel empty">
        No page here. <a href="#/">Back to the dashboard</a>
      </div>
    </main>
  );
}
