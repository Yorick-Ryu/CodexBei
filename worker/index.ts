import { handle } from './handler.cjs';
import manifest from '../remote/manifest.json';
import release from '../remote/app-release.json';
import { handleUpdate } from './updates.cjs';
export default {
  fetch(request) {
    return new URL(request.url).pathname.startsWith('/updates/')
      ? handleUpdate(request, release) : handle(request, manifest);
  },
} satisfies ExportedHandler<Env>;
