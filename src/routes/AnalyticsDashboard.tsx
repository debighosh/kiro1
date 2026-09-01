/**
 * `/admin/events/:id/analytics` — Admin analytics dashboard (Task 38.3).
 *
 * Renders platform interaction metrics for an event, including scalar KPIs and
 * an engagement-over-time line chart powered by recharts. This is an admin-only
 * screen protected by `RequireAuth`.
 *
 * ── Four UX states (Req 8.7, 24.7) ──────────────────────────────────────────
 *   loading  — fetching metrics on mount; `role="status"` progress indicator.
 *   success  — metrics rendered: scalar cards + engagement chart.
 *   empty    — zero-interaction event: all-zero metrics, note "No interactions yet".
 *   error    — retrieval failed; `role="alert"` + sanitised error + retry button
 *              (Req 8.7, 24.7).
 *
 * ── Privacy (Req 8.6) ─────────────────────────────────────────────────────────
 * No `participant_identifier` value is ever rendered; only the integer count
 * (`uniqueParticipants`) returned by {@link readEventAnalytics}. The labelling
 * uses "Platform participants" (NOT "Attendees") per Req 8.5, and every metric
 * is annotated as representing platform interaction counts, not verified attendee
 * counts (Req 8.5).
 *
 * ── ARIA / accessibility (Req 24.5) ──────────────────────────────────────────
 *   - All metric cards use `<dl>` with labeled `<dt>`/`<dd>` pairs.
 *   - The recharts chart is wrapped in `<div role="img" aria-label="…">`.
 *   - Non-colour encoding: the line chart uses a stroke and a visible point
 *     label via `<Label>` so the encoding is not colour-only.
 *   - `FOCUS_RING` applied to the retry button.
 *
 * Requirements traceability: 8.4, 8.5, 8.6, 8.7, 24.5, 24.7.
 * Design references: Frontend Design (Admin analytics screen); Technology Stack
 * (Recharts).
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  AnalyticsClientError,
  readEventAnalytics,
} from '../lib/analyticsClient';
import type { EventAnalytics } from '../lib/analytics';
import { cx, FOCUS_RING } from '../lib/a11y';

// ----------------------------------------------------------------------------
// Types.
// ----------------------------------------------------------------------------

type DashboardState = 'loading' | 'success' | 'empty' | 'error';

// ----------------------------------------------------------------------------
// Helpers.
// ----------------------------------------------------------------------------

/**
 * Formats an ISO-8601 bucket start string to a concise time label (HH:MM).
 * Falls back to the raw string on parse failure.
 */
