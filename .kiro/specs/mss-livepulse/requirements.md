# Requirements Document

## Introduction

MSS LivePulse is an AI-native, web-based audience engagement platform for internal events such as town halls, AI demonstrations, leadership briefings, workshops, and training sessions. Its initial target use case is MSS AI Demo Day 2026 (approximately 200-500 participants). Attendees join from any modern mobile browser by scanning a QR code — without installing an app or creating an account — and can submit questions, upvote questions, respond to single-choice polls, and contribute short word-cloud responses. Moderators manage events and moderate content; presenters display a full-screen projector-optimised view.

When a compatible AI endpoint is configured, LivePulse enhances the experience by categorising questions, clustering semantically similar questions, surfacing audience themes, and generating an end-of-event Markdown summary. All AI capabilities are optional: the complete core event flow operates fully without any AI service configured, and AI features fail gracefully when a provider is unavailable.

This document specifies the requirements for the MVP (V1). The platform is scoped for single internal events and is explicitly NOT a full enterprise replacement for commercial engagement platforms in V1. Requirements are written using EARS patterns and INCOSE quality rules. Numeric targets such as "500 concurrent participants" are engineering targets to be validated via load testing, not guarantees.

## Glossary

- **LivePulse / The_System**: The MSS LivePulse audience engagement platform as a whole.
- **Event**: A single scheduled engagement session (e.g., MSS AI Demo Day 2026) with its own audience URL, presenter URL, questions, polls, and word-cloud prompts.
- **Event_Manager**: The subsystem responsible for creating, editing, and transitioning the lifecycle status of events.
- **Audience_Service**: The subsystem that handles anonymous audience joining and participant interaction.
- **QA_Service**: The subsystem that handles question submission, moderation, and display.
- **Voting_Service**: The subsystem that handles question upvotes and vote-count aggregation.
- **Poll_Service**: The subsystem that handles poll creation, lifecycle, response collection, and result aggregation.
- **WordCloud_Service**: The subsystem that handles word-cloud prompt creation, response collection, normalisation, and rendering data.
- **Presenter_Service**: The subsystem that renders the full-screen presenter view and enforces moderator-selected display modes.
- **Analytics_Service**: The subsystem that computes platform interaction counts and engagement data for the admin dashboard.
- **Export_Service**: The subsystem that generates CSV and Markdown exports.
- **AI_Gateway**: The trusted server-side AI service abstraction (implemented as a Supabase Edge Function) through which ALL AI requests pass. The browser never calls an AI provider directly.
- **AI_Config_Service**: The subsystem that manages the global AI provider configuration and credential lifecycle.
- **Realtime_Service**: The subsystem that pushes live updates to connected clients (Supabase Realtime).
- **Administrator / Admin**: An authenticated user who can create/manage events, moderate, configure AI, and export.
- **Moderator**: A user managing an event; for V1 uses the same authenticated interface and permissions as the Administrator (no separate fine-grained RBAC).
- **Presenter**: A display-only role protected by a hard-to-guess presenter token or an authenticated session; has no admin capability.
- **Participant**: An anonymous audience member joining a live event from a browser.
- **Participant_Identifier**: A random, non-personal identifier stored locally in the participant's browser, used to enforce one vote/response per participant. Contains no personal information.
- **Presenter_Token**: A hard-to-guess token that grants access to the presenter view for an event.
- **Event_Code / Slug**: A short human-enterable code that resolves to an event's audience URL.
- **Moderation_Mode**: The per-event setting determining whether new questions are pre-moderated (pending until approved) or post-moderated (approved on arrival, may later be hidden).
- **OpenAI_Compatible_Endpoint**: An AI endpoint exposing an OpenAI-compatible chat-completions API, the standard integration contract for the MVP.
- **Managed_Secret_Store**: A secret storage facility provided by the deployment platform where AI credentials are stored and referenced by a secret reference.
- **Secret_Reference**: A non-secret pointer stored in the database that the AI_Gateway uses to resolve the actual credential at request time.
- **Encrypted_Credential**: A ciphertext AI credential produced by authenticated encryption, used only in the documented encryption-fallback design when a Managed_Secret_Store is unavailable.
- **SSRF**: Server-Side Request Forgery; an attack where a server is induced to make requests to unintended (often internal) destinations.
- **Destination_Allowlist**: A deployment-level list of permitted network destinations for AI endpoint requests, used to safely permit on-prem endpoints while blocking unsafe targets.
- **Structured_Output**: JSON output from an AI provider that is validated server-side against a defined schema before storage or display.
- **Cluster**: An additional grouping layer over approved questions produced by AI clustering; never replaces or deletes original questions.
- **Degraded_Mode**: The operating state in which AI features are unavailable but all core functions continue to work.
- **RLS**: Row Level Security enforced in the PostgreSQL database.
- **Core_Flow**: The set of non-AI capabilities: Q&A, moderation, voting, polls, word clouds, presenter controls, analytics, and CSV exports.

## Requirements

### Requirement 1: Event Management and Lifecycle

**User Story:** As an Administrator, I want to create and manage events with a controlled lifecycle, so that audience participation is only possible when an event is intentionally live.

#### Acceptance Criteria

1. WHEN an Administrator submits an event with a name between 1 and 100 characters, a start datetime, and an end datetime where the end datetime is later than the start datetime, THE Event_Manager SHALL create the event within 3 seconds and generate a unique event id, a unique audience URL, a presenter URL with a Presenter_Token, and a QR code that resolves to the audience URL.
2. IF an Administrator submits an event where the name is empty or exceeds 100 characters, or the end datetime is equal to or earlier than the start datetime, THEN THE Event_Manager SHALL reject the submission, retain any previously entered values without persisting a new event, and return a validation message identifying each invalid field.
3. THE Event_Manager SHALL accept an optional short description of up to 500 characters, an optional event code or slug of 1 to 64 characters restricted to letters, digits, and hyphens, an optional brand colour, and an optional logo of at most 2 MB when creating or editing an event.
4. IF an Administrator submits an event code or slug that is already in use by another event, THEN THE Event_Manager SHALL reject the submission, leave the existing event unchanged, and return a message identifying the conflicting event code or slug.
5. THE Event_Manager SHALL represent event status as exactly one of the values draft, live, ended, or archived, with draft as the status assigned at creation.
6. WHILE an event status is draft, THE Event_Manager SHALL make the event visible only to authenticated Administrators and SHALL deny audience participation requests for that event.
7. WHILE an event status is live, THE Audience_Service SHALL permit audience participation for that event.
8. WHEN an Administrator transitions an event status to ended, THE Event_Manager SHALL close question submission, question voting, poll responses, and word-cloud responses for that event within 3 seconds.
9. IF an audience participation request is received for an event whose status is ended or archived, THEN THE Audience_Service SHALL reject the request and return a message indicating that participation is closed for the event.
10. WHILE an event status is archived, THE Event_Manager SHALL retain the event and its associated questions, votes, poll responses, and word-cloud responses for reporting, and SHALL prevent modification of that data.
11. IF an Administrator attempts to reactivate an archived event, THEN THE Event_Manager SHALL reject the request, leave the event status as archived, and return a message stating that archived events cannot be reactivated in V1.
12. WHEN a request resolves the QR code or audience URL for an existing event, THE Audience_Service SHALL route the request to the correct audience event page for that event within 3 seconds.
13. IF a request resolves a QR code or audience URL that does not correspond to any existing event, THEN THE Audience_Service SHALL reject the request and return a message indicating that the event was not found.

