import { handle } from './handler.cjs';
import manifest from '../remote/manifest.json';
import release from '../remote/app-release.json';
import { handleUpdate } from './updates.cjs';
import { handleMirror, syncMirror } from './mirror.cjs';
export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/updates/')) return handleUpdate(request, release);
    if (path.startsWith('/mirror/')) return handleMirror(request, env);
    return handle(request, manifest);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(syncMirror(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
