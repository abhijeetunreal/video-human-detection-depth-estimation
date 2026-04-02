import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Actions sets BASE_PATH for Project Pages (e.g. /repo-name/). Local dev uses "/".
  base: process.env.BASE_PATH ?? "/",
  build: {
    target: "esnext",
  },
});
