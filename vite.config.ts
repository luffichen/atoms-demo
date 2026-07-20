import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      ignored: ["**/workspace/**"]
    },
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true
      }
    }
  },
  build: {
    outDir: "dist/web",
    sourcemap: true
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
      thresholds: {
        statements: 55,
        branches: 65,
        functions: 45,
        lines: 55
      }
    }
  }
});
