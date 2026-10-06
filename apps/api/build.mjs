import { build } from "esbuild";
await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server.js",
  external: ["fastify", "@fastify/*", "pg", "zod"],
  sourcemap: true,
});
