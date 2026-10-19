import type { NextConfig } from 'next';
import { withEve } from 'eve/next';
import { securityHeaders } from './src/server/security-headers';

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages:['@electric-sql/pglite','better-auth','kysely','pg','pdf-parse'],
  outputFileTracingIncludes: { '/api/**': ['./migrations/*.sql'] },
  async headers(){return [{source:'/:path*',headers:[...securityHeaders,...(process.env.VERCEL?[{key:'Strict-Transport-Security',value:'max-age=31536000'}]:[])]}];},
};
export default withEve(config);
