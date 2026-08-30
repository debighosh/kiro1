import { useEffect, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';

/**
 * `QrDisplay` — renders a QR code (as SVG) that resolves to a given URL, used
 * on the audience join screen and on the presenter join screen (task 8.3).
 *
 * Behaviour (Design → Components and Interfaces → QrDisplay: "Render QR (SVG)
 * resolving to audience URL"; Technology Stack → qrcode):
 *  - The `value` prop (typically the event's audience/join URL) is encoded as
 *    QR *data* using the `qrcode` library's SVG renderer. SVG is chosen so the
 *    code stays crisp when scaled up for the projector-optimised presenter
 *    view (Req 7.10) as well as on small mobile screens (Req 1.1).
 *  - `qrcode`'s `toString` is asynchronous, so generation runs inside an effect
 *    and the resulting SVG string is held in state. Until the first successful
 *    generation the component renders an accessible placeholder; if generation
 *    fails it renders an accessible error state (both keep the same
 *    `role="img"` + accessible name so assistive tech always sees a labelled
 *    image region).
 *
 * ── Accessibility (Req 24.5) ─────────────────────────────────────────────────
 * The generated SVG carries no intrinsic accessible name, so the component
 * wraps it in a container with `role="img"` and a non-empty `aria-label`
 * (defaulting to a descriptive label). This guarantees the QR always exposes a
 * non-empty accessible name to assistive technology.
 *
 * ── Security note ────────────────────────────────────────────────────────────
 * The SVG injected via `dangerouslySetInnerHTML` comes SOLELY from the trusted
 * `qrcode` library — never from user-supplied HTML. The `value` is treated as
 * QR *data* to be encoded, not as markup to render, so there is no XSS vector
 * here even when `value` is attacker-influenced.
 *
 * Requirements traceability: 1.1 (QR resolves to the correct audience URL),
 * 7.10 (presenter join QR), 24.5 (non-empty accessible name).
 * Design: Components and Interfaces (QrDisplay); Technology Stack (qrcode).
 */

/** Error-correction levels supported by the `qrcode` library. */
export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrDisplayProps {
  /** The URL (or arbitrary text) to encode as QR data. Required. */
  readonly value: string;
  /**
   * Accessible name for the rendered QR image. Exposed as `aria-label` on the
   * `role="img"` container. Defaults to a descriptive label so the QR always
   * has a non-empty accessible name (Req 24.5).
   */
  readonly title?: string;
  /**
   * Optional fixed pixel size. When provided, the QR renders at exactly this
   * width/height. When omitted, it scales fluidly (width 100% up to a sensible
   * max) so it works one-handed on mobile yet can fill the presenter screen.
   */
  readonly size?: number;
  /**
   * Maximum rendered width (px) when `size` is not provided. Defaults to 320,
   * a comfortable size on mobile that still scales up crisply as SVG.
   */
  readonly maxWidth?: number;
  /** QR error-correction level. Defaults to `'M'` (a balanced default). */
  readonly errorCorrectionLevel?: QrErrorCorrectionLevel;
  /** Optional extra class names applied to the container. */
  readonly className?: string;
}

const DEFAULT_TITLE = 'QR code linking to the event';
const DEFAULT_MAX_WIDTH = 320;

export function QrDisplay({
  value,
  title = DEFAULT_TITLE,
  size,
  maxWidth = DEFAULT_MAX_WIDTH,
  errorCorrectionLevel = 'M',
  className,
}: QrDisplayProps): JSX.Element {
  // 'pending' until the first generation resolves; the SVG markup once ready;
  // null when the most recent generation failed.
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<'pending' | 'ready' | 'error'>(
    'pending',
  );

  useEffect(() => {
    // Guards against applying a stale result if `value`/options change (or the
    // component unmounts) before an in-flight generation resolves.
    let cancelled = false;

    setStatus('pending');

    QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel,
      margin: 1,
      // `width` gives the intrinsic SVG size; the container still controls the
      // final rendered dimensions responsively.
      width: size ?? maxWidth,
    })
      .then((generated) => {
        if (cancelled) return;
        setSvg(generated);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setSvg(null);
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [value, size, maxWidth, errorCorrectionLevel]);

  // Sizing: fixed square when `size` is given, otherwise fluid up to `maxWidth`.
  const style: CSSProperties = size
    ? { width: size, height: size }
    : { width: '100%', maxWidth };

  const containerClassName = ['qr-display', className]
    .filter(Boolean)
    .join(' ');

  // The container always exposes role="img" + a non-empty accessible name, in
  // every state (pending / ready / error), so assistive tech consistently sees
  // a labelled image region (Req 24.5).
  if (status === 'ready' && svg) {
    return (
      <div
        role="img"
        aria-label={title}
        className={containerClassName}
        style={style}
        // SVG originates SOLELY from the trusted `qrcode` library (never from
        // user HTML); `value` is QR data, not markup — no XSS vector.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  if (status === 'error') {
    return (
      <div
        role="img"
        aria-label={title}
        className={containerClassName}
        style={style}
      >
        <span role="alert">Unable to generate QR code.</span>
      </div>
    );
  }

  // Pending: accessible placeholder while the async generation resolves.
  return (
    <div
      role="img"
      aria-label={title}
      aria-busy="true"
      className={containerClassName}
      style={style}
    >
      <span className="sr-only">Generating QR code…</span>
    </div>
  );
}

export default QrDisplay;
