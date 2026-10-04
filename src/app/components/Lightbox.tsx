import { useEffect } from "react";

export interface LightboxImage {
  src: string;
  caption: string;
}

/** Full-size image viewer: Esc or the backdrop closes it, arrow keys step through the set. */
export function Lightbox({ images, index, onIndex }: { images: LightboxImage[]; index: number | null; onIndex: (i: number | null) => void }) {
  useEffect(() => {
    if (index === null) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") onIndex(null);
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [index, images.length, onIndex]);
  if (index === null || !images[index]) return null;
  const img = images[index];
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={img.caption} onClick={() => onIndex(null)}>
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="muted">{index + 1} / {images.length} · {img.caption}</span>
        <span className="grow" />
        <button type="button" className="btn" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous image">‹</button>
        <button type="button" className="btn" disabled={index === images.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next image">›</button>
        <button type="button" className="btn primary" onClick={() => onIndex(null)} autoFocus>CLOSE ✕</button>
      </div>
      <img src={img.src} alt={img.caption} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