### Requirement 2: Audience Joining and Participant Identity

**User Story:** As a Participant, I want to join a live event anonymously from my browser without installing an app or registering, so that I can participate immediately.

#### Acceptance Criteria

1. THE Audience_Service SHALL allow a Participant to join a live event by scanning the QR code, by opening the direct audience URL, or by entering the Event_Code on a landing page.
2. WHEN a Participant submits an Event_Code that does not match any existing event, THE Audience_Service SHALL reject the join attempt, SHALL display an error message indicating the Event_Code is invalid, and SHALL retain the Participant on the landing page.
3. WHEN a Participant enters an event for the first time in a browser and no Participant_Identifier is present, THE Audience_Service SHALL generate a random Participant_Identifier of at least 128 bits of entropy and store the Participant_Identifier in that browser's local storage.
4. WHEN a Participant re-enters an event in a browser where a Participant_Identifier is already present in local storage, THE Audience_Service SHALL reuse the existing Participant_Identifier without generating a new one.
5. THE Audience_Service SHALL generate each Participant_Identifier so that the Participant_Identifier contains no name, email address, phone number, IP address, or any other information that identifies a natural person.
6. WHEN a Participant views a live event, THE Audience_Service SHALL display the event name, the event status, the current active interaction, and navigation to the Q&A view, the poll view, and the word-cloud view within 3 seconds of the event view loading.
7. IF local storage is unavailable or writing the Participant_Identifier to local storage fails, THEN THE Audience_Service SHALL generate a session-scoped Participant_Identifier for the current browser session and SHALL allow the Participant to continue participating in the event.
8. IF a Participant attempts to join an event whose status is not live, THEN THE Audience_Service SHALL display the current event status and SHALL withhold all participation controls for the Q&A view, the poll view, and the word-cloud view.

### Requirement 3: Live Q&A Submission and Moderation

**User Story:** As a Participant, I want to submit questions anonymously and see approved questions, so that my questions can be surfaced and answered during the event.

#### Acceptance Criteria

1. WHILE an event status is live, THE QA_Service SHALL allow a Participant to submit a plain-text question of between 1 and 300 characters inclusive without requiring or recording any personally identifying Participant information.
2. IF a Participant submits a question that is empty, contains only whitespace, or exceeds 300 characters, THEN THE QA_Service SHALL reject the submission, retain any previously entered text, and return an error message identifying the 1 to 300 character length constraint.
3. IF a Participant submits a question WHILE the event status is any value other than live, THEN THE QA_Service SHALL reject the submission and return an error message indicating that submissions are only accepted while the event is live.
4. WHEN the QA_Service stores a question, THE QA_Service SHALL record a unique question id, the event id, the question text, a status, a vote count initialized to 0, an AI category where available, an AI cluster id where available, a created timestamp, and an updated timestamp.
5. THE QA_Service SHALL represent each question status as exactly one of the values pending, approved, featured, answered, or hidden.
6. WHERE an event Moderation_Mode is pre-moderated, WHEN a Participant submits a question, THE QA_Service SHALL set the question status to pending until a Moderator approves the question.
7. WHERE an event Moderation_Mode is post-moderated, WHEN a Participant submits a question, THE QA_Service SHALL set the question status to approved.
8. THE Event_Manager SHALL default the Moderation_Mode for the MSS AI Demo Day event to pre-moderated.
9. THE QA_Service SHALL display to the audience only questions with status approved or featured.
10. THE QA_Service SHALL exclude questions with status pending or hidden from the audience view and the presenter view.
11. WHEN a Participant selects a sort option, THE QA_Service SHALL sort eligible questions by most votes in descending vote-count order or by most recent in descending created-timestamp order.
12. WHEN a Moderator applies one or more filters, THE QA_Service SHALL return questions matching all selected criteria among status, AI category, AI cluster, and case-insensitive search text against the question text.
13. WHEN a Participant submits a question successfully, THE QA_Service SHALL display a success confirmation within 2 seconds of submission.

### Requirement 4: Question Voting

**User Story:** As a Participant, I want to upvote questions I care about and remove my vote, so that the most relevant questions rise to the top, without being able to vote more than once per question.

#### Acceptance Criteria

1. WHEN a Participant submits an upvote on a question whose status is approved or featured, THE Voting_Service SHALL record the vote and increment the question's vote count by 1.
2. THE Voting_Service SHALL permit at most one active vote per Participant_Identifier per question.
3. THE Voting_Service SHALL enforce the one-vote-per-participant-per-question rule in the database using a unique constraint on the combination of Participant_Identifier and question id.
4. IF a Participant attempts to cast a second vote on a question the Participant has already voted on, THEN THE Voting_Service SHALL reject the duplicate vote, leave the question's vote count unchanged, and return an error response indicating that a vote already exists for that Participant and question.
5. WHEN a Participant removes the Participant's own existing vote from a question, THE Voting_Service SHALL delete the vote and decrement the question's vote count by 1.
6. IF a Participant attempts to remove a vote from a question on which the Participant has no active vote, THEN THE Voting_Service SHALL leave the question's vote count unchanged and return an error response indicating that no vote exists to remove.
7. WHEN a question's vote count changes, THE Realtime_Service SHALL propagate the updated vote count to all other connected clients within 2 seconds without requiring a manual page refresh.
8. IF a Participant attempts to vote on a question whose status is pending or hidden, THEN THE Voting_Service SHALL reject the vote, leave the question's vote count unchanged, and return an error response indicating that the question is not eligible for voting.

### Requirement 5: Polls

**User Story:** As an Administrator, I want to create and run single-choice polls, so that I can gather quick structured audience input during the event.

#### Acceptance Criteria

1. WHEN an Administrator creates a poll, THE Poll_Service SHALL require a poll question between 1 and 200 characters inclusive and between 2 and 10 options inclusive, each option between 1 and 100 characters inclusive, and SHALL accept a display order as a positive integer and a results-visibility setting of exactly one of the values show-always or hide-until-closed.
2. IF an Administrator attempts to create a poll with a question outside 1 to 200 characters, fewer than 2 options, more than 10 options, or any option outside 1 to 100 characters, THEN THE Poll_Service SHALL reject the request, retain no partial poll, and return an error message identifying the field that failed validation.
3. THE Poll_Service SHALL support single-choice polls as the only poll type in the MVP.
4. THE Poll_Service SHALL represent each poll status as exactly one of the values draft, open, or closed.
5. THE Poll_Service SHALL permit at most one poll with status open per event at any time.
6. IF an Administrator attempts to open a poll while another poll for the same event is open, THEN THE Poll_Service SHALL reject the request, leave both polls' statuses unchanged, and return an error message stating that only one poll may be open per event.
7. WHILE a poll status is open, THE Poll_Service SHALL allow each Participant to submit exactly one response and SHALL replace the Participant's earlier response with the latest response when the Participant changes the response.
8. THE Poll_Service SHALL enforce the one-response-per-participant-per-poll rule in the database using a unique constraint on the combination of Participant_Identifier and poll id.
9. IF a Participant attempts to submit a response to a poll whose status is closed, THEN THE Poll_Service SHALL reject the response, leave the Participant's existing response unchanged, and return an error message indicating that the poll is closed.
10. IF a Participant attempts to submit a response to a poll whose status is draft, THEN THE Poll_Service SHALL reject the response and return an error message indicating that the poll is not open.
11. WHERE a poll results-visibility setting is hide-until-closed, THE Poll_Service SHALL withhold poll results from the audience view and the presenter view until the poll status becomes closed.
12. WHILE poll results are visible, THE Realtime_Service SHALL update poll results on connected clients within 2 seconds of a response being recorded without requiring a manual refresh.

