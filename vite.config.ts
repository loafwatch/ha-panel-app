import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;

// Builds one self-contained ES module that Home Assistant loads as a custom panel.
export default defineConfig({
  define: { __HPA_VERSION__: JSON.stringify(version), __HPA_TAG__: JSON.stringify("HPA_VERSION=" + version) },
  build: {
    lib: {
      entry: "src/ha-panel-app.ts",
      formats: ["es"],
      fileName: () => "ha-panel-app.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
    minify: "esbuild",
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
