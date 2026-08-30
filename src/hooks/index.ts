/**
 * Reusable React hooks live here.
 *
 * The hook catalogue is populated as features are built; this barrel keeps
 * imports tidy (e.g. `import { useRealtimeChannel } from '../hooks'`).
 */
export {
  useRealtimeChannel,
  backoffDelayMs,
  INTERRUPTION_GRACE_MS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MAX_ATTEMPTS,
} from './useRealtimeChannel';
export type {
  RealtimeStatus,
  UseRealtimeChannelInput,
  UseRealtimeChannelResult,
} from './useRealtimeChannel';