### Requirement 6: Word Cloud

**User Story:** As an Administrator, I want to collect short word-cloud responses and display them as a live word cloud, so that I can visualise audience sentiment on a prompt.

#### Acceptance Criteria

1. WHEN an Administrator creates a word-cloud prompt, THE WordCloud_Service SHALL require prompt text of 1 to 200 characters, a maximum number of words per response between 1 and 10, and a setting for whether results are visible while collecting.
2. IF an Administrator submits a word-cloud prompt with missing prompt text, prompt text outside 1 to 200 characters, or a maximum-words-per-response value outside 1 to 10, THEN THE WordCloud_Service SHALL reject the creation and return an error indicating the specific invalid field, and SHALL NOT create the prompt.
3. THE WordCloud_Service SHALL represent each word-cloud prompt status as exactly one of the values draft, open, or closed.
4. IF an Administrator attempts to set a word-cloud prompt status to open while another word-cloud prompt for the same event already has status open, THEN THE WordCloud_Service SHALL reject the request and return an error indicating an open prompt already exists, and SHALL leave both prompts' statuses unchanged.
5. THE WordCloud_Service SHALL permit at most one word-cloud prompt with status open per event at any time.
6. WHILE a prompt status is open, THE WordCloud_Service SHALL allow each Participant to submit exactly one response of 1 to 50 characters and SHALL allow the Participant to update that response any number of times while the status remains open.
7. IF a Participant submits or updates a word-cloud response while the prompt status is not open, THEN THE WordCloud_Service SHALL reject the submission and return an error indicating the prompt is not open, and SHALL retain any previously stored response for that Participant.
8. IF a Participant submits a word-cloud response that is empty or exceeds 50 characters, THEN THE WordCloud_Service SHALL reject the submission and return an error indicating the length is invalid, and SHALL retain any previously stored response for that Participant.
9. THE WordCloud_Service SHALL enforce the one-response-per-participant-per-prompt rule in the database using a unique constraint on the combination of Participant_Identifier and prompt id.
10. WHEN the WordCloud_Service processes a response for rendering, THE WordCloud_Service SHALL normalise the response by converting all letters to lower case, removing leading and trailing whitespace, and replacing each run of consecutive internal whitespace characters with a single space character.
11. THE WordCloud_Service SHALL aggregate responses whose normalised term values are identical into a single term and SHALL render each term at a size that increases monotonically with its aggregated frequency count.
12. WHEN a Moderator hides an individual word-cloud entry, THE WordCloud_Service SHALL mark that entry as hidden.
13. THE WordCloud_Service SHALL exclude hidden word-cloud entries from the audience view and the presenter view and from all term frequency aggregation.
14. WHERE stop words or an admin-maintained exclusion list are configured, THE WordCloud_Service SHALL remove all terms matching the stop words or exclusion list before rendering, using the same normalisation applied to responses.
15. WHILE word-cloud results are visible, THE Realtime_Service SHALL push each word-cloud update to all connected clients within 2 seconds of the triggering change without requiring a manual refresh.

### Requirement 7: Presenter View

**User Story:** As a Presenter, I want a full-screen projector-optimised display controlled by the Moderator, so that the audience sees only intended content on the large screen.

#### Acceptance Criteria

1. THE Presenter_Service SHALL render the presenter view at a 16:9 aspect ratio with a minimum body text size of 24 pixels and a text-to-background contrast ratio of at least 7:1.
2. IF a request to access the presenter view is received without a valid Presenter_Token or an authenticated session, THEN THE Presenter_Service SHALL deny access, render no presenter content, and display an indication that access is unauthorized.
3. THE Presenter_Service SHALL generate the Presenter_Token with a minimum length of 32 characters drawn from an alphanumeric character set.
4. THE Presenter_Service SHALL support exactly the following presenter display modes: join screen, featured question, top questions, poll question with results, word cloud, AI audience themes, and waiting screen.
5. WHEN a Moderator selects an active presenter mode from the admin dashboard, THE Presenter_Service SHALL display only the content permitted by that mode within 2 seconds of the selection.
6. WHEN presenter content changes, THE Realtime_Service SHALL update the presenter view within 2 seconds without requiring a manual refresh.
7. IF the Realtime_Service connection is lost, THEN THE Presenter_Service SHALL retain the last successfully displayed content and display an indication that the live connection is interrupted.
8. THE Presenter_Service SHALL display only content selected and permitted by the Moderator.
9. THE Presenter_Service SHALL exclude questions with status pending or hidden and hidden word-cloud entries from all presenter display modes.
10. WHILE the presenter display mode is join screen, THE Presenter_Service SHALL display the QR code and the Event_Code that both resolve to the event's audience URL.

### Requirement 8: Event Analytics

**User Story:** As an Administrator, I want to view engagement analytics on the dashboard, so that I can understand platform interaction during the event.

#### Acceptance Criteria

1. WHEN an Administrator opens the analytics dashboard for an event, THE Analytics_Service SHALL display the count of unique Participant_Identifiers seen for the event as a non-negative integer.
2. WHEN an Administrator opens the analytics dashboard for an event, THE Analytics_Service SHALL display the total number of submitted questions and separate non-negative integer counts of questions in each status: approved, featured, answered, and hidden.
3. WHEN an Administrator opens the analytics dashboard for an event, THE Analytics_Service SHALL display total question votes, poll response counts, and word-cloud response counts for the event, each as a non-negative integer.
4. WHEN an Administrator opens the analytics dashboard for an event, THE Analytics_Service SHALL display engagement over time as a series of interaction counts aggregated into fixed time intervals of 5 minutes spanning from the event start time to the current time.
5. THE Analytics_Service SHALL label all displayed metrics with text indicating they represent platform interaction counts rather than verified attendee counts.
6. THE Analytics_Service SHALL never display raw Participant_Identifier values in the user interface.
7. IF analytics data for the requested event cannot be retrieved, THEN THE Analytics_Service SHALL display an error indication stating that analytics are unavailable and SHALL not display partial or stale metric values.
8. WHEN an event has zero recorded interactions, THE Analytics_Service SHALL display each metric with a value of 0.

### Requirement 9: Data Export

**User Story:** As an Administrator, I want to export event results, so that I can share and archive outcomes after the event.

#### Acceptance Criteria