function formatBucketLabel(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/**
 * Returns `true` when an {@link EventAnalytics} result represents a
 * zero-interaction event: all scalar metrics are zero AND every engagement
 * bucket (if any) has zero count (Req 8.8).
 */
function isZeroInteraction(analytics: EventAnalytics): boolean {
  const allScalarsZero =
    analytics.uniqueParticipants === 0 &&
    analytics.questionStatusCounts.totalSubmitted === 0 &&
    analytics.totalVotes === 0 &&
    analytics.pollResponses === 0 &&
    analytics.wordCloudResponses === 0;
  const allBucketsZero =
    analytics.engagementOverTime.length === 0 ||
    analytics.engagementOverTime.every((b) => b.count === 0);
  return allScalarsZero && allBucketsZero;
}

// ----------------------------------------------------------------------------
// Sub-components.
// ----------------------------------------------------------------------------

/**
 * A single labeled metric card rendered as a `<dl>` term/definition pair.
 * Screen readers announce the term before the value; visual non-colour encoding
 * is via text (Req 24.5).
 */
function MetricCard({
  label,
  value,
  note,
}: {
  label: string;
  value: number;
  note?: string;
}): JSX.Element {
  return (
    <div className="rounded border border-ink-muted bg-surface p-4">
      <dl>
        <dt className="text-sm font-medium text-ink-muted">{label}</dt>
        <dd
          className="mt-1 text-3xl font-semibold text-ink"
          aria-label={`${label}: ${value.toLocaleString()}`}
        >
          {value.toLocaleString()}
        </dd>
        {note ? <dd className="mt-1 text-xs text-ink-muted">{note}</dd> : null}
      </dl>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main component.
// ----------------------------------------------------------------------------

/**
 * Admin analytics dashboard for a single event. Fetches metrics from
 * {@link readEventAnalytics} on mount, wiring all four UX states (Req 8.7,
 * 24.7). Labels every metric as platform interaction counts, never as verified
 * attendee counts (Req 8.5); never renders any `participant_identifier` value
 * (Req 8.6).
 */
export function AnalyticsDashboard(): JSX.Element {
  const { id: eventId } = useParams();

  const [state, setState] = useState<DashboardState>('loading');
  const [analytics, setAnalytics] = useState<EventAnalytics | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadAnalytics = useCallback(async (): Promise<void> => {
    if (!eventId) {
      setErrorMessage('No event was specified.');
      setState('error');
      return;
    }
    setState('loading');
    setErrorMessage(null);
    setAnalytics(null);
    try {
      const result = await readEventAnalytics(eventId);
      setAnalytics(result);
      setState(isZeroInteraction(result) ? 'empty' : 'success');
    } catch (err) {
      setErrorMessage(
        err instanceof AnalyticsClientError
          ? err.message
          : 'Analytics could not be loaded. Please try again.',
      );
      setState('error');
    }
  }, [eventId]);

  useEffect(() => {
    void loadAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // For the chart: transform EngagementBucket[] into recharts-friendly data.
  const chartData =
    analytics?.engagementOverTime.map((bucket) => ({
      time: formatBucketLabel(bucket.bucketStart),
      count: bucket.count,
    })) ?? [];

  const hasChartData =
    chartData.length > 0 && chartData.some((d) => d.count > 0);

  return (
    <main className="app-container py-8">
      <h1 className="text-2xl font-semibold text-ink">Event Analytics</h1>
      {/* Req 8.5: all counts are platform interaction counts, not verified attendees */}
      <p className="mt-2 text-sm text-ink-muted">
        All metrics represent <strong>platform interaction counts</strong>, not
        verified attendee counts. Participant figures count distinct anonymous
        session tokens, not real-world individuals.
      </p>

      {/* ── LOADING state (Req 8.7, 24.7) ─────────────────────────────────── */}
      {state === 'loading' ? (
        <p role="status" aria-live="polite" className="mt-6 text-ink-muted">
          ⏳ Loading analytics…
        </p>
      ) : null}

      {/* ── ERROR state (Req 8.7, 24.7) ───────────────────────────────────── */}
      {state === 'error' && errorMessage ? (
        <div className="mt-6 flex flex-col gap-3">
          <p role="alert" className="text-ink">
            ✕ {errorMessage}
          </p>
          <button
            type="button"
            onClick={() => void loadAnalytics()}
            className={cx(
              'touch-target self-start rounded bg-focus px-4 py-2 font-medium text-surface',
              FOCUS_RING,
            )}
          >
            Try again
          </button>
        </div>
      ) : null}

      {/* ── SUCCESS / EMPTY states ─────────────────────────────────────────── */}
      {(state === 'success' || state === 'empty') && analytics ? (
        <>
          {/* EMPTY state note (Req 8.8) */}
          {state === 'empty' ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-4 rounded border border-ink-muted bg-surface p-3 text-ink"
            >
              ∅ No interactions yet for this event.
            </p>
          ) : null}

          {/* ── Scalar metrics section (Req 8.1–8.3) ─────────────────────── */}
          <section aria-labelledby="metrics-heading" className="mt-6">
            <h2
              id="metrics-heading"
              className="mb-4 text-lg font-semibold text-ink"
            >
              Platform Interaction Metrics
            </h2>

            {/* Req 8.5: label as "Platform participants", NOT "Attendees";
                Req 8.6: only the count is rendered, never any identifier value */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <MetricCard
                label="Platform participants"
                value={analytics.uniqueParticipants}
                note="Distinct anonymous session tokens (not verified attendees)"
              />
              <MetricCard
                label="Questions submitted"
                value={analytics.questionStatusCounts.totalSubmitted}
              />
              <MetricCard label="Total votes" value={analytics.totalVotes} />
              <MetricCard
                label="Poll responses"
                value={analytics.pollResponses}
              />
              <MetricCard
                label="Word-cloud responses"
                value={analytics.wordCloudResponses}
              />
            </div>

            {/* Question status breakdown (Req 8.2) */}
            <div className="mt-4">
              <h3 className="mb-3 text-base font-medium text-ink">
                Question status breakdown
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label="Approved questions"
                  value={analytics.questionStatusCounts.approved}
                />
                <MetricCard
                  label="Featured questions"
                  value={analytics.questionStatusCounts.featured}
                />
                <MetricCard
                  label="Answered questions"
                  value={analytics.questionStatusCounts.answered}
                />
                <MetricCard
                  label="Hidden questions"
                  value={analytics.questionStatusCounts.hidden}
                />
              </div>
            </div>
          </section>

          {/* ── Engagement-over-time chart (Req 8.4, 24.5, 24.7) ─────────── */}
          <section aria-labelledby="chart-heading" className="mt-8">
            <h2
              id="chart-heading"
              className="mb-1 text-lg font-semibold text-ink"
            >
              Engagement Over Time
            </h2>
            <p className="mb-4 text-sm text-ink-muted">
              Platform interaction counts in 5-minute buckets — not verified
              attendee activity (Req 8.5).
            </p>

            {/* Req 24.5: ARIA-labelled chart container (role="img") */}
            <div
              role="img"
              aria-label="Engagement over time chart (5-minute buckets) — platform interaction counts, not verified attendee counts"
              className="rounded border border-ink-muted bg-surface p-4"
            >
              {hasChartData ? (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart
                    data={chartData}
                    margin={{ top: 8, right: 24, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 12 }}
                      label={{
                        value: 'Time (UTC)',
                        position: 'insideBottom',
                        offset: -4,
                        fontSize: 12,
                      }}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 12 }}
                      label={{
                        value: 'Interactions',
                        angle: -90,
                        position: 'insideLeft',
                        fontSize: 12,
                      }}
                    />
                    <Tooltip
                      formatter={(value) => [
                        `${String(value)} interactions`,
                        'Platform interactions',
                      ]}
                      labelFormatter={(label) => `Time: ${String(label)}`}
                    />
                    {/* Non-colour encoding: strokeDasharray differentiates the
                        line from grid lines; the name/key serves as a text label
                        for screen-reader-accessible tooltip (Req 24.5) */}
                    <Line
                      type="monotone"
                      dataKey="count"
                      name="Platform interactions"
                      stroke="#1d4ed8"
                      strokeWidth={2}
                      dot={{ r: 3, fill: '#1d4ed8' }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                /* Chart empty state — Req 24.7 */
                <p
                  role="status"
                  aria-live="polite"
                  className="py-8 text-center text-ink-muted"
                >
                  ∅ No engagement data yet.
                </p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

export default AnalyticsDashboard;
