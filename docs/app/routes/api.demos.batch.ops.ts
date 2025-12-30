import type { Route } from './+types/api.demos.batch.ops';
import { getBatchDemoHandlers } from '@/lib/batch-demo.server';

export async function loader() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  const handlers = await getBatchDemoHandlers();
  return handlers.ops(request);
}

