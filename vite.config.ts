import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const entry = (file: string) => fileURLToPath(new URL(file, import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": entry("./src"),
    },
  },

  // Multi-window: one HTML entry per WebView (§5).
  build: {
    rollupOptions: {
      input: {
        recorder: entry("./recorder.html"),
        camera: entry("./camera.html"),
        editor: entry("./editor.html"),
        area: entry("./area.html"),
        frame: entry("./frame.html"),
        annotation: entry("./annotation.html"),
      },
    },
  },

  // Vite options tailored for Tauri development (applied in `tauri dev`/`build`).
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
