import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Public, Audience, Admin, Presenter } from './components/layouts';
import { RequireAuth } from './components/RequireAuth';
import {
  PublicLanding,
  JoinScreen,
  EventView,
  AdminLogin,
  AdminDashboard,
  AdminEventEditor,
  ModerationQueue,
  AiSettings,
  AiSummary,
  PresenterView,
  NotFound,
} from './routes';

/**
 * Root application component — top-level route skeleton (task 1.3).
 *
 * Registers the role-specific layouts and placeholder route screens using
 * BrowserRouter + Routes. This is the routing skeleton only: no auth,
 * protected routes, or feature logic (those arrive in tasks 6.x/8.x).
 *
 * All `/admin/*` routes except `/admin/login` are protected by `RequireAuth`
 * (task 6.3): a parent route renders `<RequireAuth>` wrapping the `Admin`
 * layout, and the dashboard/event-editor routes nest beneath it as children.
 * Unauthenticated visitors are redirected to `/admin/login` and see none of the
 * protected content (Req 25.8); authenticated admins reach every admin route
 * (Req 25.9). `/admin/login` stays OUTSIDE the guard so it is publicly reachable.
 *
 * NOTE: this UI route protection is DEFENCE-IN-DEPTH ONLY. The authoritative
 * checks are server-side — Edge Functions verify the JWT and RLS denies
 * unauthorised rows (Req 10.1, 21.6); the client never trusts its own guard.
 *
 * Design ref: Frontend Design → Route map + role-specific layouts +
 * Protected-route strategy.
 * Requirements traceability: 25.1 (audience join + event-view routes),
 * 25.4 (admin routes: login, dashboard, event editor), 25.5 (presenter view),
 * 10.1 / 25.8 / 25.9 (admin route protection).
 */
function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public landing (Req 2.1). */}
        <Route
          path="/"
          element={
            <Public>
              <PublicLanding />
            </Public>
          }
        />

        {/* Audience — mobile-first, anonymous (Req 25.1). */}
        <Route
          path="/join/:eventRef"
          element={
            <Audience>
              <JoinScreen />
            </Audience>
          }
        />
        <Route
          path="/e/:eventRef"
          element={
            <Audience>
              <EventView />
            </Audience>
          }
        />

        {/* Admin — bare login placeholder, OUTSIDE the auth guard so it is
            publicly reachable (Req 25.4, 25.8). */}
        <Route path="/admin/login" element={<AdminLogin />} />

        {/* Admin — authenticated area. `RequireAuth` guards every admin route
            except `/admin/login`; the Admin layout renders inside the guard via
            <Outlet/>, and the dashboard/event-editor routes nest as children
            (Req 10.1, 25.8, 25.9). UI protection is defence-in-depth only. */}
        <Route
          element={
            <RequireAuth>
              <Admin />
            </RequireAuth>
          }
        >
          <Route path="/admin" element={<AdminDashboard />} />
          {/* AI provider settings/config (task 34.1). Admin-only, inside the
              RequireAuth-guarded block. */}
          <Route path="/admin/ai-settings" element={<AiSettings />} />
          {/* Event editor: `/admin/events/new` is CREATE mode; an existing id
              is (minimal) EDIT mode. The `new` route is registered explicitly
              for clarity, and `:id` still matches it as a fallback (task 8.1). */}
          <Route path="/admin/events/new" element={<AdminEventEditor />} />
          {/* Moderation queue (task 16.2). Registered before the `:id` editor
              so the more specific `/moderation` path is unambiguous; React
              Router v6 ranks by specificity so order is not strictly required,
              but it stays inside the RequireAuth-guarded admin block. */}
          <Route
            path="/admin/events/:id/moderation"
            element={<ModerationQueue />}
          />
          {/* End-of-event summary (task 34.4). Admin-only, inside the
              RequireAuth-guarded block; the more specific `/summary` path is
              registered before the `:id` editor for clarity. */}
          <Route path="/admin/events/:id/summary" element={<AiSummary />} />
          <Route path="/admin/events/:id" element={<AdminEventEditor />} />
        </Route>

        {/* Presenter — 16:9 high-contrast shell (Req 25.5). */}
        <Route
          path="/present/:eventRef"
          element={
            <Presenter>
              <PresenterView />
            </Presenter>
          }
        />

        {/* Catch-all 404. */}
        <Route
          path="*"
          element={
            <Public>
              <NotFound />
            </Public>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
