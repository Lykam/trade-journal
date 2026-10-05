// npm run pages-guard  (build-deploy.yml, before any private data is checked out)
//
// lykam.github.io is one origin for every project Pages site of the account,
// and the owner's browser keeps the site key and the sealed GitHub token in
// that origin's localStorage. So no code may be served there that isn't built
// from this repo: fail the deploy if any other repo of the owner has GitHub
// Pages enabled (SPEC §8, Q48). Reads the public repo list; a token, when set,
// only raises the rate limit.
import { resolve } from "node:path";
import { PublicError, runMain } from "./public-log";

export const OWNER = "Lykam";
export const SELF = "trade-journal";

interface RepoInfo {
  name: string;
  has_pages?: boolean;
}

/** Repos other than this one that publish a Pages site. */
export function otherPagesRepos(repos: RepoInfo[], self = SELF): string[] {
  return repos.filter((r) => r.has_pages && r.name.toLowerCase() !== self.toLowerCase()).map((r) => r.name).sort();
}

export async function listRepos(fetchFn: typeof fetch = fetch, token = process.env.GITHUB_TOKEN): Promise<RepoInfo[]> {
  const all: RepoInfo[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchFn(`https://api.github.com/users/${OWNER}/repos?per_page=100&page=${page}&type=owner`, {
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new PublicError(`GitHub API answered ${res.status} for the repo list`);
    const batch = (await res.json()) as RepoInfo[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  return all;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("pages-guard", async () => {
    const others = otherPagesRepos(await listRepos());
    if (others.length) {
      // Public repo names only: the API lists public repos to anyone.
      console.error(`pages-guard: GitHub Pages is enabled on ${others.join(", ")}; it would share ${OWNER.toLowerCase()}.github.io with this site (SPEC §8)`);
      return 1;
    }
    console.log(`pages-guard: no other ${OWNER} repo serves GitHub Pages`);
    return 0;
  });
}
