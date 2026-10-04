// An in-memory GitHub REST API for the Git Data endpoints the app uses, as a
// fetch function. Synthetic data only.
import { fromBase64, toBase64 } from "../src/core/crypto";
import { bytesOf, gitBlobSha } from "../src/core/history/files";

// Built at runtime so no token-shaped literal is ever committed (secret scanning).
export const TOKEN = ["github", "pat", "fake-test-token-not-real"].join("_");

export interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

interface Commit {
  tree: string;
  parents: string[];
  message: string;
  date: string;
}

export interface FakeOptions {
  owner?: string;
  repo?: string;
  /** Token permissions on the data repo. */
  read?: boolean;
  write?: boolean;
  /** Actions write on the app repo. */
  actions?: boolean;
  /** Runs before each ref update, e.g. to simulate someone else pushing first. */
  beforePatch?: (fake: FakeGitHub) => void;
}

let counter = 0;

export class FakeGitHub {
  readonly calls: Call[] = [];
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, Commit>();
  head = "";
  readonly owner: string;
  readonly repo: string;
  readonly opts: FakeOptions;

  constructor(files: Record<string, string | Uint8Array>, opts: FakeOptions = {}) {
    this.opts = opts;
    this.owner = opts.owner ?? "tester";
    this.repo = opts.repo ?? "history-sandbox";
    this.head = this.makeCommit(this.makeTree(new Map(), files), [], "initial");
  }

  makeTree(base: Map<string, string>, files: Record<string, string | Uint8Array>): string {
    const tree = new Map(base);
    for (const [path, content] of Object.entries(files)) {
      const bytes = bytesOf(content);
      const sha = gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      tree.set(path, sha);
    }
    const sha = `tree${++counter}`.padEnd(40, "0");
    this.trees.set(sha, tree);
    return sha;
  }

  makeCommit(tree: string, parents: string[], message: string): string {
    const sha = `c${++counter}`.padEnd(40, "0");
    this.commits.set(sha, { tree, parents, message, date: new Date(Date.UTC(2026, 9, 4, 12, 0, counter)).toISOString().replace(".000", "") });
    return sha;
  }

  /** Someone else pushes a commit to main. */
  push(files: Record<string, string | Uint8Array>, message = "other push"): string {
    const base = this.trees.get(this.commits.get(this.head)!.tree)!;
    this.head = this.makeCommit(this.makeTree(base, files), [this.head], message);
    return this.head;
  }

  /** Files on main as text (binary files decoded as UTF-8). */
  files(): Record<string, Uint8Array> {
    const tree = this.trees.get(this.commits.get(this.head)!.tree)!;
    return Object.fromEntries([...tree].map(([p, sha]) => [p, this.blobs.get(sha)!]));
  }

  text(path: string): string | undefined {
    const b = this.files()[path];
    return b && new TextDecoder().decode(b);
  }

  commitCount(): number {
    let n = 0;
    for (let c: string | undefined = this.head; c; c = this.commits.get(c)?.parents[0]) n++;
    return n;
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method: init.method ?? "GET", url, auth: headers.get("authorization"), body });
    const u = new URL(url);
    if (u.origin !== "https://api.github.com") throw new TypeError("fake: unexpected host");
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return json(401, { message: "Bad credentials" });
    const method = init.method ?? "GET";
    const dataBase = `/repos/${this.owner}/${this.repo}`;
    const p = u.pathname;

    const m = /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/dispatches$/.exec(p);
    if (m && method === "POST") {
      if (!this.opts.actions) return json(403, { message: "Resource not accessible by personal access token" });
      if (body.ref !== "main") return json(422, { message: `No ref found for: ${body.ref}` });
      return new Response(null, { status: 204 });
    }
    if (!p.startsWith(`${dataBase}/`)) return json(404, { message: "Not Found" });
    if (this.opts.read === false) return json(404, { message: "Not Found" });
    const rest = p.slice(dataBase.length);
    const write = method !== "GET";
    if (write && this.opts.write === false) return json(403, { message: "Resource not accessible by personal access token" });

    let r: RegExpExecArray | null;
    if (method === "GET" && rest === "/git/ref/heads/main") return json(200, { object: { sha: this.head } });
    if (method === "GET" && (r = /^\/git\/commits\/(\w+)$/.exec(rest))) {
      const c = this.commits.get(r[1]!);
      return c ? json(200, { sha: r[1], tree: { sha: c.tree }, committer: { date: c.date } }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (r = /^\/git\/trees\/(\w+)$/.exec(rest))) {
      const t = this.trees.get(r[1]!);
      if (!t) return json(404, { message: "Not Found" });
      const dirs = new Set([...t.keys()].flatMap((path) => path.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
      return json(200, {
        sha: r[1],
        truncated: false,
        tree: [...[...dirs].map((d) => ({ path: d, type: "tree", sha: "0".repeat(40) })), ...[...t].map(([path, sha]) => ({ path, type: "blob", mode: "100644", sha }))],
      });
    }
    if (method === "GET" && (r = /^\/git\/blobs\/(\w+)$/.exec(rest))) {
      const b = this.blobs.get(r[1]!);
      // GitHub wraps base64 at 60 columns.
      return b ? json(200, { sha: r[1], encoding: "base64", content: toBase64(b).replace(/.{60}/g, "$&\n") }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const bytes = body.encoding === "base64" ? fromBase64(body.content) : bytesOf(body.content);
      const sha = gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      return json(201, { sha });
    }
    if (method === "POST" && rest === "/git/trees") {
      const base = this.trees.get(body.base_tree);
      if (!base) return json(422, { message: "base_tree not found" });
      const tree = new Map(base);
      for (const e of body.tree as Array<{ path: string; sha: string }>) {
        if (!this.blobs.has(e.sha)) return json(422, { message: "blob not found" });
        tree.set(e.path, e.sha);
      }
      const sha = `tree${++counter}`.padEnd(40, "0");
      this.trees.set(sha, tree);
      return json(201, { sha });
    }
    if (method === "POST" && rest === "/git/commits") {
      const sha = this.makeCommit(body.tree, body.parents, body.message);
      const c = this.commits.get(sha)!;
      return json(201, { sha, html_url: `https://github.com/${this.owner}/${this.repo}/commit/${sha}`, committer: { date: c.date } });
    }
    if (method === "PATCH" && rest === "/git/refs/heads/main") {
      this.opts.beforePatch?.(this);
      const c = this.commits.get(body.sha);
      if (!c) return json(422, { message: "Object does not exist" });
      if (!body.force && c.parents[0] !== this.head) return json(422, { message: "Update is not a fast forward" });
      this.head = body.sha;
      return json(200, { object: { sha: body.sha } });
    }
    return json(404, { message: "Not Found" });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "github-authentication-token-expiration": "2027-01-01 00:00:00 UTC" },
  });
}
