import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3737";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["paula.fridgechannels.com"],
    proxy: {
      "/api": { target: apiProxyTarget, changeOrigin: true },
    },
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: ["paula.fridgechannels.com"],
  },
});
