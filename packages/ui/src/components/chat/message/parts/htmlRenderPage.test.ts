import { beforeEach, describe, expect, test } from 'bun:test';
import { Window, type Event as HappyEvent, type Node as HappyNode, type Range as HappyRange } from 'happy-dom';

import { locateChatQuote } from '@/lib/chatQuoteAnchor';

import {
    buildHtmlRenderDocument,
    htmlRenderClearSelectionMessage,
    htmlRenderMarksMessage,
    htmlRenderRevealMessage,
    htmlRenderSubmitReply,
    readHtmlRenderFrameMessage,
    type HtmlRenderAnswerState,
    type HtmlRenderTheme,
} from './htmlRender';

/**
 * Runs the bootstrap a page really gets, in a DOM whose parent is a stub, to
 * check what no string match can: that the page measures anchors the way the
 * chat does, finds them again, and answers the host's messages.
 */

const theme: HtmlRenderTheme = { appearance: 'light', variables: { '--background': '#fff' } };

type FrameReport = ReturnType<typeof readHtmlRenderFrameMessage>;

const BODY = '<p>Use <strong>bold</strong> text here.</p><p>fix it now</p><p>then fix it later</p>';

const settle = () => new Promise((resolve) => setTimeout(resolve, 260));

const mountPage = (answerState?: HtmlRenderAnswerState) => {
    const win = new Window({ url: 'http://localhost' });
    // What the page posted, as the host reads it, and as JSON.
    const reports: FrameReport[] = [];
    const sent: string[] = [];
    const parent = new Window({ url: 'http://localhost' });
    parent.postMessage = (data: MessageEvent['data']) => {
        sent.push(JSON.stringify(data));
        reports.push(readHtmlRenderFrameMessage({ data }));
    };
    Object.defineProperty(win, 'parent', { value: parent, configurable: true });
    // happy-dom has no CSS Custom Highlight API; a recording stand-in.
    const highlights = new Map<string, HappyRange[]>();
    class FakeHighlight extends Set<HappyRange> {
        // The real one takes its ranges as arguments.
        constructor(...ranges: HappyRange[]) { super(ranges); }
    }
    const customHighlights = {
        set: (name: string, highlight: Set<HappyRange>) => { highlights.set(name, [...highlight]); },
        delete: (name: string) => { highlights.delete(name); },
    };
    const css = { highlights: customHighlights };
    Object.defineProperty(win, 'Highlight', { value: FakeHighlight, configurable: true });
    Object.defineProperty(win, 'CSS', { value: css, configurable: true });
    const source = buildHtmlRenderDocument(`<!doctype html><html><head></head><body>${BODY}</body></html>`, theme, { answerState });
    // The bootstrap and the answer script, in the order the page runs them.
    const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join(';');
    if (!script) throw new Error('no bootstrap');
    const answerJson = /<script type="application\/json" id="oc-html-render-answer">[\s\S]*?<\/script>/.exec(source)?.[0] ?? '';
    win.document.body.innerHTML = BODY;
    win.document.head.innerHTML = `<style id="oc-html-render-theme"></style>${answerJson}`;
    // happy-dom does not run a script the test appends, so the scripts run
    // with the page's globals passed in by name.
    const globals = {
        window: win,
        document: win.document,
        navigator: win.navigator,
        CSS: css,
        Highlight: FakeHighlight,
        MutationObserver: win.MutationObserver,
        ResizeObserver: win.ResizeObserver,
        getComputedStyle: win.getComputedStyle.bind(win),
        requestAnimationFrame: win.requestAnimationFrame.bind(win),
        setTimeout: win.setTimeout.bind(win),
        clearTimeout: win.clearTimeout.bind(win),
        URL: win.URL,
    };
    const run = (code: string) => new Function(...Object.keys(globals), code)(...Object.values(globals));
    run(script);
    const send = (data: MessageEvent['data']) => {
        win.dispatchEvent(new win.MessageEvent('message', { data, source: parent }));
    };
    const select = (text: string, occurrence = 0) => {
        const body = win.document.body;
        const stream = body.textContent ?? '';
        let start = -1;
        for (let seen = 0; seen <= occurrence; seen += 1) start = stream.indexOf(text, start + 1);
        const walker = win.document.createTreeWalker(body, 4);
        const range = win.document.createRange();
        let offset = 0;
        let node: HappyNode | null;
        let started = false;
        while ((node = walker.nextNode())) {
            const length = node.textContent?.length ?? 0;
            if (!started && start < offset + length) { range.setStart(node, start - offset); started = true; }
            if (started && start + text.length <= offset + length) { range.setEnd(node, start + text.length - offset); break; }
            offset += length;
        }
        const selection = win.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        win.document.dispatchEvent(new win.Event('selectionchange'));
        return { stream, start };
    };
    return { win, reports, sent, highlights, send, select, run };
};

