import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

/**
 * Public layout — anonymous, general-purpose shell for the landing page and
 * other unauthenticated public entry points.
 *
 * Design ref: Frontend Design → Route map (`/` Public). This is the routing
 * skeleton only (task 1.3); content screens arrive in later tasks.
 */
export function Public({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="app-container py-6">
      <main>{children ?? <Outlet />}</main>
    </div>
  );
}

export default Public;
