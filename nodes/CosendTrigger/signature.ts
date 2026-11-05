import { createHmac, timingSafeEqual } from 'crypto';

/** A2 §7.3's replay bound. A delivery signed more than this long ago is refused. */
export const MAX_SKEW_SECONDS = 300;

/**
 * Verify a Cosend webhook signature.
 *
 * A2 §7.3: `Cosend-Signature: t=<unix seconds>,v1=<hex hmac-sha256>`, where the signed payload is
 * `` `${t}.${rawBody}` ``. This is Stripe's scheme on purpose — every language already has a
 * snippet for it, and the timestamped payload construction is what resists replay.
 *
 * **THREE THINGS HERE ARE NOT OPTIONAL, AND DOC 03 §5.13's DRAFT GETS ALL THREE WRONG.**
 *
 * 1. **Every `v1=` is checked, not the first and not the last.** Cosend's `signPayload` maps over
 *    an array of secrets, so a header carries **one `v1=` per live secret** — and during a secret
 *    rotation there are two. The endpoint's secrets are ordered current-first, so a verifier that
 *    took the first match would work right up until a rotation and then reject every delivery
 *    signed with the secret this node actually stored. Doc 03's draft built the pairs with
 *    `Object.fromEntries`, which silently keeps the *last* duplicate key — the same bug wearing a
 *    different hat.
 *
 * 2. **`rawBody` must be the bytes as received.** Re-serialising a parsed body changes escaping,
 *    number formatting and key order, and the HMAC then never matches. The repo's own inbound
 *    verifier says the same thing about Meta's webhooks: "Re-serialising loses Meta's exact
 *    escaping and the HMAC will never" match. Callers pass the raw string; this function has no
 *    way to recover it if they do not.
 *
 * 3. **The skew check is two-sided.** `now - t > MAX` alone accepts a timestamp arbitrarily far in
 *    the *future*, which is exactly the value an attacker replaying a captured delivery would
 *    choose to make it live forever.
 *
 * `nowSeconds` is a parameter rather than a call to the clock so the tests name their own instant.
 * That is DECISIONS-WAVE-B §5's permanent fix — a timing assertion that sleeps and hopes gives a
 * different answer on a loaded machine, and three of those have already been found in this repo.
 */
export function verifyCosendSignature(
	rawBody: string,
	signatureHeader: string | undefined,
	secret: string | undefined,
	nowSeconds: number,
): boolean {
	if (!signatureHeader || !secret) return false;

	let timestamp: number | undefined;
	const candidates: string[] = [];

	for (const segment of signatureHeader.split(',')) {
		const separator = segment.indexOf('=');
		if (separator === -1) continue;
		const key = segment.slice(0, separator).trim();
		const value = segment.slice(separator + 1).trim();
		if (key === 't' && timestamp === undefined) timestamp = Number(value);
		// EVERY `v1`, not the first and not the last. See the banner above.
		else if (key === 'v1') candidates.push(value);
	}

	if (timestamp === undefined || !Number.isFinite(timestamp) || candidates.length === 0) {
		return false;
	}
	// Two-sided, so a future-dated replay is refused as firmly as a stale one.
	if (Math.abs(nowSeconds - timestamp) > MAX_SKEW_SECONDS) return false;

	const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
	const expectedBuffer = Buffer.from(expected, 'utf8');

	let matched = false;
	for (const candidate of candidates) {
		const candidateBuffer = Buffer.from(candidate, 'utf8');
		// `timingSafeEqual` throws on a length mismatch, so the length is compared first — and a
		// length difference is not secret, it is visible in the header.
		if (candidateBuffer.length !== expectedBuffer.length) continue;
		// Not short-circuited: every candidate is compared even after a match, so the number of
		// comparisons does not depend on WHICH secret signed the delivery.
		if (timingSafeEqual(expectedBuffer, candidateBuffer)) matched = true;
	}

	return matched;
}
