import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { fetchWaitingRenderedPage, type WaitingRenderedPage } from '@/lib/renderPageAnswer';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';

/**
 * The page the server holds for a waiting call sent by file, for a client that
 * has neither the call's input HTML nor its progress (it reloaded, or joined,
 * mid-wait). Fetched on mount and again when the server announces this call's
 * wait, which covers a reload between the call starting and its wait starting.
 * A 404 means nothing waits, so nothing shows: the call is settling and its
 * stored result will carry the page. Once the wait ends the held page stays,
 * so it does not vanish before that result arrives. A failed fetch keeps what
 * is held rather than clearing it.
 */
export function useWaitingPage(part: Pick<ToolPart, 'sessionID' | 'callID'>, enabled: boolean): WaitingRenderedPage | null {
    const announced = useGlobalBlockingRequestsStore((state) => (
        state.bySession.get(part.sessionID)?.pages.some((page) => page.id === part.callID) === true
    ));
    const [held, setHeld] = React.useState<WaitingRenderedPage | null>(null);
    // Set once the server has answered (a page, or 404), never by an aborted or
    // failed request: StrictMode's dev remount aborts the first fetch, and the
    // second mount must still load a call that never enters the store.
    const answered = React.useRef(false);
    React.useEffect(() => {
        if (!enabled) return undefined;
        // The wait ended after an answer: the stored result takes over.
        if (!announced && answered.current) return undefined;
        const controller = new AbortController();
        fetchWaitingRenderedPage({ sessionId: part.sessionID, callId: part.callID, signal: controller.signal }).then(
            (page) => {
                if (controller.signal.aborted) return;
                answered.current = true;
                setHeld(page);
            },
            () => undefined,
        );
        return () => controller.abort();
    }, [enabled, announced, part.sessionID, part.callID]);
    return enabled ? held : null;
}
