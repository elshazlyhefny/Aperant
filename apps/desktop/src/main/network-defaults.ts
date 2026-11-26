/**
 * zeenha fork: give each outbound TCP connection attempt more time.
 *
 * Node's fetch tries every resolved address (IPv6 and IPv4) in turn and
 * abandons each one after `autoSelectFamilyAttemptTimeout`, 250 ms by default.
 * On a slow link (connects of 400 ms or more) or with broken IPv6, every
 * attempt is abandoned and fetch fails with an AggregateError whose message is
 * empty. The AI SDK then reports "Cannot connect to API: " even though the
 * endpoint is reachable. Raising the limit keeps happy-eyeballs fallback while
 * letting slow connects finish.
 *
 * Each worker thread has its own `net` module, so worker entry points must
 * import this module too.
 */
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

export const CONNECT_ATTEMPT_TIMEOUT_MS = 2000;

setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
