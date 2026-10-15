import { defineConfig } from "vite";

export default defineConfig({
  server: {
    headers: {
      // PDFium runs in a web worker; these headers keep SharedArrayBuffer available.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless"
    }
  },
  optimizeDeps: {
    exclude: ["@embedpdf/snippet"]
  }
});
