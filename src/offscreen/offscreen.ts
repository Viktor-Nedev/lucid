/**
 * STUB - offscreen document, owned by the Voice worker (Phase 7).
 *
 * Exists now so that adding voice does not require touching the manifest or
 * the build script, both of which are shared files. The "offscreen" permission
 * is already declared and this document is already built and copied to
 * dist/offscreen.html.
 *
 * What goes here: getUserMedia and speech recognition. A content script cannot
 * hold a durable microphone grant and the service worker has no DOM to ask
 * for one, so this hidden page does it and messages results back through the
 * normal router in shared/messages.ts.
 *
 * Add a route to TabRoutes or a new offscreen route table rather than
 * inventing a private message shape - the contract exists so that every
 * message in the extension is typed the same way.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('offscreen');

log.debug('offscreen document loaded (stub)');