1. WHEN an Administrator requests a questions export, THE Export_Service SHALL produce a CSV file containing one row per question with the question text (maximum 1000 characters) and its vote count (integer, 0 to 999,999,999) within 10 seconds for events containing up to 10,000 questions.
2. WHEN an Administrator requests a polls export, THE Export_Service SHALL produce a CSV file containing one row per poll option with the poll text, the poll option text, and the response count (integer, 0 to 999,999,999) within 10 seconds for events containing up to 10,000 poll options.
3. WHEN an Administrator requests a word-cloud export, THE Export_Service SHALL produce a CSV file containing one row per distinct word with the word text (maximum 100 characters) and its frequency count (integer, 1 to 999,999,999) within 10 seconds for events containing up to 10,000 distinct words.
4. WHEN an Administrator requests an event summary export, THE Export_Service SHALL produce a Markdown file containing the event summary within 10 seconds.
5. THE Export_Service SHALL exclude Participant_Identifiers and other personal information from all exports.
6. IF an export request references an event that contains no data of the requested type, THEN THE Export_Service SHALL produce a file containing only the column headers (for CSV exports) or an empty-state indicator (for the Markdown summary) and SHALL indicate to the Administrator that no data was available.
7. IF an export operation fails to complete, THEN THE Export_Service SHALL not produce a partial file and SHALL return an error indication to the Administrator identifying the failed export type.

### Requirement 10: User Roles and Authorisation

**User Story:** As a platform owner, I want roles and permissions enforced, so that anonymous participants cannot perform administrative or moderation actions.

#### Acceptance Criteria

1. IF a request targets an Administrator route or Administrator mutation without a valid authenticated session, THEN THE_System SHALL deny the request, return an authorization error indicating authentication is required, and make no change to persisted state.
2. WHEN a request targets an Administrator route or Administrator mutation with a valid authenticated session, THE_System SHALL authorize the request.
3. THE_System SHALL grant a Moderator the same authenticated interface access and the same set of permissions as an Administrator for V1.
4. THE_System SHALL allow an anonymous Participant, without an authenticated session, to join a live event, submit a question, upvote an eligible question, remove a previously applied upvote on an eligible question, respond to an active poll, and submit a word-cloud response.
5. IF an anonymous Participant attempts to create an event, edit an event, moderate content, view hidden questions, view pending questions, trigger an AI operation, or access an admin function, THEN THE_System SHALL deny the request, return an authorization error indicating the action is not permitted for anonymous Participants, and make no change to persisted state.
6. THE Presenter_Service SHALL grant a Presenter display-only access to permitted event content.
7. IF a Presenter attempts any administrative capability, including creating, editing, deleting, or moderating content, THEN THE Presenter_Service SHALL deny the request, return an authorization error indicating administrative actions are not permitted for Presenters, and make no change to persisted state.

### Requirement 11: AI Provider Configuration

**User Story:** As an Administrator, I want to configure a single global AI provider, so that I can enable optional AI enhancements for events.

#### Acceptance Criteria

1. WHEN an authenticated Administrator submits an AI provider configuration, THE AI_Config_Service SHALL accept the following fields: AI enabled state (boolean), display name (1 to 100 characters), provider type, base URL (a valid absolute URL, 1 to 2048 characters), chat-completions path (1 to 512 characters), auth type, API key or bearer token (1 to 4096 characters), model id (1 to 200 characters), temperature (a decimal from 0.0 to 2.0), maximum output token count (an integer from 1 to 128000), request timeout in seconds (an integer from 1 to 300), and TLS certificate verification required (boolean).
2. IF an Administrator submits a configuration where any field fails its validation constraint, THEN THE AI_Config_Service SHALL reject the configuration, SHALL retain the previously saved configuration unchanged, and SHALL return an error response indicating which field failed validation.
3. THE AI_Config_Service SHALL support the provider type openai_compatible and SHALL support a documented custom_adapter extension point.
4. IF an Administrator submits a provider type other than openai_compatible or custom_adapter, THEN THE AI_Config_Service SHALL reject the configuration and SHALL return an error response indicating the provider type is unsupported.
5. THE AI_Config_Service SHALL support the auth types bearer, api_key_header with a configurable header name (1 to 100 characters), and none.
6. WHERE the configured auth type is none, THE AI_Config_Service SHALL display a visible warning stating that the endpoint must be network-protected.
7. THE AI_Config_Service SHALL permit at most one active global AI provider configuration for the MVP.
8. IF an Administrator attempts to create a second active global AI provider configuration, THEN THE AI_Config_Service SHALL reject the request and SHALL return an error response indicating that only one active configuration is permitted.
9. WHEN an Administrator requests the current AI configuration, THE AI_Config_Service SHALL return the non-secret configuration fields and SHALL indicate the credential state as either Configured or Not configured, without returning the credential value.
10. WHEN an Administrator submits changes to configuration fields other than the credential, THE AI_Config_Service SHALL apply the changes without requiring re-entry of the credential and SHALL retain the existing credential unchanged.
11. THE AI_Config_Service SHALL provide a Replace credential action that is distinct from the action used to edit other settings.
12. WHEN an Administrator invokes the Remove credential action and does not provide explicit confirmation, THE AI_Config_Service SHALL retain the credential unchanged.
13. WHEN an Administrator invokes the Remove credential action and provides explicit confirmation, THE AI_Config_Service SHALL remove the credential and SHALL set the credential state to Not configured.
14. WHEN an Administrator sets the AI enabled state to disabled, THE AI_Config_Service SHALL disable AI enhancements while retaining all existing event data unchanged.

### Requirement 12: AI Credential Storage and Protection

**User Story:** As a security owner, I want AI credentials treated as write-only secrets and protected server-side, so that credentials are never exposed to the browser or logs.

#### Acceptance Criteria

1. WHEN an Administrator submits an AI credential, THE AI_Config_Service SHALL accept the credential only over a TLS 1.2 or higher HTTPS connection at an authenticated server-side function, and IF the connection is not HTTPS or the session is not authenticated, THEN THE AI_Config_Service SHALL reject the request without persisting the credential and return an error indicating that a secure authenticated connection is required.
2. WHEN an Administrator submits an AI credential, THE AI_Config_Service SHALL validate that the credential is a non-empty string of 1 to 8192 characters, and IF validation fails, THEN THE AI_Config_Service SHALL reject the request without persisting any value and return an error indicating the credential is invalid.
3. WHERE a Managed_Secret_Store is available, THE AI_Config_Service SHALL store the credential in the Managed_Secret_Store and SHALL store only a Secret_Reference and non-secret configuration in the database.
4. WHERE a Managed_Secret_Store cannot be created dynamically at runtime, THE AI_Config_Service SHALL use exactly one of a deployment-managed secret configured outside the application or an application-level authenticated-encryption fallback, and SHALL NOT store the plaintext credential in any database table.
5. WHERE the authenticated-encryption fallback is used, THE AI_Config_Service SHALL encrypt the credential using an authenticated-encryption algorithm from a maintained cryptography library, SHALL hold the encryption key outside the database and outside the frontend, and SHALL store only the Encrypted_Credential in the database.
6. THE AI_Config_Service SHALL store either a Secret_Reference or an Encrypted_Credential for the AI provider configuration, and SHALL NOT store both simultaneously.
7. WHEN the AI_Gateway requires the credential to perform an AI request, THE AI_Gateway SHALL resolve or decrypt the credential only inside the server-side gateway process immediately before use, and SHALL discard the resolved plaintext credential from memory once the request completes.
8. IF resolution or decryption of the credential fails, THEN THE AI_Gateway SHALL abort the AI request, return an error indicating the credential could not be resolved, and SHALL NOT include the plaintext or partial credential in the error.
9. THE_System SHALL never write the plaintext credential to logs, errors, telemetry, exports, or AI job records.
10. WHEN the AI_Config_Service returns configuration through a read API, THE AI_Config_Service SHALL omit the Encrypted_Credential, the Secret_Reference target value, and any resolved secret from the response.
11. IF an Administrator requests to replace or remove an AI credential, THEN THE AI_Config_Service SHALL require an authenticated session established or re-verified within the preceding 300 seconds before performing the action, and IF that condition is not met, THEN THE AI_Config_Service SHALL reject the request and prompt for re-authentication without modifying the stored credential.

