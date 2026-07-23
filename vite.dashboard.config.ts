import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(dir, "src/dashboard-client"),
  base: "/",
  plugins: [react()],
  build: {
    outDir: path.resolve(dir, "src/dashboard-dist"),
    emptyOutDir: true,
    sourcemap: false,
    minify: "esbuild",
    rollupOptions: {
      input: path.resolve(dir, "src/dashboard-client/index.html"),
      output: {
        entryFileNames: "dashboard.js",
        chunkFileNames: "dashboard.js",
        assetFileNames: (info) => {
          if (info.name?.endsWith(".css")) return "dashboard.css";
          return info.name ?? "dashboard.[ext]";
        },
      },
    },
  },
});
