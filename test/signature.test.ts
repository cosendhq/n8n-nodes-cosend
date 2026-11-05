import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';

import { MAX_SKEW_SECONDS, verifyCosendSignature } from '../nodes/CosendTrigger/signature';

const SECRET = 'whsec_live_the_one_this_node_stored';
const ROTATED_IN = 'whsec_live_the_new_one_cosend_minted';

/** A fixed instant. Nothing here sleeps or reads the clock — see DECISIONS-WAVE-B §5. */
const NOW = 1_760_000_000;

const BODY = JSON.stringify({
	id: 'evt_01H8XK3M9PQRSTUVWXYZ01',
	object: 'event',
	type: 'message.received',
	data: { object: { id: 'msg_01H8XK3M9PQRSTUVWXYZ01' } },
});

/** A2 §7.3's construction: `v1 = HMAC-SHA256(secret, "{t}.{raw_body}")`. */
const hmac = (body: string, timestamp: number, secret: string) =>
	createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

const sign = (body: string, timestamp = NOW, ...secrets: string[]) =>
	[`t=${timestamp}`, ...secrets.map((secret) => `v1=${hmac(body, timestamp, secret)}`)].join(',');

describe('verifyCosendSignature', () => {
	it('accepts a correctly signed delivery', () => {
		expect(verifyCosendSignature(BODY, sign(BODY, NOW, SECRET), SECRET, NOW)).toBe(true);
	});

	// Catches: the HMAC never actually being compared — a verifier that parses the header, finds
	// a `v1`, and returns true.
	it('rejects a delivery signed with a different secret', () => {
		const forged = sign(BODY, NOW, 'whsec_live_an_attackers_guess');
		expect(verifyCosendSignature(BODY, forged, SECRET, NOW)).toBe(false);
	});

	// Catches: signing over the timestamp alone, or over a re-serialised body. Either way the
	// body stops being covered and anyone who can see one delivery can send any body they like.
	it('rejects a body that changed after it was signed', () => {
		const header = sign(BODY, NOW, SECRET);
		const tampered = BODY.replace('msg_01H8XK3M9PQRSTUVWXYZ01', 'msg_01H8XK3M9PQRSTUVWXYZ99');
		expect(verifyCosendSignature(tampered, header, SECRET, NOW)).toBe(false);
	});

	// Catches: a missing replay window. Without it a captured delivery is valid forever.
	it('rejects a delivery older than the replay window', () => {
		const stale = NOW - MAX_SKEW_SECONDS - 1;
		expect(verifyCosendSignature(BODY, sign(BODY, stale, SECRET), SECRET, NOW)).toBe(false);
	});

	it('accepts a delivery just inside the replay window', () => {
		const recent = NOW - MAX_SKEW_SECONDS + 1;
		expect(verifyCosendSignature(BODY, sign(BODY, recent, SECRET), SECRET, NOW)).toBe(true);
	});

	/**
	 * Catches: a one-sided skew check written as `now - t > MAX`.
	 *
	 * That form is the common mistake and it passes every test above. It accepts a timestamp
	 * arbitrarily far in the future — which is the value an attacker replaying a captured
	 * delivery would choose, because it never goes stale.
	 */
	it('rejects a delivery timestamped far in the future', () => {
		const future = NOW + MAX_SKEW_SECONDS + 1;
		expect(verifyCosendSignature(BODY, sign(BODY, future, SECRET), SECRET, NOW)).toBe(false);
	});

	/**
	 * Catches: checking only one `v1=` — the first, or (with `Object.fromEntries`) the last.
	 *
	 * Cosend's `signPayload` maps over every live secret, so a rotation puts two `v1=` values in
	 * the header, **current first**. The node stored the older one at `create` time, so it is the
	 * SECOND value that matches. A first-match-only verifier works perfectly until the first
	 * rotation and then rejects every delivery for the whole grace window.
	 */
	it('accepts a delivery during a secret rotation, when its match is not the first v1', () => {
		const rotating = sign(BODY, NOW, ROTATED_IN, SECRET);
		expect(rotating.match(/v1=/g)).toHaveLength(2);
		expect(verifyCosendSignature(BODY, rotating, SECRET, NOW)).toBe(true);
	});

	it('accepts a delivery during a rotation when its match is the first v1', () => {
		const rotating = sign(BODY, NOW, SECRET, ROTATED_IN);
		expect(verifyCosendSignature(BODY, rotating, SECRET, NOW)).toBe(true);
	});

	it('rejects a rotation header when none of the v1 values match', () => {
		const rotating = sign(BODY, NOW, ROTATED_IN, 'whsec_live_also_not_ours');
		expect(verifyCosendSignature(BODY, rotating, SECRET, NOW)).toBe(false);
	});

	it('rejects when the header or the stored secret is missing', () => {
		expect(verifyCosendSignature(BODY, undefined, SECRET, NOW)).toBe(false);
		expect(verifyCosendSignature(BODY, sign(BODY, NOW, SECRET), undefined, NOW)).toBe(false);
		expect(verifyCosendSignature(BODY, '', SECRET, NOW)).toBe(false);
	});

	it('rejects a malformed header', () => {
		for (const header of [
			'garbage',
			't=',
			`t=${NOW}`,
			'v1=deadbeef',
			`t=notanumber,v1=${hmac(BODY, NOW, SECRET)}`,
		]) {
			expect(verifyCosendSignature(BODY, header, SECRET, NOW)).toBe(false);
		}
	});

	// Catches: comparing hex strings of different lengths by padding or truncating. A truncated
	// signature must not be accepted as a prefix match.
	it('rejects a truncated signature', () => {
		const truncated = `t=${NOW},v1=${hmac(BODY, NOW, SECRET).slice(0, 32)}`;
		expect(verifyCosendSignature(BODY, truncated, SECRET, NOW)).toBe(false);
	});

	// Catches: verifying against a body the node re-printed. These two strings parse to the same
	// object and are different bytes, so only one of them can carry a valid signature.
	it('is sensitive to the exact bytes, not the parsed value', () => {
		const spaced = '{"a": 1}';
		const compact = '{"a":1}';
		expect(JSON.stringify(JSON.parse(spaced))).toBe(compact);

		const header = sign(spaced, NOW, SECRET);
		expect(verifyCosendSignature(spaced, header, SECRET, NOW)).toBe(true);
		expect(verifyCosendSignature(compact, header, SECRET, NOW)).toBe(false);
	});
});