### Requirement 13: AI Endpoint Validation and SSRF Protection

**User Story:** As a security owner, I want AI endpoints validated and constrained by a deployment allowlist, so that admin-configurable endpoints cannot be abused to reach unsafe internal targets.

#### Acceptance Criteria

1. THE AI_Config_Service SHALL provide a Test connection action that executes server-side and returns only sanitised results containing no provider response headers, credentials, or raw provider diagnostics.
2. WHEN a Test connection action completes successfully, THE AI_Gateway SHALL return the success outcome, the HTTP status category (2xx, 3xx, 4xx, or 5xx), the configured model id, the measured round-trip time in milliseconds, and the test timestamp in ISO 8601 UTC format.
3. IF a Test connection action fails, THEN THE AI_Gateway SHALL return the failure outcome, a sanitised error message indicating the failure category (invalid URL scheme, timeout, disallowed destination, connection error, or invalid response), the test timestamp in ISO 8601 UTC format, and SHALL NOT persist any configuration change.
4. WHEN a Test connection action runs, THE AI_Gateway SHALL validate that the URL scheme is one of https or http, send a minimal non-sensitive prompt of at most 256 characters, and verify that a non-empty usable text response is returned.
5. IF a Test connection action does not receive a complete response within the configured request timeout of 1 to 120 seconds (default 30 seconds), THEN THE AI_Gateway SHALL abort the request and return a timeout failure outcome.
6. IF the URL scheme is not https or http, THEN THE AI_Gateway SHALL reject the request and return an error indicating an invalid URL scheme.
7. THE AI_Gateway SHALL block by default all requests whose resolved destination is a link-local metadata address (169.254.0.0/16, including 169.254.169.254), a loopback address (127.0.0.0/8, ::1), or a private-range address (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7).
8. THE AI_Gateway SHALL apply SSRF protection to all AI requests by resolving the destination address before connection and SHALL permit private network destinations only when the resolved destination is present in the deployment-level Destination_Allowlist.
9. IF a configured AI endpoint resolves to a destination that is not present in the Destination_Allowlist, THEN THE AI_Gateway SHALL reject the request without sending it and SHALL return an error indicating a disallowed destination.
10. THE AI_Gateway SHALL never return provider response headers, credentials, or raw provider diagnostics to the browser.
11. THE AI_Config_Service SHALL treat compatibility as established only when both an Administrator connection test and a representative structured-output test return a success outcome.
12. WHERE the deployment does not explicitly permit disabling TLS certificate verification, THE_System SHALL NOT provide a production user-interface option to disable TLS certificate verification.

### Requirement 14: AI Structured Output Validation

**User Story:** As a platform owner, I want all AI output validated against a schema server-side, so that malformed or unsafe model output is never stored or rendered.

#### Acceptance Criteria

1. WHERE the provider supports a JSON output mode, THE AI_Gateway SHALL request Structured_Output as JSON.
2. WHEN the AI_Gateway receives an AI response, THE AI_Gateway SHALL validate the response server-side against the defined schema before storing or displaying the response.
3. WHERE the provider lacks a native JSON mode, THE AI_Gateway SHALL request JSON within the prompt, extract candidate JSON server-side, and validate the candidate JSON against the same schema.
4. IF an AI response fails schema validation, THEN THE AI_Gateway SHALL reject the response without storing or displaying it, SHALL leave any previously stored data unchanged, and SHALL return a recoverable AI-processing error indicating that schema validation failed.
5. IF the AI_Gateway does not receive a complete AI response within 30 seconds of the request, THEN THE AI_Gateway SHALL abort the request, SHALL NOT store or display any partial response, and SHALL return a recoverable AI-processing error indicating a timeout.
6. IF schema validation fails, THEN THE AI_Gateway SHALL retry the AI request up to a maximum of 2 additional attempts, and IF all attempts fail, THEN THE AI_Gateway SHALL return a recoverable AI-processing error indicating that validation could not be satisfied.
7. IF no candidate JSON can be extracted from a response received from a provider lacking a native JSON mode, THEN THE AI_Gateway SHALL treat the response as a schema validation failure and SHALL return a recoverable AI-processing error indicating that no valid JSON was found.
8. THE_System SHALL render submitted and AI-produced text as plain text and SHALL NOT render unvalidated model output as executable HTML, executable script, or any other executable markup.

### Requirement 15: AI Question Categorisation

**User Story:** As a Moderator, I want approved questions categorised into a fixed set of categories, so that I can organise questions by topic while keeping originals intact.

#### Acceptance Criteria

1. WHEN an Administrator requests categorisation, THE AI_Gateway SHALL classify each approved question into exactly one category from the set {Technology, Governance, Security, Operations, Workforce, Compliance, Strategy, Other} within 30 seconds per batch of up to 100 questions.
2. IF the AI_Gateway does not receive a categorisation response within 30 seconds, THEN THE AI_Gateway SHALL abort the request, retain all questions in their pre-categorisation state, and return an error indicating a categorisation timeout.
3. THE AI_Gateway SHALL validate each returned category against the allowed category list of exactly the eight values {Technology, Governance, Security, Operations, Workforce, Compliance, Strategy, Other} using an exact, case-sensitive string match.
4. IF a categorisation response contains a category that is not an exact match to one of the eight allowed values, THEN THE AI_Gateway SHALL reject the entire response, discard all categories from that response, and return an error indicating an invalid category was received.
5. WHEN categorisation completes successfully AND the provider returns a confidence value, THE QA_Service SHALL store the assigned category and the confidence value, where confidence is a decimal from 0.00 to 1.00 inclusive.
6. WHEN categorisation completes successfully AND the provider does not return a confidence value, THE QA_Service SHALL store the assigned category and record the confidence as absent.
7. WHEN a Moderator submits an override for an AI-assigned category, THE QA_Service SHALL replace the stored category with the Moderator-selected value only if the selected value is one of the eight allowed categories, and SHALL retain the previous category value as a prior assignment.
8. IF a Moderator submits an override with a value that is not one of the eight allowed categories, THEN THE QA_Service SHALL reject the override, retain the existing category unchanged, and return an error indicating an invalid category selection.
9. THE QA_Service SHALL preserve the original question text unchanged during and after categorisation, such that the stored question text before and after categorisation is byte-for-byte identical.
10. IF an Administrator does not explicitly request categorisation of hidden questions, THEN THE AI_Gateway SHALL exclude all questions in the hidden state from the categorisation request.

### Requirement 16: AI Question Clustering

**User Story:** As a Moderator, I want semantically similar questions grouped into clusters, so that I can address related questions together without altering the originals.

#### Acceptance Criteria

