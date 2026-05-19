import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["paula.fridgechannels.com"],
    proxy: {
      "/api": { target: "http://127.0.0.1:3737", changeOrigin: true },
    },
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: ["paula.fridgechannels.com"],
  },
});
