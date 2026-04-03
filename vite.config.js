import { defineConfig } from "vite";

/**
 * GitHub Project Pages serves at https://<owner>.github.io/<repo>/ — assets need that prefix.
 * Use GITHUB_REPOSITORY in CI only; never rely on a generic BASE_PATH env (can break local dev).
 * Optional override: BASE_PATH=/my/custom/path/ for custom domains or non-standard setups.
 */
function resolveBase() {
  const override = process.env.BASE_PATH;
  if (override) {
    const t = override.trim();
    if (!t || t === "/") return "/";
    return t.endsWith("/") ? t : `${t}/`;
  }
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY) {
    const repo = process.env.GITHUB_REPOSITORY.split("/")[1];
    if (repo) return `/${repo}/`;
  }
  return "/";
}

export default defineConfig({
  base: resolveBase(),
  build: {
    target: "esnext",
  },
});
