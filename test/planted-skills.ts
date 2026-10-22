import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@agentshouse/skills';
const planted = pathToFileURL(join(process.env.KIT_SKILLS_PACKAGE!, 'dist', 'index.js')).href;

registerHooks({
  resolve: (specifier, context, next) => (specifier === PACKAGE ? { url: planted, shortCircuit: true } : next(specifier, context)),
});
