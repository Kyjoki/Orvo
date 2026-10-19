export function contentSecurityPolicy(nonce: string, development = false): string {
  if (!/^[A-Za-z0-9+/=_-]{16,100}$/.test(nonce)) throw new Error('Invalid CSP nonce');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    // The office uses React style attributes for positions, avatars and animations.
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://vercel.com/api/blob/ https://blob.vercel-storage.com https://*.private.blob.vercel-storage.com" + (development ? ' ws://localhost:* ws://127.0.0.1:*' : ''),
    "img-src 'self' data: blob:", "font-src 'self'", "object-src 'none'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    "frame-src 'none'", "worker-src 'self' blob:",
  ].join('; ');
}

export const securityHeaders = [
  {key:'X-Content-Type-Options', value:'nosniff'},
  {key:'X-Frame-Options', value:'DENY'},
  {key:'Referrer-Policy', value:'no-referrer'},
  {key:'Permissions-Policy', value:'camera=(), microphone=(), geolocation=(), payment=(), usb=()'},
  {key:'Cross-Origin-Opener-Policy', value:'same-origin'},
  {key:'Cross-Origin-Resource-Policy', value:'same-origin'},
  {key:'X-DNS-Prefetch-Control', value:'off'},
];
