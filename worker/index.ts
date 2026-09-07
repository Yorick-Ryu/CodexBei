import { handle } from './handler.cjs';
import manifest from '../remote/manifest.json';
export default {
  fetch(request) { return handle(request, manifest); },
} satisfies ExportedHandler<Env>;
