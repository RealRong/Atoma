import type { Route } from './+types/api.demos.relations.ops';
import { getRelationsDemoHandlers } from '@/lib/relations-demo.server';

export async function loader() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  const handlers = await getRelationsDemoHandlers();
  return handlers.ops(request);
}

