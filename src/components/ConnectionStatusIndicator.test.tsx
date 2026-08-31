/**
 * Unit tests for the `ConnectionStatusIndicator` component (Task 15.4).
 *
 * A purely presentational component, so these tests need no mocking. They
 * verify the reconnect UX the reliability requirements mandate:
 *   (a) `connected` renders only a visually-hidden (sr-only) status region and
 *       NO refresh button (Req 24.5);
 *   (b) `reconnecting` renders a polite message and an ENABLED Refresh button;
 *       clicking it calls `onRefresh` (Req 23.5, 23.6);
 *   (c) `error` renders an assertive alert and an ENABLED Refresh button;
 *       clicking it calls `onRefresh` (Req 23.7 — manual refresh stays enabled).
 *
 * Requirements: 23.5, 23.6, 23.7, 26.1.
 * Design: Components (`ConnectionStatusIndicator`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectionStatusIndicator } from './ConnectionStatusIndicator';

describe('ConnectionStatusIndicator', () => {
  it('renders only an sr-only status and no refresh button when connected (Req 24.5)', () => {
    render(
      <ConnectionStatusIndicator status="connected" onRefresh={vi.fn()} />,
    );

    const status = screen.getByTestId('connection-status-connected');
    expect(status).toBeInTheDocument();
    expect(status).toHaveClass('sr-only');
    expect(status).toHaveTextContent(/connected to live updates/i);

    // No degraded surface / refresh affordance while healthy.
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });

  it('shows a polite message and an ENABLED refresh button while reconnecting; clicking it calls onRefresh (Req 23.5)', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(
      <ConnectionStatusIndicator status="reconnecting" onRefresh={onRefresh} />,
    );

    // Reconnecting is announced politely (role="status").
    const region = screen.getByTestId('connection-status-reconnecting');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent(/reconnecting/i);

    const refresh = screen.getByRole('button', {
      name: /refresh live updates now/i,
    });
    expect(refresh).toBeEnabled();

    await user.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows an assertive alert and an ENABLED refresh button in the error state; clicking it calls onRefresh (Req 23.7)', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(<ConnectionStatusIndicator status="error" onRefresh={onRefresh} />);

    // Terminal error is announced assertively (role="alert").
    const region = screen.getByTestId('connection-status-error');
    expect(region).toHaveAttribute('role', 'alert');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveTextContent(/unavailable/i);

    // Manual refresh MUST remain enabled once automatic retries stop.
    const refresh = screen.getByRole('button', {
      name: /refresh live updates now/i,
    });
    expect(refresh).toBeEnabled();

    await user.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
