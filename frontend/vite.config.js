import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        configure(proxy) {
          proxy.on("proxyRes", (proxyRes) => {
            const type = String(proxyRes.headers["content-type"] || "");
            if (type.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
              delete proxyRes.headers["content-length"];
            }
          });
        },
      },
    },
  },
});
