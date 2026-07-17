import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  base: "/react/",
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(rootDir, "src"),
    },
  },
  build: {
    outDir: resolve(rootDir, "../../src/mo_speech/web/react"),
    emptyOutDir: true,
    license: {
      fileName: "assets/licenses.md",
    },
    rolldownOptions: {
      input: {
        appStyles: resolve(rootDir, "app-styles.html"),
        portal: resolve(rootDir, "portal.html"),
        privacy: resolve(rootDir, "privacy.html"),
        speakloop: resolve(rootDir, "speakloop.html"),
        skitvoice: resolve(rootDir, "skitvoice.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
        postBanner: "/* Bundled dependency licenses: /react/assets/licenses.md */",
      },
    },
  },
});
