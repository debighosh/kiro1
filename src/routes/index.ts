/**
 * Route components live here.
 *
 * Placeholder route screens for the Milestone 1 routing skeleton are defined
 * in `./screens`. Feature screens replace these placeholders in later tasks.
 */
export {
  PublicLanding,
  JoinScreen,
  EventView,
  AdminLogin,
  AdminDashboard,
  PresenterView,
  NotFound,
} from './screens';

// The event editor (task 8.1) lives in its own module; re-exported here so
// consumers (App.tsx) keep a single `../routes` import surface.
export { AdminEventEditor } from './AdminEventEditor';

// The moderation queue (task 16.2) likewise lives in its own module and is
// re-exported here for the single `../routes` import surface in App.tsx.
export { ModerationQueue } from './ModerationQueue';

// The AI settings/config screen (task 34.1) lives in its own module and is
// re-exported here for the single `../routes` import surface in App.tsx.
export { AiSettings } from './AiSettings';

// The end-of-event summary screen (task 34.4) lives in its own module and is
// re-exported here for the single `../routes` import surface in App.tsx.
export { AiSummary } from './AiSummary';
