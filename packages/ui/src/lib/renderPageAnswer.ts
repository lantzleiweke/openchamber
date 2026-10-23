import { z } from 'zod';

import type { JsonValue } from '@/lib/opencode/model';
import { runtimeFetch } from './runtime-fetch';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });
const waitingPageSchema = z.object({ html: z.string(), title: z.string().catch('') });

/** The page the server holds for a waiting call: what a client that missed the call's progress draws. */
export type WaitingRenderedPage = z.infer<typeof waitingPageSchema>;

/**
 * Sends the user's answer to a page an agent is waiting on (render.page with
 * awaitAnswer). The agent's call is found by its session and call id; a page
 * that no longer waits, because it was answered elsewhere or its turn ended,
 * is refused with the server's message.
 */
export async function answerRenderedPage(input: {
    sessionId: string;
    callId: string;
    summary: string;
    data: JsonValue;
}): Promise<void> {
    const response = await runtimeFetch('/api/openchamber/render/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    if (response.ok) return;
    const payload = errorSchema.parse(await response.json().catch(() => null));
    throw new Error(payload.error || `The answer was not delivered (${response.status})`);
}

/**
 * Fetches the page the server holds for a call that waits for the user's
 * answer. A call sent by file has no HTML in its stored input, and OpenCode's
 * copy of a running call has no metadata, so a client that reloaded or joined
 * mid-wait gets the page here. `null` means nothing waits: the call has
 * settled and its stored result carries the page. Any other failure throws,
 * so a caller never mistakes it for "nothing waits".
 */
export async function fetchWaitingRenderedPage(input: {
    sessionId: string;
    callId: string;
    signal?: AbortSignal;
}): Promise<WaitingRenderedPage | null> {
    const response = await runtimeFetch('/api/openchamber/render/page', {
        query: { sessionId: input.sessionId, callId: input.callId },
        signal: input.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The page was not loaded (${response.status})`);
    return waitingPageSchema.parse(await response.json());
}