1. WHEN an Administrator requests clustering, THE AI_Gateway SHALL group approved questions into clusters by submitting the question set to the configured OpenAI-compatible chat-completions endpoint with a prompt instructing the model to group semantically similar questions and return structured JSON clusters, where each cluster contains between 2 and 500 member questions and a cluster label of 1 to 100 characters, and THE AI_Gateway SHALL validate the returned JSON against the cluster schema before use, without relying on vector-embedding or pairwise vector-similarity computation.
2. WHEN an Administrator requests clustering, IF the number of approved questions in the current event is fewer than 2, THEN THE AI_Gateway SHALL return zero clusters and an indication that insufficient questions are available for clustering.
3. IF the AI_Gateway clustering operation fails or does not return a response within 30 seconds, THEN THE AI_Gateway SHALL abort the clustering operation, retain all original question records unchanged, and return an error indication describing the clustering failure.
4. THE QA_Service SHALL treat a Cluster as an additional grouping layer and SHALL NOT delete, replace, or auto-merge the original question records.
5. WHEN a Cluster is displayed, THE Voting_Service SHALL calculate the Cluster vote total as the arithmetic sum of the current vote counts of all member questions of that Cluster.
6. WHEN a member question is added to or removed from a Cluster, THE Voting_Service SHALL recalculate the Cluster vote total as the arithmetic sum of the current vote counts of the remaining member questions.
7. WHEN a Moderator renames a Cluster, THE QA_Service SHALL accept a cluster label of 1 to 100 characters and SHALL reject a rename request with a label that is empty or exceeds 100 characters, returning an error indication describing the validation failure while preserving the existing cluster label.
8. WHEN a Moderator removes a question from a Cluster, THE QA_Service SHALL retain the original question record unchanged and SHALL keep the question available outside the Cluster.
9. WHEN a Moderator dissolves a Cluster, THE QA_Service SHALL remove the Cluster grouping only and SHALL retain all member question records unchanged.
10. WHEN the AI_Gateway receives a clustering response, THE AI_Gateway SHALL validate that every returned question id belongs to the current event, and IF the response references one or more question ids outside the current event, THEN THE AI_Gateway SHALL reject the entire clustering response, create no clusters, and return an error indication describing the invalid question id reference.

### Requirement 17: AI Audience Theme Insights

**User Story:** As an Administrator, I want AI-generated audience themes grounded in event data, so that I can highlight what the audience cares about without fabricated figures.

#### Acceptance Criteria

1. WHEN an Administrator requests theme insights for a selected event, THE AI_Gateway SHALL generate a result set containing up to 5 top themes, up to 5 emerging concerns, up to 10 frequently raised topics, and up to 5 notable high-vote questions within 10 seconds.
2. WHEN an Administrator requests theme insights, THE AI_Gateway SHALL classify a question as a notable high-vote question when its vote count is within the top 10 percent of vote counts for the selected event or its vote count is greater than or equal to 10, whichever threshold identifies fewer questions.
3. THE AI_Gateway SHALL ground theme insights only in data stored for the selected event, excluding data from all other events.
4. THE AI_Gateway SHALL instruct the model not to invent participant counts, vote totals, or questions, and SHALL include only participant counts, vote totals, and question text that are present in the stored event data.
5. IF the selected event contains no stored questions, THEN THE AI_Gateway SHALL return an empty result set for all four insight categories and provide a status indication that no audience data is available for analysis, without generating fabricated content.
6. IF the model generation fails or does not return a result within the 10 second timeout, THEN THE AI_Gateway SHALL return an error indication that theme insights could not be generated and SHALL preserve the stored event data unchanged.

### Requirement 18: AI End-of-Event Summary

**User Story:** As an Administrator, I want a Markdown end-of-event summary that separates calculated data from AI interpretation, so that stakeholders can trust the reported figures.

#### Acceptance Criteria

1. WHEN an Administrator requests an end-of-event summary, THE Export_Service SHALL produce a Markdown report containing the following sections: event details, platform interaction counts, top questions by votes, themes and categories, poll results, word-cloud results, questions marked answered, questions requiring follow-up, an AI executive summary, and suggested follow-up actions.
2. WHEN generating the top questions by votes section, THE Export_Service SHALL include a maximum of 10 questions ordered by descending vote count, with ties broken by earliest submission timestamp.
3. WHEN an Administrator requests an end-of-event summary, THE Export_Service SHALL complete generation of the Markdown report within 30 seconds.
4. THE Export_Service SHALL calculate the platform interaction counts and all other calculated platform data directly from the database independently of the AI model.
5. THE Export_Service SHALL place all calculated platform data within a section headed "Calculated Data" and all AI interpretation within a section headed "AI Interpretation", such that the two sections are non-overlapping and separately headed in the Markdown report.
6. THE Export_Service SHALL prefix the AI executive summary and suggested follow-up actions with a visible textual label of "AI-Generated".
7. IF the AI model is unavailable or fails to return a result within 30 seconds, THEN THE Export_Service SHALL produce the Markdown report containing all calculated platform data sections, omit the AI executive summary and suggested follow-up actions, and include a visible notice indicating that AI-generated content could not be produced.
8. IF the requested event has zero recorded platform interactions, THEN THE Export_Service SHALL produce the Markdown report with each calculated data section present and displaying a count of 0 or an explicit empty-state indicator.

### Requirement 19: AI Failure Handling and Degraded Mode

**User Story:** As a platform owner, I want AI failures to never break the core event flow, so that the event proceeds reliably regardless of AI availability.

#### Acceptance Criteria

1. IF no AI provider is configured, the provider is unreachable, authentication fails, the provider returns an invalid response, or a request exceeds the administrator-configured request timeout (as defined in Requirement 11), THEN THE_System SHALL keep Q&A, moderation, voting, polls, word clouds, presenter controls, analytics, and CSV exports fully functional such that each feature responds to user actions with no error attributable to the AI failure.
2. WHEN an AI operation fails, THE_System SHALL within 2 seconds display an "AI unavailable" indication on the AI control that initiated the operation, without exposing provider internal details in the message.
3. WHILE an AI operation is failing, THE_System SHALL limit automatic retries to a maximum of 3 attempts per operation using exponential backoff, and THE_System SHALL NOT issue further automatic retries until the Administrator initiates a manual retry.
4. WHEN an Administrator initiates a retry of an individual AI operation, THE_System SHALL execute exactly one retry attempt for that operation and display the retry outcome (success or failure) on the corresponding AI control within 2 seconds of completion.
5. WHEN an AI operation fails, THE_System SHALL preserve all previously approved moderation decisions and previously valid AI results with no modification or deletion.
6. IF an AI operation fails, THEN THE_System SHALL retain the pre-operation state of the affected data such that no partial or invalid AI output is persisted.
7. THE_System SHALL NOT switch AI providers without explicit Administrator action, and THE_System SHALL treat automatic multi-provider failover as out of scope for V1.

### Requirement 20: AI Data Handling and Privacy

**User Story:** As a privacy owner, I want AI requests limited to minimal necessary data with clear notice, so that participant privacy is protected.

#### Acceptance Criteria