describe('the page bootstrap', () => {
    let page: ReturnType<typeof mountPage>;
    beforeEach(() => {
        page = mountPage();
    });

    test('reports a selection with the anchor the chat would measure', async () => {
        const text = 'bold text here.fix';
        const { stream, start } = page.select(text);
        await settle();

        const report = page.reports.filter((message) => message?.kind === 'selection').at(-1);
        // The chat's own capture (lib/chatQuoteAnchor.ts): 32 characters of
        // context either side and the start offset, in the same text stream.
        expect(report).toEqual({
            kind: 'selection',
            text,
            rect: { top: 0, left: 0, width: 0, height: 0 },
            anchor: { text, prefix: stream.slice(Math.max(0, start - 32), start), suffix: stream.slice(start + text.length, start + text.length + 32), start },
        });
        expect(report?.kind === 'selection' && report.anchor ? locateChatQuote(stream, report.anchor) : null).toBe(start);
    });

    test('paints the marks the host posts, finding repeated text by its surroundings', () => {
        const stream = page.win.document.body.textContent ?? '';
        const start = stream.indexOf('then fix it') + 'then '.length;
        const marks = [
            { id: 'a', anchor: { text: 'fix it', prefix: stream.slice(Math.max(0, start - 32), start), suffix: stream.slice(start + 6, start + 38), start }, focused: false },
            { id: 'b', anchor: { text: 'not on the page', prefix: '', suffix: '', start: 0 }, focused: true },
        ];

        page.send(htmlRenderMarksMessage(marks));

        const painted = page.highlights.get('oc-chat-quote') ?? [];
        expect(painted).toHaveLength(1);
        expect(painted[0]?.toString()).toBe('fix it');
        // It is the second occurrence, the one in "then fix it later".
        const before = page.win.document.createRange();
        before.setStart(page.win.document.body, 0);
        if (painted[0]) before.setEnd(painted[0].startContainer, painted[0].startOffset);
        expect(before.toString().length).toBe(start);
        // The unresolvable mark paints nothing, and nothing is drawn stronger.
        expect(page.highlights.get('oc-chat-quote-focus')).toBeUndefined();

        page.send(htmlRenderMarksMessage([]));
        expect(page.highlights.get('oc-chat-quote')).toBeUndefined();
    });

    test('flashes a quote the host asks to reveal', () => {
        const stream = page.win.document.body.textContent ?? '';
        const start = stream.indexOf('bold');
        page.send(htmlRenderRevealMessage({ text: 'bold text', prefix: stream.slice(0, start), suffix: stream.slice(start + 9, start + 41), start }));

        expect(page.highlights.get('oc-chat-quote-flash')?.[0]?.toString()).toBe('bold text');
    });

    test('drops its selection when the host clears it, without reporting that back', async () => {
        page.select('fix it now');
        await settle();
        const before = page.reports.length;

        page.send(htmlRenderClearSelectionMessage());
        page.win.document.dispatchEvent(new page.win.Event('selectionchange'));
        await settle();

        expect(page.win.getSelection().rangeCount).toBe(0);
        expect(page.reports.slice(before).filter((message) => message?.kind === 'selection')).toEqual([]);
    });

    test('passes Escape on only while a reported selection stands and the page left the key alone', async () => {
        const press = () => {
            const event = new page.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            // A key the user pressed; the bootstrap ignores synthetic ones.
            Object.defineProperty(event, 'isTrusted', { value: true });
            page.win.document.body.dispatchEvent(event);
        };
        const escapes = () => page.reports.filter((message) => message?.kind === 'selection-escape').length;

        // No selection: Escape is the page's own.
        press();
        expect(escapes()).toBe(0);

        page.select('fix it now');
        await settle();
        press();
        expect(escapes()).toBe(1);

        // The page's own script took the key.
        const takeIt = (event: HappyEvent) => event.preventDefault();
        page.win.document.addEventListener('keydown', takeIt);
        press();
        expect(escapes()).toBe(1);
        page.win.document.removeEventListener('keydown', takeIt);

        // Once the host clears the selection, Escape is the page's own again.
        page.send(htmlRenderClearSelectionMessage());
        press();
        expect(escapes()).toBe(1);
    });

    test('ignores host messages that do not come from its parent', () => {
        const stream = page.win.document.body.textContent ?? '';
        const start = stream.indexOf('bold');
        page.win.dispatchEvent(new page.win.MessageEvent('message', {
            data: htmlRenderRevealMessage({ text: 'bold', prefix: stream.slice(0, start), suffix: stream.slice(start + 4, start + 36), start }),
            source: new Window(),
        }));

        expect(page.highlights.size).toBe(0);
    });
});

describe('a page that waits for an answer', () => {
    test('still submits beside the selection bootstrap, and settles on the host\'s reply', async () => {
        const page = mountPage({ waiting: true, answer: null });

        // The page's own script, as an option's click handler would run it.
        page.run('window.openchamber.submit({layout:"b"},"Layout B").then(function(){window.parent.postMessage({type:"test:sent",answer:window.openchamber.answer},"*");});');
        expect(page.reports.at(-1)).toEqual({ kind: 'submit', id: 1, submission: { summary: 'Layout B', data: { layout: 'b' } } });

        page.send(htmlRenderSubmitReply(1));
        await settle();
        expect(page.sent).toContain(JSON.stringify({ type: 'test:sent', answer: { layout: 'b' } }));
    });
});
