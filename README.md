# n8n-nodes-cosend

WhatsApp automation for n8n, powered by [Cosend](https://cosend.app).

[![npm version](https://img.shields.io/npm/v/n8n-nodes-cosend.svg)](https://www.npmjs.com/package/n8n-nodes-cosend)
[![npm downloads](https://img.shields.io/npm/dm/n8n-nodes-cosend.svg)](https://www.npmjs.com/package/n8n-nodes-cosend)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## What this does

This package adds two nodes to n8n. **Cosend** sends WhatsApp messages and manages the contacts,
conversations, automations and usage behind them. **Cosend Trigger** starts a workflow the moment
something happens on your WhatsApp number: a message arrives, a delivery status changes, or the
24-hour reply window is about to close.

Cosend runs on WhatsApp Coexistence, so the number you already use in the WhatsApp Business app
keeps working while your automations run alongside it. That is why the trigger can tell you when
**the owner replied from their own phone**, an event that only Coexistence makes possible.

The **Cosend** node declares `usableAsTool`, so n8n's AI Agent nodes can call its operations as
tools. It works on every Cosend plan, including Free.

## Installation

Install it by name from Settings → Community nodes. n8n's
[community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
covers each step.

**From settings.** An owner or admin of the n8n instance opens **Settings → Community nodes →
Install a community node**, enters `n8n-nodes-cosend`, and clicks **Install**. Everyone on the
instance can then use it.

**Self-hosted.** Two environment variables decide whether that is possible, and both default to
enabled: `N8N_COMMUNITY_PACKAGES_ENABLED` turns community nodes on, and
`N8N_UNVERIFIED_PACKAGES_ENABLED` allows installing ones outside n8n's verified list. If your
instance sets either to `false`, that is an instance policy the package cannot change.

## Credentials

<a id="credentials"></a>

1. Sign in at [dashboard.cosend.app](https://dashboard.cosend.app).
2. Go to **Settings → API Keys**.
3. Click **Create key**, name it (for example `n8n`), and copy the key. **It is shown once.**
4. In n8n, add a **Cosend API** credential and paste the key.
5. Click **Test**. A green tick means the key is real. The test calls Cosend's identity endpoint,
   which never fails for lack of permissions, so a red one means the key itself is wrong.

**Which key to create.** A **workspace key** (`cok_live_…`) reaches every WhatsApp number in your
workspace; use one when a workflow spans several numbers. A **connection key** (`csk_live_…`) is
scoped to a single number; prefer it when the workflow is about one number.

Use a `cok_test_…` or `csk_test_…` key while you build. The key sets the mode, so the node needs
no test switch, and test traffic does not count towards your usage.

**Base URL** defaults to `https://api.cosend.app/v1`. Change it only to point at a Cosend staging
host.

**API key credentials.** A workflow runs unattended, so the credential here is a long-lived,
revocable API key.

## Example workflows

Three ready-to-import workflows live in [`templates/`](./templates), each with sticky notes that
walk you through setup on the canvas:

- [**Google Sheets to WhatsApp**](./templates/google-sheets-to-whatsapp.json): every 5 minutes,
  send an approved template to each new row of a sheet, then write **sent** or **failed** back
  into the row.
- [**Receive WhatsApp messages**](./templates/receive-whatsapp-messages.json): reply by keyword,
  and pass every other message to your team in the Cosend inbox.
- [**WhatsApp AI agent**](./templates/whatsapp-ai-agent.json): n8n's AI Agent answers each
  message, remembers the chat, and passes it to a person when the customer asks for one.

[`templates/README.md`](./templates/README.md) explains how to import them and what each one needs.

A first workflow by hand takes two nodes. Add **Cosend Trigger** with the event **Message
Received**, then a **Cosend** node set to **Message → Send**, with **Send To** set to
**Conversation** and the conversation ID taken from the trigger: `{{ $json.conversation_id }}`.
Every message your number receives now gets that reply.

## Operations

### Message

| Operation | What it does |
|---|---|
| Send | Send one WhatsApp message per input item: text, media, template, interactive, location or contact cards. Media comes from a binary field, a URL or a media ID |
| Send Batch | Send every input item in one request, up to 100 at a time, with a per-item result |
| Get | Retrieve one message by its Cosend ID or its WhatsApp message ID |
| Get Many | List messages, filtered by conversation, contact, WhatsApp number, direction, source or status |
| Mark as Read | Put blue ticks on the contact's phone |
| React | Add an emoji reaction, or clear the one already there |

### Contact

| Operation | What it does |
|---|---|
| Create | Add a contact. If the phone number already has one on that WhatsApp number, you get it back unchanged |
| Create or Update | The upsert: find the contact by phone number and update it, or create it if there is none, with no IF node in front |
| Get | One contact, by ID, phone number or WhatsApp business-scoped ID |
| Get Many | List contacts, filtered by search text, tags or WhatsApp number |
| Update | Change name, attributes, tags, locale, timezone or blocked state. Tags set here replace the contact's whole list |
| Add Tags | Add tags to a contact; the tags it already has stay |
| Remove Tags | Take tags off a contact; the others stay |
| Delete | Remove a contact |

### Conversation

| Operation | What it does |
|---|---|
| Get | One conversation, with its messaging-window and lock state |
| Get Many | List conversations, filtered by state, control, assignee, WhatsApp number, label or unread |
| Update | Change state, assignee, labels or snooze time. Closing a conversation is Update with a state of Resolved |
| Set Control | Hand a conversation from the assistant to a person |
| Mark as Read | Clear the unread count in the Cosend inbox |
| Add Note | Attach an internal note your team sees and the contact never does |
| Update Note | Change the text of a note; who it mentions stays as it was. Only the person who wrote it can |
| Delete Note | Remove a note. The person who wrote it, or an owner or admin, can |

A conversation opens with its first message.

- **Handover goes one way.** `Set Control` hands a conversation from the assistant to a person, as
  `Human` or `Passed to a Person`.
- **`On Phone` is observed, never set.** Cosend records it when the owner replies from their
  phone. You can *filter* conversations by it; you cannot assign it.

### Automation

| Operation | What it does |
|---|---|
| Trigger | Start one run of an automation, with a payload of your own |
| Get Many | List your automations, with how each one ran today |
| Get Run | One run: its state, when it started and finished, and why it stopped |
| Get Run Events | The step-by-step trace of a run, so a failing automation is debuggable from inside n8n |

### Usage

| Operation | What it does |
|---|---|
| Get | One billing period's usage: each meter's count and what your plan includes, so a workflow can react to its own consumption |

### Notification

| Operation | What it does |
|---|---|
| Send | Queue one notification. Cosend picks free-form text or an approved template depending on whether the 24-hour window is open, can schedule it, deduplicates it on a key, and **expires it rather than delivering it late** |

### Schedule

| Operation | What it does |
|---|---|
| Create | Set up a ladder of reminders around one appointment (for example 24 hours and 2 hours before), with a timezone, a daylight-saving policy and optional quiet hours |

- **Schedules are anchored.** `Schedule → Create` builds an anchored ladder: one appointment plus
  offsets.

### Workspace

| Operation | What it does |
|---|---|
| Get | The calling credential, its workspace, plan and limits |

### Simplify and Output

Every Get and Get Many that returns a message, conversation, contact, automation, run or run event
has **Simplify**, on by default: it returns at most ten flat fields, the most useful first, with
the ID among them. Turn it off for the record exactly as Cosend sends it.

When an AI Agent uses the node as a tool, the same operations have **Output** instead:
**Simplified**, **Raw**, or **Selected Fields**, which returns only the fields you pick, plus the
ID.

Simplify and Output come with node version 1.1. A workflow built on version 1 keeps returning the
full record, so nothing changes under it.

## Trigger events

**Cosend Trigger** registers a webhook with Cosend when the workflow is activated and removes it
when the workflow is deactivated; you never paste a URL anywhere. Cosend delivers only the events
you pick. If the webhook has gone missing on Cosend's side, activation recreates it; if its URL or
its events no longer match the workflow, it is replaced rather than left pointing somewhere stale.

| Event | Fires when |
|---|---|
| Message Received | A contact sends you a WhatsApp message |
| **Message Echo** | **The owner replies from the WhatsApp Business app on their phone.** Coexistence only. Use it to stop a workflow following up when a human already answered |
| Message Sent | Cosend accepted a message to send |
| Message Status Changed | An outgoing message was sent, delivered, read or failed |
| Conversation Created | A new conversation thread opened |
| Conversation Updated | State, assignee, control or labels changed |
| **Conversation Window Expiring** | **The 24-hour window closes in one hour.** It turns the most common WhatsApp integration bug into an event |
| Conversation Lock Changed / Lock Requested / Lock Request Resolved | A team member took, released, asked for or was given control |
| Note Created / Updated / Deleted | An internal note changed. The event carries the note's IDs, not its text |
| Contact Created / Updated / Consent Changed | A contact was added, changed, opted in or opted out |
| Automation Run Started / Finished / Failed | An automation run began or reached its end |
| Automation Switched Off | Cosend switched an automation off by itself, and says why |
| Approval Requested / Decided | An automation is waiting on someone's approval, or got it |
| Number Connected / Disconnected / Needs Reconnecting | Your WhatsApp number changed state |
| Number Quality Changed / Messaging Limit Changed | Meta changed the number's quality rating or messaging limit |
| Onboarding Progress / Completed / Failed | A customer moved through connecting their number |
| Notification Sent / Delivered / Failed / Expired | A queued notification reached a terminal state |
| Template Status Changed | Meta approved, rejected or paused one of your templates |
| Usage Threshold Reached | A meter reached 80% or 100% of what your plan includes |

**Every delivery is signed.** The node checks the `Cosend-Signature` header (HMAC-SHA256 over the
raw body, compared in constant time) before it does anything else, and refuses a delivery signed
more than five minutes ago. A delivery that fails the check gets a `401` and starts no workflow.
A test delivery from the dashboard (`ping`) is answered and starts no workflow either.

**Simplify** is on by default and emits the event name with the resource in the same simplified
shape a `Cosend → Get` node returns, at most ten fields, so one workflow can parse both. Turn it
off for the full event envelope, including `previous_attributes` on update events. A trigger built
on version 1 keeps its earlier Simplify: the whole resource with the event name attached.

**WhatsApp Number** picks the number the trigger listens to, from a list. Leave it empty to
listen to every number the key reaches.

**Filters run on Cosend's server.** The trigger registers them with its webhook, and Cosend
delivers only the events that match, so an event a filter leaves out never starts an execution.
Each filter applies to its own events and lets every other event through:

| Filter | Applies to | Keeps the event when |
|---|---|---|
| Message Types | Message events, sent messages and status changes included | The message is one of these kinds (pick Template to keep the status changes of template sends) |
| Statuses | Message Status Changed | The status is one of these |
| Labels | Message and conversation events | The conversation carries at least one of these labels |
| Assignee IDs | Message and conversation events | The conversation is assigned to one of these team members |
| Automation IDs | Automation and approval events | The run or approval belongs to one of these automations |
| **Ignore Messages Sent by Me** (on by default) | Message Sent, Message Status Changed | The message was not sent with this credential's API key, so a workflow that sends a message does not start itself again. The status changes of those messages are left out too: turn it off to track their delivery |

**Include Contact** is on by default: conversation events then carry the conversation's contact,
the same object a `Cosend → Contact → Get` returns. Message events always carry theirs.

Changing a filter or Include Contact replaces the webhook on the next activation, the way changing
the events does.

### If your n8n cannot receive webhooks

A self-hosted n8n behind NAT with no public URL cannot be reached by Cosend, and the trigger will
tell you so rather than activating into silence. Two ways round it:

- n8n Cloud, a tunnel, or any reverse-proxied instance works as-is: set `WEBHOOK_URL` to the
  public address.
- Otherwise, register an outbound webhook in the Cosend dashboard pointing at n8n's built-in
  **Webhook** node, and use the Cosend node for the sending half. Signature verification then
  runs in your own workflow, if you add it.

## Errors

A failed operation carries Cosend's own explanation, and a stopped node names the item it stopped
on, for example `[item 2]`.

- **On Error → Continue** keeps the failed item in the output, with `error` (what happened),
  `code` (the code in [the error reference](https://cosend.app/docs/errors)), `request_id` (the
  one to quote to Cosend support) and, for the common cases, `hint`: what to do next.
- **On Error → Continue (using error output)** sends each failed item to the node's error output,
  and the items that worked to the success output. The failed item keeps the input item's fields
  and adds `error`, with `code`, `request_id` and `hint` under `details`. n8n sends an item to the
  error output only when its own fields are `error` and `details`, which is why they sit there.
- When the node stops on an error instead, the same `code` and `request_id` are on the error's
  context.

## Compatibility

| | |
|---|---|
| `n8n-workflow` | v2 or later, the peer dependency n8n provides. Built and tested against 2.35. |
| Cosend API | `v1` |
| Runtime dependencies | **none** |

## WhatsApp rules to know

WhatsApp sets these rules, and the node is built around them.

- **The 24-hour service window.** You may send free-form messages only within 24 hours of the
  contact's last message to you. After that only a template Meta has approved will go out. The
  `Send Mode` option can fall back to a template automatically; **Conversation Window Expiring**
  lets you act before the window shuts.
- **Template approval.** Templates are approved by Meta, not by Cosend, and approval takes as long
  as it takes. A template waiting for approval is listed in the picker with its status, so
  you can see why a send failed.
- **A template name is not unique.** The same name exists once per language, so `Language` is
  required alongside it.
- **Opt-out is final until the contact writes again.** WhatsApp does not allow sending to a contact
  who opted out.

## Resources

- [Cosend n8n documentation](https://cosend.app/docs/n8n)
- [The trigger, in detail](https://cosend.app/docs/n8n/trigger)
- [Cosend API reference](https://cosend.app/docs/api)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Report an issue](https://github.com/cosendhq/n8n-nodes-cosend/issues)

## Development

```sh
pnpm install          # install
pnpm lint             # the full n8n community-node lint stack
pnpm test             # vitest
pnpm typecheck        # tsc
pnpm build            # compile to dist/
pnpm dev              # a local n8n at http://localhost:5678 with this node linked in
pnpm sync-contract    # regenerate test/fixtures/contract.json from cosend-api's packages/contracts
```

`test/fixtures/contract.json` is generated, never hand-edited: run `pnpm contracts` in cosend-api,
then `pnpm sync-contract` here. `test/contract.test.ts` fails if this node offers an operation the
API does not have, fails to offer one the API marks for n8n, or sends a field the API does not
declare.

## Licence

MIT. See [LICENSE](./LICENSE).

**Cosend and the Cosend logo are trademarks of True North Tech Group LLC. The MIT licence covers
the source code in this repository, not the marks.**
