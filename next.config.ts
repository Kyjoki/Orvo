import type { NextConfig } from 'next';
import { withEve } from 'eve/next';

const config: NextConfig = { poweredByHeader: false, serverExternalPackages:['@electric-sql/pglite','better-auth','kysely','pg','pdf-parse'] };
export default withEve(config);
