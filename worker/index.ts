import { handle } from './handler.cjs';
import manifest from '../remote/manifest.json';
import { handleRelease } from './releases.cjs';
import { handleMirror, syncMirror } from './mirror.cjs';
export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/mirror/')) return handleMirror(request, env);
    if (path.startsWith('/config/')) return handle(request, manifest);
    return handleRelease(request, env.APP_RELEASES);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(syncMirror(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
