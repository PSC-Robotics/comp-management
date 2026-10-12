import { fileURLToPath } from 'node:url';

/** Repository `public/` directory, valid from both `src/` (tsx) and `dist/` (compiled) builds. */
export const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
