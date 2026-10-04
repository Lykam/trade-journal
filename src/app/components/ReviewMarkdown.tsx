// Renders a Playbook review (SPEC §6.4 Notes, §6.7). Raw HTML is parsed so the
// Finviz <details> block works, then sanitized: scripts, event handlers and the
// template's HTML comments are dropped. Image paths are resolved relative to the
// review file and served from the Playbook.
import { useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { reviewIdOf } from "../../core/reviews/join";
import { resolvePlaybookPath } from "../../core/reviews/images";
import { playbookImageUrl } from "../data";
import { Lightbox, type LightboxImage } from "./Lightbox";

/** Image paths a review embeds, resolved to Playbook-relative paths, in order. */
export function embeddedImages(reviewPath: string, markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img[^>]+src=["']([^"']+)["']/gi)) {
    const p = resolvePlaybookPath(reviewPath, m[1] ?? m[2] ?? "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The template's header block ("**Date:** …" on consecutive lines) is one
 * paragraph in CommonMark; end each field line with a hard break so it reads
 * as a list of fields, the way it looks in the file.
 */
export function withHeaderBreaks(markdown: string): string {
  const field = /^\*\*[^*]+:\*\*/;
  const lines = markdown.split(/\r?\n/);
  return lines.map((l, i) => (field.test(l) && field.test(lines[i + 1] ?? "") ? `${l.trimEnd()}  ` : l)).join("\n");
}

export function ReviewMarkdown({ path, markdown, journalLinks = true }: { path: string; markdown: string; journalLinks?: boolean }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const images = useMemo<LightboxImage[]>(
    () => embeddedImages(path, markdown).flatMap((p) => {
      const src = playbookImageUrl(p);
      return src ? [{ src, caption: p.split("/").pop()! }] : [];
    }),
    [path, markdown],
  );

  const components: Components = {
    img({ src, alt }) {
      const resolved = typeof src === "string" ? resolvePlaybookPath(path, src) : null;
      const url = resolved ? playbookImageUrl(resolved) : null;
      if (!url) return <span className="dim">[image: {alt || "chart"}]</span>;
      const i = images.findIndex((x) => x.src === url);
      return (
        <button type="button" className="md-img" onClick={() => setLightbox(i < 0 ? null : i)} aria-label={`Open ${alt || "image"} full size`}>
          <img src={url} alt={alt ?? ""} loading="lazy" />
        </button>
      );
    },
    a({ href, children }) {
      if (!href) return <>{children}</>;
      if (/^https?:/i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      const target = resolvePlaybookPath(path, href);
      if (journalLinks && target && /^Reviews\/[^/]+\.md$/i.test(target)) return <a href={`#/journal/${encodeURIComponent(reviewIdOf(target))}`}>{children}</a>;
      return <span className="dim">{children}</span>;
    },
  };

  return (
    <div className="md">
      <Markdown rehypePlugins={[rehypeRaw, rehypeSanitize]} components={components}>{withHeaderBreaks(markdown)}</Markdown>
      <Lightbox images={images} index={lightbox} onIndex={setLightbox} />
    </div>
  );
}
