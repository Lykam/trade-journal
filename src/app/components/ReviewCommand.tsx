// The command that starts a Playbook review (Q72). The playbook-review skill
// lives in the Playbook repo, so `/playbook-review` alone only works in a Claude
// Code session started inside Playbook/; this opens one there with the review
// already asked for. The date is the idea date (the review's file name), which
// also finds an idea that has since closed.
import { useState } from "react";
import { copyText } from "../data";

export const reviewCommand = (ticker: string, ideaDate: string) =>
  `cd ~/GitProjects/Playbook; claude "/playbook-review ${ticker} ${ideaDate}"`;

/** A copy button for `command`: full (button, command, result) or compact (a tiny COPY button). */
export function CopyCommand({ command, label = "COPY", compact = false }: { command: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const copy = async () => setCopied((await copyText(command)) ? "ok" : "fail");
  if (compact) {
    return (
      <button type="button" className="btn tiny" title={command} onClick={copy}>
        {copied === "ok" ? "COPIED" : copied === "fail" ? "COPY BLOCKED" : label}
      </button>
    );
  }
  return (
    <div className="start-review">
      <button type="button" className="btn primary" onClick={copy}>{label}</button>
      <code>{command}</code>
      {copied === "ok" && <span className="gain small">COPIED, paste it into a terminal</span>}
      {copied === "fail" && <span className="half small">Clipboard blocked; copy the command above</span>}
    </div>
  );
}
