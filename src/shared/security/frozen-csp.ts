export const FROZEN_CSP_TEMPLATE =
  "default-src 'none'; " +
  "script-src 'nonce-<BOOTSTRAP_NONCE>'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data:; " +
  "font-src data:; " +
  "worker-src 'none'; " +
  "connect-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-src 'none'; " +
  "media-src 'none'";
