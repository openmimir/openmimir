import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = `http://localhost:${process.env.MIMIR_PORT ?? 4747}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, ws: true, changeOrigin: true },
      "/pair": { target, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
