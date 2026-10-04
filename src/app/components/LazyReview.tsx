// The markdown stack (react-markdown, rehype-raw, rehype-sanitize) is most of the
// bundle, so it loads only when a review is actually shown.
import { lazy, Suspense } from "react";

const ReviewMarkdown = lazy(() => import("./ReviewMarkdown").then((m) => ({ default: m.ReviewMarkdown })));

export function LazyReview(props: { path: string; markdown: string }) {
  return (
    <Suspense fallback={<div className="muted">LOADING REVIEW…</div>}>
      <ReviewMarkdown {...props} />
    </Suspense>
  );
}
