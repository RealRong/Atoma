import { index, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('docs/*', 'docs/page.tsx'),
  route('api/search', 'docs/search.ts'),
  route('api/ops', 'routes/api.ops.ts'),
  route('api/subscribe', 'routes/api.subscribe.ts'),
  route('api/demos/batch/ops', 'routes/api.demos.batch.ops.ts'),
  route('api/demos/relations/ops', 'routes/api.demos.relations.ops.ts'),
  route('sw.ts', 'routes/sw_ts.ts'),
  route('sw.js', 'routes/sw_js.ts'),
] satisfies RouteConfig;
