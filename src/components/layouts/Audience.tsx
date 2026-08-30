import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

/**
 * Audience layout — mobile-first, anonymous shell for the join screen and
 * event view. Uses the global `.app-container` so content reflows without
 * horizontal scroll from 320–768px (Req 24.1).
 *
 * Design ref: Frontend Design → Route map (Audience routes: `/join/:eventRef`,
 * `/e/:eventRef`). Routing skeleton only (task 1.3).
 */
export function Audience({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="app-container py-6">
      <main>{children ?? <Outlet />}</main>
    </div>
  );
}

export default Audience;
