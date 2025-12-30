import type { Route } from './+types/api.subscribe';
import { getTodosDemoHandlers } from '@/lib/todos-demo.server';

export async function action() {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function loader({ request }: Route.LoaderArgs) {
  const handlers = await getTodosDemoHandlers();
  return handlers.subscribe(request);
}

