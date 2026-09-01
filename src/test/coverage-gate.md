# Coverage Gate — Milestone 5 (Task 42.3)

## Gate: ≥80% Line Coverage

**Requirement:** Req 26.1, 26.2, 26.3

**Status:** ✅ PASSED — **80.04% line coverage** (gate threshold: 80%)

---

## How to Verify

Run the following command from the project root:

```
env -u NODE_OPTIONS npm run test:coverage
```

The report line `All files | 80.04 | 83.49 | 84.77 | 80.04` confirms:

- **Lines:** 80.04% ✅ (≥80%)
- **Branches:** 83.49% ✅
- **Functions:** 84.77% ✅
- **Statements:** 80.04% ✅

The machine-readable coverage artefact is produced at `coverage/coverage-summary.json`
and `coverage/coverage-final.json` by the `vitest --coverage` step (Req 26.3).

---

## Coverage Improvement Summary (Task 42.3)

Starting coverage was **77.13%** (1,007 tests passing). The following new test files
were added to reach ≥80%:

| File                                       | Tests Added | Behaviours Covered                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/questions.coverage.test.ts`       | 12          | `readAudienceQuestions` positive + negative; broadcast payload handlers; TIMED_OUT/CLOSED connection states                                                                                                                                                                                                                      |
| `src/lib/presenter.coverage.test.ts`       | 10          | Options-unreadable fallback in `readPresenterActivePoll`; responses-unreadable fallback in `readPresenterWordCloud`; poll-results broadcast handler; word-cloud broadcast handler                                                                                                                                                |
| `src/lib/ai/degradedMode.coverage.test.ts` | 15          | `planManualRetry()` positive + negative; `isAiFailureMode()` for all known modes and unknown strings                                                                                                                                                                                                                             |
| `src/lib/aiClient.coverage.test.ts`        | 21          | `runThemeInsights` (positive + negative); `saveAiProviderSettings` (success + validation/not_implemented edge errors); `removeAiCredential` (success + not_implemented); `runCategorisation` (degraded + edge error + unknown); `overrideQuestionCategory` (success + validation + unknown); `runSummary` (edge error + unknown) |

**Total new tests:** 58  
**Final test count:** 1,065 passing (53 skipped — pre-existing)

---

## Req-26.1/26.2 Behaviour Coverage

Every Req-26.1/26.2 behaviour module has **both** a POSITIVE test (acceptance)
and a NEGATIVE test (rejection):

### Event Status Rules (`src/lib/eventStatus.ts`) — 100% line

- Positive: valid live event accepted
- Negative: non-live event rejected

### Question Validation / Moderation Visibility (`src/lib/moderation.ts`) — 93.86% line

- Positive: question within allowed length and character set
- Negative: over-length or disallowed character rejected (client-side + RPC error mapping)

### Question Submission (`src/lib/questions.ts`) — 92.25% line

- Positive: `isValidQuestionLength` accepts 1–300 code points; `submitQuestion` succeeds
- Negative: empty/whitespace/over-length questions rejected; `rate_limited`, `event_not_live`, `invalid_length` RPC signals mapped to `QuestionError`

### Audience Questions / Voting (`src/lib/questions.ts`) — 92.25% line

- Positive: `readAudienceQuestions` returns approved/featured questions; `castQuestionVote` returns new count
- Negative: `already_voted` throws `QuestionError(kind:'already_voted')`; `no_vote_to_remove` throws correctly; transport error throws `kind:'unknown'`

### Poll Response Uniqueness/Updates (`src/lib/polls.ts`) — 83.24% line

- Positive: poll response submitted and stored
- Negative: duplicate/already-responded path rejected

### Word-Cloud Uniqueness/Normalisation (`src/lib/wordcloud.ts`) — 100% line

- Positive: unique normalised response accepted
- Negative: duplicate/hidden responses excluded

### Admin Authorisation (`src/lib/auth.ts`) — 99.18% line

- Positive: authenticated session passes
- Negative: missing session rejected with `unauthorized`

### Presenter Visibility (`src/lib/presenter.ts`) — 98.04% line

- Positive: `approved`, `featured`, `answered` questions returned
- Negative: `pending` and `hidden` excluded by type guard (Req 7.9)

### AI Failure Handling (`src/lib/aiClient.ts`) — 81.32% line

- Positive: `runThemeInsights`, `runCategorisation`, `runSummary` return results on success
- Negative: `unauthorized` / `validation` / `not_implemented` / `unknown` errors thrown; degraded state (`available:false`) returned for AI-unavailable responses

### Sanitised Provider Errors (`src/lib/ai/degradedMode.ts`) — 83.51% line

- Positive: `classifyFailureMode`, `describeAiUnavailable`, `indicationForCode` for all 5 modes
- Negative: unknown sanitised codes collapse to `unreachable`; `planManualRetry()` never allows auto-retry; `isAiFailureMode()` rejects unknown/case-variant strings

### Structured-Output Validation (`src/lib/ai/structuredOutput.ts`) — 100% line

- Positive: valid AI response accepted after schema validation
- Negative: malformed / over-limit responses rejected and trigger retry

---

## Coverage Gate Verification (Req 26.1, 26.2, 26.3)

| Requirement  | Description                                                      | Status                                                               |
| ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Req 26.1** | Positive behaviour tests for all Req-26.1/26.2 modules           | ✅ All modules have ≥1 positive test                                 |
| **Req 26.2** | Negative behaviour tests (rejection/error paths) for all modules | ✅ All modules have ≥1 negative test                                 |
| **Req 26.3** | Machine-readable coverage report produced by CI                  | ✅ `npm run test:coverage` produces `coverage/coverage-summary.json` |

Gate command: `env -u NODE_OPTIONS npm run test:coverage`  
Gate threshold: ≥80% line coverage  
Achieved: **80.04%**
