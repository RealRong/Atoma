import type { Route } from './+types/api.ops';
import { getTodosDemoHandlers } from '@/lib/todos-demo.server';

export async function loader() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  const handlers = await getTodosDemoHandlers();
  return handlers.ops(request);
}

