import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// La página (puerto 5173) reenvía las peticiones al servidor Express (puerto 3001)
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      "/listen": { target: "ws://localhost:3001", ws: true },
    },
  },
});
