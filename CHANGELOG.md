# Changelog

All notable changes to `n8n-nodes-cosend` are documented here. This project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2026.11.0] - 2026-11-05

Versions are date-based from this release: `YYYY.M.N`, the year, the month and that month's
release number. Each one is a valid semantic version.

### Changed

- **README:** installing from Settings → Community nodes leads the Installation section; the
  rules WhatsApp sets have their own section, "WhatsApp rules to know"; the handover and `App`
  control notes sit with Conversation, the schedule note with Schedule, and the OAuth2 note with
  Credentials.
- **Set Control:** the `Pending Human` option now reads "The automation passed this to a person."

## [0.2.0] — 2026-10-28

The first version published to npm (0.1.0 below was never published). It does what
[cosend.app/n8n](https://cosend.app/n8n) and the [n8n docs pages](https://cosend.app/docs/n8n)
say.

### Added

- **Contact: Add Tags and Remove Tags.** They add or take off only the tags named, so two
  workflows tagging one contact no longer lose each other's tags the way two Updates can.
- **Trigger filters run on Cosend's server**: Message Types, Statuses, Labels, Assigned Agent IDs,
  Automation IDs and Ignore Messages Sent by Me (on by default; leaves out messages sent with this
  credential's API key). Cosend delivers only the events that match, so a filtered-out event
  starts no execution.
- **Include Contact** (on by default): conversation events carry the conversation's contact.
- **Automation** resource: Trigger (start a run, with a payload), Get Many, Get Run and Get Run
  Events — the per-step trace, so a failing automation is debuggable from inside n8n.
- **Usage** resource: Get, so a workflow can react to its own consumption.
- **Contact: Create or Update** (the upsert; n8n's linter fixes the name) — finds the contact by
  phone number and writes the fields, or creates it. One request for a new contact, two for an
  existing one.
- **Trigger events**: Automation Run Started / Finished / Failed, Automation Switched Off, Approval
  Requested / Decided, Usage Threshold Reached, Connection Quality Changed / Messaging Limit
  Changed, Conversation Lock Request Resolved, and Note Created / Updated / Deleted — 36 events in
  all, every one Cosend emits.
- **Errors carry Cosend's `code` and `request_id`.** On an error the node stops with the API's own
  message, the code and request ID on the error's context; with On Error → Continue the item has
  `error`, `code`, `request_id` and a `hint`. Declarative operations included.
- The drift test now holds every field the node sends to the field names the API's schemas declare,
  and every route that requires `Idempotency-Key` to an operation that sends it.

### Changed

- **Contact: Create** says what it does: an existing contact comes back unchanged. Create or Update
  is the operation that updates.
- **The trigger replaces a stale webhook.** When the workflow's URL, events, filters or Include
  Contact changed, activation registers the new endpoint and then deletes the old one in Cosend;
  it used to leave it delivering. If the old one cannot be deleted, activation says so and tries
  again next time.
- **The node no longer filters deliveries itself.** Message Types and Statuses used to be checked
  in n8n after Cosend had delivered the event; they are now the webhook's filters, applied by
  Cosend.
- "Organization" is "Workspace" everywhere the node shows it — the resource, the key, the errors.
  The resource's value is still `me`, so saved workflows are unchanged.
- The credential's Base URL help says to change it only for a staging host.
- `scripts/sync-contract.mjs` reads `packages/contracts/generated` rather than the route table
  directly.

### Fixed

- **Send's error output had no `code`, and Send, Send Batch and the trigger showed n8n's generic
  error text instead of Cosend's.** n8n throws a `NodeApiError` around axios's error, with the
  response body at `cause.response.data`; the node read `response.body` and wrapped the
  `NodeApiError` again, which n8n hands back unchanged. Both are now read the way n8n-core throws
  them.

## [0.1.0] — 2026-08-28

The first release. Everything below ships in it; publication to npm happens from the
production-deployment list (the `*.*.*` tag push that `.github/workflows/publish.yml` answers).

### Added

- **Cosend** action node — 20 operations across six resources: Message (send, send batch, get, get
  many, mark as read, react), Conversation (get, get many, update, set control, mark as read, add
  note), Contact (create, get, get many, update, delete), Notification (send), Schedule (create) and
  Organization (get). Declarative throughout, with `customOperations` for `Send` (binary attachments
  upload first) and `Send Batch` (many items, one request, per-item results mapped back by index).
- **Cosend Trigger** node — a signed webhook trigger over 23 events, with a complete
  `checkExists` / `create` / `delete` lifecycle.
- **Cosend API** credential — organization or connection key, with a credential test against
  `GET /v1/me`.
- `test/fixtures/contract.json`, generated from cosend-api's route table by
  `scripts/sync-contract.mjs`, and a drift test that fails if this node offers an operation the API
  does not have or omits one it marks for n8n.
- `.github/workflows/publish.yml` — publishes to npm with provenance on a version-tag push, as n8n
  verification requires. Scaffolded by `n8n-node release --init-workflow`, then repaired: the
  scaffolder's handlebars pass swallows `${{ secrets.NPM_TOKEN }}`, and GitHub's runners need a
  `pnpm/action-setup` step before `setup-node` can use `cache: 'pnpm'`.
- `scripts/verify-install.mjs` — loads a packed-and-installed tarball the way n8n's package loader
  does and proves every declared operation is runnable. It runs from a directory where the tarball
  is installed; see the file's header.

### Publication status

Never published. 0.2.0 is the first version on npm.
