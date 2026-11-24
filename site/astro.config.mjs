import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://aisignals.willbright.link",
  // Directory-style URLs (/editions/2026-W48/) — matches the CloudFront
  // index-rewrite function in the pulumi-static-site component.
  trailingSlash: "always",
  build: { format: "directory" },
});
