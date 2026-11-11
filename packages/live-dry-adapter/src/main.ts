/**
 * Production entry of the separately launched live-dry adapter. It always uses the system
 * transport (operating-system DNS, default trusted CA store); the `test` field of the start
 * message is ignored here. Launch it with launch.ts, which passes a sanitized environment.
 */
import { systemTransport } from './egress.ts';
import { runAdapterProcess } from './process.ts';

runAdapterProcess({ transportFor: () => systemTransport() });
