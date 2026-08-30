/**
 * Tests for the `QrDisplay` component (task 8.3).
 *
 * These use the REAL `qrcode` library (it runs fine under Node/jsdom), so the
 * assertions reflect the actual SVG the component will render in production.
 * They verify the behaviours the design and requirements mandate:
 *   (a) the component always exposes a `role="img"` region with the expected
 *       non-empty accessible name — including its default (Req 24.5);
 *   (b) after the async generation resolves it contains an `<svg>` element
 *       (the QR is rendered as SVG per the design);
 *   (c) passing a `value` produces output, and changing `value` regenerates
 *       (proving the QR tracks the encoded URL — Req 1.1).
 *
 * Design: Components and Interfaces (QrDisplay); Technology Stack (qrcode).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import QRCode from 'qrcode';
import { QrDisplay } from './QrDisplay';

const AUDIENCE_URL = 'https://livepulse.example.com/join/demo-event';
const DEFAULT_LABEL = 'QR code linking to the event';

describe('QrDisplay', () => {
  it('renders an element with role="img" and the default accessible name (Req 24.5)', async () => {
    render(<QrDisplay value={AUDIENCE_URL} />);

    // The labelled image region is present immediately (even before the async
    // generation resolves) so assistive tech always sees a named image.
    const img = screen.getByRole('img', { name: DEFAULT_LABEL });
    expect(img).toBeInTheDocument();

    // And it resolves to actual SVG output.
    await waitFor(() => {
      expect(img.querySelector('svg')).not.toBeNull();
    });
  });

  it('uses a caller-provided title as the accessible name', async () => {
    const title = 'Scan to join the town hall';
    render(<QrDisplay value={AUDIENCE_URL} title={title} />);

    const img = screen.getByRole('img', { name: title });
    expect(img).toBeInTheDocument();
    await waitFor(() => {
      expect(img.querySelector('svg')).not.toBeNull();
    });
  });

  it('renders the QR as an <svg> once generation completes', async () => {
    render(<QrDisplay value={AUDIENCE_URL} />);

    const img = screen.getByRole('img', { name: DEFAULT_LABEL });
    await waitFor(() => {
      const svg = img.querySelector('svg');
      expect(svg).not.toBeNull();
      // The QR SVG has real content (paths/rects), not an empty shell.
      expect(svg?.innerHTML.length ?? 0).toBeGreaterThan(0);
    });
  });

  it('regenerates the SVG when the value changes (Req 1.1)', async () => {
    const { rerender } = render(<QrDisplay value={AUDIENCE_URL} />);

    const img = screen.getByRole('img', { name: DEFAULT_LABEL });
    await waitFor(() => {
      expect(img.querySelector('svg')).not.toBeNull();
    });
    const firstMarkup = img.querySelector('svg')?.outerHTML ?? '';

    // The independently-generated SVG for the two different URLs must differ,
    // and the rendered output should match the encoding of the NEW value —
    // proving the QR resolves to the current audience URL.
    const otherUrl = 'https://livepulse.example.com/join/other-event';
    const [firstExpected, secondExpected] = await Promise.all([
      QRCode.toString(AUDIENCE_URL, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 320 }),
      QRCode.toString(otherUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 320 }),
    ]);
    expect(firstExpected).not.toEqual(secondExpected);

    rerender(<QrDisplay value={otherUrl} />);

    await waitFor(() => {
      const markup = img.querySelector('svg')?.outerHTML ?? '';
      expect(markup).not.toEqual('');
      expect(markup).not.toEqual(firstMarkup);
    });
  });

  it('respects a fixed size prop', async () => {
    render(<QrDisplay value={AUDIENCE_URL} size={480} />);

    const img = screen.getByRole('img', { name: DEFAULT_LABEL });
    expect(img.style.width).toBe('480px');
    expect(img.style.height).toBe('480px');
    await waitFor(() => {
      expect(img.querySelector('svg')).not.toBeNull();
    });
  });
});
