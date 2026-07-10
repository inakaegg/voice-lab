import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  base: "/react/",
  build: {
    outDir: resolve(rootDir, "../../src/mo_speech/web/react"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        portal: resolve(rootDir, "portal.html"),
        speakloop: resolve(rootDir, "speakloop.html"),
        skitvoice: resolve(rootDir, "skitvoice.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
