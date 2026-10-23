import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '../../../session/sidebar/test-utils/testDom';
import { applyWaitingPageEvent, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';

type Pending = {
    query: Record<string, string>;
    signal: AbortSignal;
    settle: (response: Response) => void;
};

let requests: Pending[] = [];

// Every request stays open until the test settles it, and rejects when its
// signal aborts, like a real fetch.
mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: (_path: string, init: { query: Record<string, string>; signal: AbortSignal }) => new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal.aborted) abort();
        init.signal.addEventListener('abort', abort);
        requests.push({ query: init.query, signal: init.signal, settle: resolve });
    }),
}));

const { useWaitingPage } = await import('./useWaitingPage');

const page = (html: string) => new Response(JSON.stringify({ html, title: 'Pick' }));
const notWaiting = () => new Response(JSON.stringify({ error: 'No page is waiting' }), { status: 404 });

const part = { sessionID: 'ses_1', callID: 'call_1' };

let latest: ReturnType<typeof useWaitingPage> = null;

const Probe = ({ enabled = true, target = part }: { enabled?: boolean; target?: typeof part }) => {
    latest = useWaitingPage(target, enabled);
    return null;
};

const announce = (type: 'openchamber.page-waiting' | 'openchamber.page-settled') => {
    applyWaitingPageEvent(
        type === 'openchamber.page-waiting'
            ? { type, properties: { sessionID: 'ses_1', directory: '/repo', page: { id: 'call_1', title: 'Pick' } } }
            : { type, properties: { sessionID: 'ses_1', pageID: 'call_1' } },
        () => '/repo',
    );
};

const settle = async (index: number, response: Response) => {
    await act(async () => {
        requests[index]?.settle(response);
        await Promise.resolve();
    });
};

describe('useWaitingPage', () => {
    let dom: ReturnType<typeof installHookTestDom>;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        dom = installHookTestDom();
        root = createRoot(dom.container);
        requests = [];
        latest = null;
        resetGlobalBlockingRequests();
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        resetGlobalBlockingRequests();
        dom.restore();
    });

    test('fetches the held page of the call on mount, and returns it', async () => {
        await act(async () => root.render(<Probe />));
        expect(requests).toHaveLength(1);
        expect(requests[0]?.query).toEqual({ sessionId: 'ses_1', callId: 'call_1' });
        expect(latest).toBeNull();
        await settle(0, page('<p>a</p>'));
        expect(latest).toEqual({ html: '<p>a</p>', title: 'Pick' });
    });

    test('does not fetch while the call has its html', async () => {
        await act(async () => root.render(<Probe enabled={false} />));
        expect(requests).toHaveLength(0);
        expect(latest).toBeNull();
    });

    test('fetches again when the call announces its wait, after an earlier 404', async () => {
        await act(async () => root.render(<Probe />));
        await settle(0, notWaiting());
        expect(latest).toBeNull();
        expect(requests).toHaveLength(1);

        await act(async () => announce('openchamber.page-waiting'));
        expect(requests).toHaveLength(2);
        await settle(1, page('<p>b</p>'));
        expect(latest).toEqual({ html: '<p>b</p>', title: 'Pick' });
    });

    test('ignores the wait of another call', async () => {
        await act(async () => root.render(<Probe />));
        await settle(0, notWaiting());
        await act(async () => applyWaitingPageEvent(
            { type: 'openchamber.page-waiting', properties: { sessionID: 'ses_1', directory: '/repo', page: { id: 'call_2', title: 'Other' } } },
            () => '/repo',
        ));
        expect(requests).toHaveLength(1);
    });

    test('keeps the held page when the wait settles, with no fetch loop', async () => {
        await act(async () => announce('openchamber.page-waiting'));
        await act(async () => root.render(<Probe />));
        expect(requests).toHaveLength(1);
        await settle(0, page('<p>a</p>'));

        await act(async () => announce('openchamber.page-settled'));
        expect(requests).toHaveLength(1);
        expect(latest).toEqual({ html: '<p>a</p>', title: 'Pick' });

        // A later render changes nothing either.
        await act(async () => root.render(<Probe />));
        expect(requests).toHaveLength(1);
    });

    test('a failed fetch keeps what is held', async () => {
        await act(async () => root.render(<Probe />));
        await settle(0, page('<p>a</p>'));
        await act(async () => announce('openchamber.page-waiting'));
        await settle(1, new Response('{}', { status: 500 }));
        expect(latest).toEqual({ html: '<p>a</p>', title: 'Pick' });
    });

    test('a 404 after a held page clears it', async () => {
        await act(async () => root.render(<Probe />));
        await settle(0, page('<p>a</p>'));
        await act(async () => announce('openchamber.page-waiting'));
        await settle(1, notWaiting());
        expect(latest).toBeNull();
    });

    test('unmounting aborts the request', async () => {
        await act(async () => root.render(<Probe />));
        expect(requests[0]?.signal.aborted).toBe(false);
        await act(async () => root.render(null));
        expect(requests[0]?.signal.aborted).toBe(true);
    });

    test('an aborted first fetch does not count as an answer: the next mount fetches', async () => {
        // StrictMode's dev double mount, as one effect cycle: mount, abort, mount.
        await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests[0]?.signal.aborted).toBe(true);
        const last = requests.length - 1;
        expect(requests[last]?.signal.aborted).toBe(false);
        await settle(last, page('<p>a</p>'));
        expect(latest).toEqual({ html: '<p>a</p>', title: 'Pick' });
    });

    test('a response that arrives after its request was aborted is dropped', async () => {
        await act(async () => root.render(<Probe />));
        await act(async () => root.render(<Probe target={{ sessionID: 'ses_2', callID: 'call_9' }} />));
        expect(requests).toHaveLength(2);
        expect(requests[0]?.signal.aborted).toBe(true);
        await settle(0, page('<p>stale</p>'));
        expect(latest).toBeNull();
        await settle(1, page('<p>fresh</p>'));
        expect(latest).toEqual({ html: '<p>fresh</p>', title: 'Pick' });
    });
});