1. WHEN the AI_Gateway constructs a request payload to the AI provider, THE AI_Gateway SHALL exclude all Participant_Identifiers, where Participant_Identifiers are defined as participant name, email address, phone number, user id, and IP address.
2. IF a request payload is detected to contain any Participant_Identifier prior to transmission, THEN THE AI_Gateway SHALL block transmission of the request and record an error indicating the presence of restricted data.
3. WHEN the AI_Gateway constructs a request payload to the AI provider, THE AI_Gateway SHALL include only the question text (maximum 10,000 characters) and aggregate metadata, and SHALL exclude all other data fields.
4. THE_System SHALL restrict initiation and configuration of all AI operations to users holding the Administrator role, and SHALL reject AI operation requests from non-Administrator users with an error indicating insufficient privileges.
5. WHERE AI is enabled, THE AI_Config_Service SHALL display to the Administrator a notice stating that event text will be sent to the configured endpoint before any AI operation can be initiated.
6. WHEN an AI operation runs, THE AI_Gateway SHALL log the job type, status, start and end timestamps, model id, and sanitised errors within 5 seconds of the operation reaching a terminal state.
7. WHERE default logging configuration is active, THE AI_Gateway SHALL exclude credentials and full prompt text from all log entries.
8. IF event data is requested for provider training without a separately recorded approval, THEN THE_System SHALL reject the use of that event data for provider training and record an error indicating that approval is required.

### Requirement 21: Security, RLS, and Data Governance

**User Story:** As a security owner, I want database-enforced security and minimal data collection, so that the platform is safe by default and privacy-preserving.

#### Acceptance Criteria

1. THE_System SHALL serve all client-facing traffic over HTTPS using TLS version 1.2 or higher.
2. IF THE_System receives a request over plain HTTP, THEN THE_System SHALL redirect the request to the equivalent HTTPS URL and SHALL NOT serve the requested resource over plain HTTP.
3. THE_System SHALL enable Row Level Security (RLS) on 100% of database tables exposed to clients.
4. IF a client request attempts to access a table row not permitted by an RLS policy, THEN THE_System SHALL reject the request, return an authorization-failure response indicating access is denied, and SHALL NOT return the row data.
5. THE_System SHALL restrict anonymous users to reading and writing only event data belonging to an event whose status is active, and SHALL deny anonymous read and write access to all data for events whose status is not active.
6. THE_System SHALL perform all Administrator mutations exclusively through authenticated policies or server-side Edge Functions.
7. IF an Administrator mutation is attempted without a valid authenticated session, THEN THE_System SHALL reject the mutation, return an authentication-failure response indicating the caller is not authorized, and SHALL leave the underlying data unchanged.
8. THE_System SHALL NOT expose service-role keys, AI credentials, encryption keys, or resolved secrets in client code or in any client-accessible read API response.
9. WHEN THE_System receives submitted input, THE_System SHALL validate and sanitise the input against a configurable allow-list of permitted characters before persisting it.
10. WHEN THE_System receives submitted input, THE_System SHALL enforce a configurable maximum length, with a default maximum of 500 characters per free-text field.
11. IF submitted input fails validation, exceeds the configured maximum length, or fails sanitisation, THEN THE_System SHALL reject the input, return a validation-failure response indicating the reason, and SHALL NOT persist the input.
12. WHEN THE_System renders submitted text, THE_System SHALL render the submitted text as inert text and SHALL NOT render submitted text as executable HTML or script.
13. THE_System SHALL enforce a configurable limit on anonymous question submissions server-side through a Supabase Edge Function or a PostgreSQL RPC function, with a default of 10 submissions per anonymous client per 60 seconds, and SHALL NOT rely on client-side validation alone for this limit.
14. THE_System SHALL enforce a configurable limit on anonymous votes server-side through a Supabase Edge Function or a PostgreSQL RPC function, with a default of 30 votes per anonymous client per 60 seconds, and SHALL NOT rely on client-side validation alone for this limit.
15. IF an anonymous client exceeds the configured rate limit for question submissions or votes, THEN THE server-side enforcement (Supabase Edge Function or PostgreSQL RPC function) SHALL reject the request, return a rate-limit-exceeded response indicating the caller must retry later, and SHALL NOT record the submission or vote.
16. THE_System SHALL NOT collect names, emails, employee numbers, IP addresses, or other personal information for analytics.
17. THE_System SHALL provide an Administrator function to delete an event and all of its associated data, including questions, votes, and moderation records.
18. WHEN an Administrator confirms deletion of an event, THE_System SHALL permanently remove the event and all of its associated data within 30 seconds and SHALL return a confirmation indicating deletion succeeded.
19. WHEN a moderation change, event-status change, AI endpoint change, or credential-rotation change occurs, THE_System SHALL record an audit entry containing the UTC timestamp of the change and the identifier of the change type.

### Requirement 22: Input Length Limits

**User Story:** As a platform owner, I want enforced input length limits, so that submissions remain concise and storage is bounded.

#### Acceptance Criteria

1. WHEN a question is submitted, THE QA_Service SHALL accept the question only if its length is between 1 and 300 characters inclusive, counting each Unicode code point as one character.
2. WHEN a poll is submitted, THE Poll_Service SHALL accept the poll question only if its length is between 1 and 200 characters inclusive, counting each Unicode code point as one character.
3. WHEN a poll is submitted, THE Poll_Service SHALL accept each poll option only if its length is between 1 and 100 characters inclusive, counting each Unicode code point as one character.
4. WHEN a word-cloud response is submitted, THE WordCloud_Service SHALL accept the response only if its length is between 1 and 50 characters inclusive, counting each Unicode code point as one character.
5. WHEN an event is created or updated, THE Event_Manager SHALL accept the event name only if its length is between 1 and 100 characters inclusive, counting each Unicode code point as one character.
6. WHEN an event is created or updated, THE Event_Manager SHALL accept the event description only if its length is between 0 and 500 characters inclusive, counting each Unicode code point as one character.
7. IF a submitted value exceeds its configured maximum length limit, THEN THE_System SHALL reject the entire submission without persisting any part of it, and SHALL return an error message identifying the field name and its applicable maximum character limit.

### Requirement 23: Realtime Updates, Performance, and Reliability

**User Story:** As a Participant, I want live updates without manual refresh and resilient reconnection, so that the experience stays current during the event.

#### Acceptance Criteria

1. WHEN a question is submitted or a vote changes with up to 500 concurrent connected Participants, THE Realtime_Service SHALL deliver the update to all connected clients subscribed to the affected view within 2 seconds measured from write commit to client receipt.
2. THE Realtime_Service SHALL subscribe only to the tables and records required for the active view and SHALL NOT fetch the full event dataset after each update.
3. THE_System SHALL maintain database indexes for event id, event status, creation time, poll id, and question id.
4. THE_System SHALL compute counts using database aggregation queries that return results within 2 seconds under the load defined in criterion 9.
5. IF the realtime connection is interrupted for more than 3 seconds, THEN THE_System SHALL display a reconnecting-state indicator visible to the Participant AND SHALL display an enabled manual refresh control.
6. WHEN performing a safe read operation after an interruption, THE_System SHALL retry using exponential backoff starting at 1 second, doubling each attempt up to a maximum interval of 30 seconds, for a maximum of 5 attempts.
7. IF a read retry fails after 5 attempts, THEN THE_System SHALL stop automatic retries AND SHALL display an error indicating the connection could not be re-established AND SHALL keep the manual refresh control enabled.
8. IF a question or vote write is retried after an interruption, THEN THE_System SHALL use an idempotency mechanism such that no duplicate question or vote record is created, and any previously accepted write SHALL be preserved.
9. THE_System SHALL support up to 500 concurrent Participants as an engineering target validated via load testing, and SHALL NOT claim 500-user support until a hosted configuration passes an agreed load test in which criteria 1 and 4 hold for 100 percent of sampled operations.

