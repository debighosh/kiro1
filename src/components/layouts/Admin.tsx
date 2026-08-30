import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

/**
 * Admin layout — shell for the authenticated administrator area (dashboard,
 * event editor, etc.). This is the visual/structural shell only; no auth logic
 * lives here. The `RequireAuth` protected-route wrapper is added in task 6.x
 * (design: Frontend Design → Protected-route strategy).
 *
 * Design ref: Frontend Design → Route map (Admin routes: `/admin`,
 * `/admin/events/:id`). Routing skeleton only (task 1.3).
 */
export function Admin({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="app-container py-6">
      <main>{children ?? <Outlet />}</main>
    </div>
  );
}

export default Admin;
