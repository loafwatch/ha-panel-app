import { defineConfig } from "vite";

// Builds one self-contained ES module that Home Assistant loads as a custom panel.
export default defineConfig({
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
