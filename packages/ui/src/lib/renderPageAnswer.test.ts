import { beforeEach, describe, expect, mock, test } from 'bun:test';

type FetchInit = { method?: string; query?: { sessionId: string; callId: string }; signal?: AbortSignal };
type FetchCall = { path: string; init: FetchInit | undefined };
type ServerBody = { html?: string | number; title?: string | number; error?: string } | null;

let calls: FetchCall[] = [];
let respond: () => Response = () => new Response('{}');

mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: async (path: string, init?: FetchInit) => {
        calls.push({ path, init });
        return respond();
    },
}));

const { fetchWaitingRenderedPage } = await import('./renderPageAnswer');

const json = (body: ServerBody, status = 200) => () => new Response(JSON.stringify(body), { status });

describe('fetchWaitingRenderedPage', () => {
    beforeEach(() => {
        calls = [];
        respond = () => new Response('{}');
    });

    test('asks for the held page of the call, with the caller\'s signal', async () => {
        respond = json({ html: '<p>a</p>', title: 'Pick' });
        const controller = new AbortController();
        const page = await fetchWaitingRenderedPage({ sessionId: 'ses_1', callId: 'call_1', signal: controller.signal });
        expect(page).toEqual({ html: '<p>a</p>', title: 'Pick' });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.path).toBe('/api/openchamber/render/page');
        expect(calls[0]?.init?.query).toEqual({ sessionId: 'ses_1', callId: 'call_1' });
        expect(calls[0]?.init?.signal).toBe(controller.signal);
        expect(calls[0]?.init?.method).toBeUndefined();
    });

    test('answers null when nothing waits (404)', async () => {
        respond = json({ error: 'No page is waiting' }, 404);
        expect(await fetchWaitingRenderedPage({ sessionId: 'ses_1', callId: 'call_1' })).toBeNull();
    });

    test('throws on any other failure, so it is never mistaken for "nothing waits"', async () => {
        for (const status of [400, 401, 500, 502]) {
            respond = json({ error: 'nope' }, status);
            await expect(fetchWaitingRenderedPage({ sessionId: 'ses_1', callId: 'call_1' })).rejects.toThrow(String(status));
        }
    });

    test('throws on a body that is not a page', async () => {
        for (const body of [{}, { html: 7 }, { title: 'x' }, null]) {
            respond = json(body);
            await expect(fetchWaitingRenderedPage({ sessionId: 'ses_1', callId: 'call_1' })).rejects.toThrow();
        }
        respond = () => new Response('not json');
        await expect(fetchWaitingRenderedPage({ sessionId: 'ses_1', callId: 'call_1' })).rejects.toThrow();
    });

    test('falls back to an empty title when the server sends no usable one', async () => {
        respond = json({ html: '<p>a</p>', title: 5 });
        expect(await fetchWaitingRenderedPage({ sessionId: 'ses_1', callId: 'call_1' })).toEqual({ html: '<p>a</p>', title: '' });
    });
});