### Requirement 24: Accessibility and UX

**User Story:** As a Participant using a phone, I want mobile-first accessible screens, so that I can participate easily one-handed and with assistive technology.

#### Acceptance Criteria

1. THE Audience_Service SHALL render audience screens using a mobile-first layout that reflows without horizontal scrolling at viewport widths from 320 to 768 CSS pixels, and SHALL position all primary actions within the bottom 60 percent of the viewport height so they are reachable one-handed on a phone.
2. THE_System SHALL provide interactive touch targets of at least 44 by 44 CSS pixels, with at least 8 CSS pixels of spacing between adjacent targets.
3. THE_System SHALL provide keyboard navigation for all interactive controls on Administrator screens, following a logical tab order, with every focused element displaying a visible focus indicator having a contrast ratio of at least 3:1 against its adjacent background.
4. THE_System SHALL convey every status using at least one non-colour indicator (text label, icon, or shape) in addition to any colour used.
5. THE_System SHALL provide programmatically associated accessible labels for all form fields, interactive controls, and charts, such that each element exposes a non-empty accessible name to assistive technology.
6. WHERE a user has requested reduced motion at the operating-system or browser level, THE_System SHALL disable all non-essential animations and transitions and SHALL complete any remaining essential state change within 100 milliseconds.
7. WHEN a screen has no data to display, THE_System SHALL show an empty state with descriptive text; WHILE data is being retrieved, THE_System SHALL show a loading indicator; WHEN an operation completes successfully, THE_System SHALL show a success confirmation; and IF an operation fails, THEN THE_System SHALL show an error state with a message indicating the failure and a retry action.
8. THE_System SHALL ensure that no Participant_Identifier value is rendered in any user interface element, including text, attributes, tooltips, or chart data.
9. THE_System SHALL ensure that text and interactive-element foreground colours maintain a contrast ratio of at least 4.5:1 against their background for text smaller than 18 point and at least 3:1 for text 18 point or larger.

### Requirement 25: Routes and Screens

**User Story:** As a user in any role, I want role-appropriate routes and screens, so that I can access the capabilities relevant to my role.

#### Acceptance Criteria

1. THE_System SHALL provide an audience join route and an audience event-view route, where the event-view route renders the Q&A, polls, and word-cloud panels that are enabled for the current event.
2. WHEN an audience user navigates to the audience join route with a valid event identifier, THE_System SHALL display the join screen for that event within 3 seconds.
3. IF an audience user navigates to the audience join route or event-view route with a missing, malformed, or non-existent event identifier, THEN THE_System SHALL display an error message indicating the event was not found and SHALL NOT render the Q&A, polls, or word-cloud panels.
4. THE_System SHALL provide the following distinct Administrator routes: an Administrator authentication route, an admin dashboard, an event editor, a moderation queue, a poll editor, and a word-cloud editor.
5. THE_System SHALL provide a presenter view route that renders the presentation content for a specified event.
6. THE_System SHALL provide an AI provider configuration screen containing a connection-test panel and an export panel.
7. WHEN an Administrator activates the connection-test panel, THE_System SHALL display a result within 30 seconds indicating either connection success or connection failure with a message describing the failure reason.
8. IF an unauthenticated user requests any Administrator route other than the Administrator authentication route, THEN THE_System SHALL deny access, redirect the user to the Administrator authentication route, and SHALL NOT render the requested route's content.
9. WHILE an authenticated Administrator session is active, THE_System SHALL grant access to all Administrator routes.

### Requirement 26: Testing and Load Validation

**User Story:** As an engineering owner, I want defined automated, end-to-end, and load tests, so that correctness and capacity are verified before production.

#### Acceptance Criteria

1. THE_System SHALL include automated tests covering event status rules, question validation, moderation visibility, duplicate-vote prevention, poll response uniqueness and updates, word-cloud uniqueness and normalisation, and Administrator authorisation, where each listed behaviour has at least one passing test and at least one negative (rejection) test, and the automated test suite achieves a minimum of 80% line coverage across the modules implementing these behaviours.
2. THE_System SHALL include automated tests covering presenter-content visibility, AI failure handling, AI configuration authorisation, write-only credential behaviour, credential encryption or Secret_Reference handling, endpoint validation and allowlist enforcement, sanitisation of provider errors, and structured-output validation, where each listed behaviour has at least one passing test and at least one negative (rejection) test.
3. WHEN the automated test suite is executed, THE_System SHALL complete all tests without any test failures and produce a machine-readable results report indicating per-test pass or fail status.
4. THE_System SHALL include end-to-end tests for the following scenarios, each asserting the expected observable outcome: an Administrator creating and launching an event, a Participant joining and submitting a question, a Moderator approving and featuring a question, multiple Participants voting with updating counts, an Administrator opening a poll and receiving responses, an Administrator opening a word-cloud prompt and receiving responses, a Presenter switching modes, and an Administrator ending an event and exporting results.
5. THE_System SHALL include a load-test script simulating a configurable number of Participants (default 500 concurrent Participants) performing joining, concurrent question submissions, concurrent votes, poll responses, word-cloud responses, and presenter and moderator realtime subscriptions.
6. THE_System SHALL document the load-test configuration, identified bottlenecks, and measured limits, including for each simulated operation the median (P50) and 95th-percentile (P95) response times in milliseconds, the error rate as a percentage, and the maximum sustained concurrent-user count achieved.
7. IF a hosted configuration has not passed the agreed load test at 500 concurrent users with an error rate at or below 1% and a P95 response time at or below 2000 milliseconds, THEN THE_System SHALL NOT claim support for 500 concurrent users.

### Requirement 27: Scope Boundaries

**User Story:** As a product owner, I want out-of-scope items excluded from V1, so that the team focuses on delivering a tested core flow.

#### Acceptance Criteria

1. WHERE the deployment is designated V1, THE_System SHALL NOT expose or enable enterprise SSO or Entra ID integration, Teams integration, native mobile apps, multi-tenant or multi-organisation support, billing or subscriptions, participant accounts or profiles, or role-based access control beyond the two roles required for the core flow (event host and anonymous participant).
2. WHERE the deployment is designated V1, THE_System SHALL NOT expose or enable branching surveys, quizzes, scoring, timers, leaderboards, PowerPoint plug-ins, multilingual translation, or AI-generated answers to audience questions.
3. WHERE the deployment is designated V1, THE_System SHALL NOT expose or enable speaker evaluation, individual performance analysis, sentiment scoring of identifiable individuals, PDF or Word export, or enterprise analytics beyond the core event reporting defined for V1.
4. THE_System SHALL complete the core event flow (event creation, participant join, question or poll submission, and result display) end-to-end without invoking any external or internal AI service.
5. IF a request targets any V1-excluded capability listed in criteria 1 through 3, THEN THE_System SHALL reject the request, take no state-changing action, and return a response indicating the capability is not available in V1.
6. IF any AI service is unavailable, unreachable, or returns an error during a core event flow operation, THEN THE_System SHALL complete the core event flow operation successfully without degradation and without surfacing an AI-related error to the user.
