import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

/**
 * Presenter layout — projector-optimised shell (16:9, high-contrast) for the
 * presenter view. Design calls for ≥24px body text and ≥7:1 contrast (Req 7.1);
 * this skeleton establishes the dark, high-contrast, aspect-constrained shell.
 * Presenter access/token gating is added in a later task.
 *
 * Design ref: Frontend Design → Route map (`/present/:eventRef` Presenter).
 * Routing skeleton only (task 1.3).
 */
export function Presenter({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="min-h-dvh bg-black text-white">
      <div className="mx-auto flex min-h-dvh w-full max-w-[177.78vh] items-center justify-center p-8 text-2xl">
        <main>{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}

export default Presenter;
