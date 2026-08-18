import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationContentSource } from '../../../../helpers/chatgptContentFixtures';
import { ChatGPTConversationSurface } from '@/drivers/content/chatgpt/ChatGPTConversationSurface';

const BRIDGE_PATH = 'public/page-bridges/chatgpt-conversation-bridge.js';
const REQUEST_EVENT = 'aimd:chatgpt-conversation-bridge:request';
const RESPONSE_EVENT = 'aimd:chatgpt-conversation-bridge:response';

function installBridge(): void {
    window.eval(readFileSync(BRIDGE_PATH, 'utf-8'));
}

function message(
    id: string,
    role: string,
    text: string,
    createTime?: number,
): Record<string, unknown> {
    return {
        id,
        author: { role },
        content: { content_type: 'text', parts: [text] },
        ...(createTime === undefined ? {} : { create_time: createTime }),
    };
}

function scheduledTaskLabel(createTime: number): string {
    const date = new Date(createTime * 1000);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `定时任务 · ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function requestSnapshot(conversationId: string): Promise<any> {
    const requestId = `scheduled-task-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
        const listener = ((event: Event) => {
            const raw = (event as CustomEvent<unknown>).detail;
            const detail = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if ((detail as any)?.requestId !== requestId) return;
            window.removeEventListener(RESPONSE_EVENT, listener);
            resolve(detail);
        }) as EventListener;
        window.addEventListener(RESPONSE_EVENT, listener);
        window.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
            detail: { requestId, type: 'peek', conversationId },
        }));
    });
}

function buildOrdinaryConversationPayload(conversationId: string, roundCount: number) {
    const mapping: Record<string, unknown> = {
        root: { id: 'root', parent: null, message: null },
    };
    let parent = 'root';
    for (let index = 0; index < roundCount; index += 1) {
        const ordinal = index + 1;
        const userNode = `user-node-${ordinal}`;
        const assistantNode = `assistant-node-${ordinal}`;
        mapping[userNode] = {
            id: userNode,
            parent,
            message: message(`user-message-${ordinal}`, 'user', `Prompt ${ordinal}`),
        };
        mapping[assistantNode] = {
            id: assistantNode,
            parent: userNode,
            message: message(`assistant-message-${ordinal}`, 'assistant', `Answer ${ordinal}`),
        };
        parent = assistantNode;
    }
    return { conversation_id: conversationId, current_node: parent, mapping };
}

describe('scheduled task conversation rounds', () => {
    beforeEach(() => {
        (window as any).__AIMD_CHATGPT_CONVERSATION_BRIDGE__?.dispose?.();
        delete (window as any).__AIMD_CHATGPT_CONVERSATION_BRIDGE__;
        document.body.innerHTML = '<main></main>';
        vi.restoreAllMocks();
    });

    it('keeps consecutive scheduled-task assistant outputs as independently navigable rounds', async () => {
        const conversationId = 'scheduled-task-conversation-12345678';
        history.replaceState({}, '', `/c/${conversationId}`);
        const payload = {
            conversation_id: conversationId,
            current_node: 'assistant-node-3',
            mapping: {
                root: { id: 'root', parent: null, message: null },
                'user-node': {
                    id: 'user-node',
                    parent: 'root',
                    message: message('user-message', 'user', 'Send the daily research brief'),
                },
                'assistant-node-1': {
                    id: 'assistant-node-1',
                    parent: 'user-node',
                    message: message('assistant-message-1', 'assistant', 'Day 1 brief'),
                },
                'assistant-node-2': {
                    id: 'assistant-node-2',
                    parent: 'assistant-node-1',
                    message: message('assistant-message-2', 'assistant', 'Day 2 brief', 1717245000),
                },
                'assistant-node-3': {
                    id: 'assistant-node-3',
                    parent: 'assistant-node-2',
                    message: message('assistant-message-3', 'assistant', 'Day 3 brief', 1717331400),
                },
            },
        };
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        Object.defineProperty(window, 'fetch', { configurable: true, value: fetchMock });
        vi.stubGlobal('fetch', fetchMock);

        installBridge();
        await window.fetch(`/backend-api/conversation/${conversationId}`);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const response = await requestSnapshot(conversationId);

        expect(response.ok).toBe(true);
        expect(response.snapshot.rounds).toHaveLength(3);
        expect(response.snapshot.rounds.map((round: any) => round.assistantMessageId)).toEqual([
            'assistant-message-1',
            'assistant-message-2',
            'assistant-message-3',
        ]);
        expect(response.snapshot.rounds.map((round: any) => round.userMessageId)).toEqual([
            'user-message',
            null,
            null,
        ]);
        expect(response.snapshot.rounds.map((round: any) => round.assistantContent)).toEqual([
            'Day 1 brief',
            'Day 2 brief',
            'Day 3 brief',
        ]);
        expect(response.snapshot.rounds.map((round: any) => round.userPrompt)).toEqual([
            'Send the daily research brief',
            scheduledTaskLabel(1717245000),
            scheduledTaskLabel(1717331400),
        ]);
    });

    it('selects the richest graph when one response contains a rooted one-round prefix first', async () => {
        const conversationId = 'ordinary-long-conversation-12345678';
        history.replaceState({}, '', `/c/${conversationId}`);
        const oneRound = buildOrdinaryConversationPayload(conversationId, 1);
        const elevenRounds = buildOrdinaryConversationPayload(conversationId, 11);
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            data: { candidates: [oneRound, elevenRounds] },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        Object.defineProperty(window, 'fetch', { configurable: true, value: fetchMock });
        vi.stubGlobal('fetch', fetchMock);

        installBridge();
        await window.fetch(`/backend-api/conversation/${conversationId}`);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const response = await requestSnapshot(conversationId);

        expect(response.ok).toBe(true);
        expect(response.snapshot.rounds).toHaveLength(11);
        expect(response.snapshot.rounds[0]?.userPrompt).toBe('Prompt 1');
        expect(response.snapshot.rounds[10]?.userPrompt).toBe('Prompt 11');
        expect(response.snapshot.branchKey).toBe('assistant-node-11');
    });

    it('does not let a later rooted prefix replace a richer known branch', async () => {
        const conversationId = 'ordinary-monotonic-conversation-12345678';
        history.replaceState({}, '', `/c/${conversationId}`);
        const elevenRounds = buildOrdinaryConversationPayload(conversationId, 11);
        const oneRound = buildOrdinaryConversationPayload(conversationId, 1);
        let requestIndex = 0;
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(
            requestIndex++ === 0 ? elevenRounds : oneRound,
        ), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        Object.defineProperty(window, 'fetch', { configurable: true, value: fetchMock });
        vi.stubGlobal('fetch', fetchMock);

        installBridge();
        await window.fetch(`/backend-api/conversation/${conversationId}`);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        await window.fetch(`/backend-api/conversation/${conversationId}`);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const response = await requestSnapshot(conversationId);

        expect(response.ok).toBe(true);
        expect(response.snapshot.rounds).toHaveLength(11);
        expect(response.snapshot.rounds[10]?.assistantMessageId).toBe('assistant-message-11');
        expect(response.snapshot.branchKey).toBe('assistant-node-11');
    });
});


function buildScheduledTaskSnapshot() {
    return {
        conversationId: 'scheduled-task-conversation-12345678',
        revision: 1,
        proof: 'observed-graph' as const,
        branchKey: 'scheduled-task-branch',
        capturedAt: Date.now(),
        rounds: [
            {
                id: 'user-node',
                position: 1,
                userPrompt: 'Send the daily research brief',
                assistantContent: 'Day 1 brief',
                preview: 'Send the daily research brief',
                messageId: 'assistant-message-1',
                userMessageId: 'user-message',
                assistantMessageId: 'assistant-message-1',
            },
            {
                id: 'assistant-node-2',
                position: 2,
                userPrompt: 'Send the daily research brief',
                assistantContent: 'Day 2 brief',
                preview: 'Send the daily research brief',
                messageId: 'assistant-message-2',
                userMessageId: null,
                assistantMessageId: 'assistant-message-2',
            },
            {
                id: 'assistant-node-3',
                position: 3,
                userPrompt: 'Send the daily research brief',
                assistantContent: 'Day 3 brief',
                preview: 'Send the daily research brief',
                messageId: 'assistant-message-3',
                userMessageId: null,
                assistantMessageId: 'assistant-message-3',
            },
        ],
    };
}

describe('scheduled task directory navigation', () => {
    beforeEach(() => {
        document.body.innerHTML = `
          <main>
            <div data-turn-id-container="user-message">
              <section data-turn="user">
                <div data-message-author-role="user" data-message-id="user-message"></div>
              </section>
            </div>
            <div data-turn-id-container="assistant-message-1">
              <section data-turn="assistant">
                <div data-message-author-role="assistant" data-message-id="assistant-message-1"></div>
              </section>
            </div>
            <div id="scheduled-run-2" data-turn-id-container="assistant-message-2"></div>
            <div data-turn-id-container="assistant-message-3"></div>
          </main>
        `;
    });

    it('completes a mounted directory jump after one paint without waiting for quiet timers', async () => {
        const { navigateChatGPTDirectoryTarget } = await import(
            '@/ui/content/chatgptDirectory/navigation'
        );
        const adapter = {
            getObserverContainer: () => document.querySelector('main'),
            getMessageSelector: () => '[data-message-author-role="assistant"]',
            getMessageContentSelector: () => '.markdown',
            getMessageId: (element: HTMLElement) => element.dataset.messageId ?? null,
            getToolbarAnchorElement: () => null,
            isStreamingMessage: () => false,
        } as any;
        const source = createConversationContentSource(buildScheduledTaskSnapshot());
        const surface = new ChatGPTConversationSurface({ adapter, content: source });
        const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
        const rafDescriptor = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
        const scrollIntoView = vi.fn();
        const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 0, y: 0, width: 100, height: 120, top: 0, right: 100, bottom: 120, left: 0,
            toJSON: () => ({}),
        } as DOMRect);
        vi.useFakeTimers();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView,
        });
        Object.defineProperty(window, 'requestAnimationFrame', {
            configurable: true,
            writable: true,
            value: (callback: FrameRequestCallback) => { callback(16); return 1; },
        });

        try {
            const result = await navigateChatGPTDirectoryTarget(adapter, {
                position: 1,
                roundId: 'user-node',
                userMessageId: 'user-message',
                assistantMessageId: 'assistant-message-1',
            }, { surface, alignmentQuietMs: 500 });

            expect(result.ok).toBe(true);
            expect(scrollIntoView).toHaveBeenCalledTimes(1);
        } finally {
            surface.dispose();
            rectSpy.mockRestore();
            if (scrollDescriptor) {
                Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
            } else {
                delete (HTMLElement.prototype as any).scrollIntoView;
            }
            if (rafDescriptor) {
                Object.defineProperty(window, 'requestAnimationFrame', rafDescriptor);
            } else {
                delete (window as any).requestAnimationFrame;
            }
            vi.useRealTimers();
        }
    });

    it('uses an assistant slot to hydrate and materialize one scheduled-task run from a grouped host round', async () => {
        const { materializeChatGPTConversationTarget } = await import(
            '@/drivers/content/chatgpt/ChatGPTConversationNavigation'
        );
        const {
            collectChatGPTDomRoundRefs,
            disposeChatGPTPageIndex,
        } = await import('@/drivers/content/chatgpt/domConversationDiscovery');
        const runTwoSlot = document.getElementById('scheduled-run-2') as HTMLElement;
        const adapter = {
            getObserverContainer: () => document.querySelector('main'),
            getMessageSelector: () => '[data-message-author-role="assistant"]',
            getMessageContentSelector: () => '.markdown',
            getMessageId: (element: HTMLElement) => element.dataset.messageId ?? null,
            getToolbarAnchorElement: () => null,
            isStreamingMessage: () => false,
        } as any;
        const source = createConversationContentSource(buildScheduledTaskSnapshot());
        const surface = new ChatGPTConversationSurface({ adapter, content: source });
        runTwoSlot.scrollIntoView = vi.fn(() => {
            runTwoSlot.innerHTML = `
              <section data-turn="assistant">
                <div data-message-author-role="assistant" data-message-id="assistant-message-2"></div>
              </section>
            `;
        });

        try {
            expect(surface.readFrame().obtainedTurns[1]?.materialization).toBeNull();

            const result = await materializeChatGPTConversationTarget(adapter, {
                position: 2,
                roundId: 'assistant-node-2',
                userMessageId: null,
                assistantMessageId: 'assistant-message-2',
            }, {
                surface,
                timeoutMs: 100,
            });

            const domRounds = collectChatGPTDomRoundRefs(adapter);
            expect(domRounds).toHaveLength(1);
            expect(domRounds[0]?.groupEls).toHaveLength(3);
            expect(runTwoSlot.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.message);
            const runTwoAssistantRoot = runTwoSlot.querySelector('[data-turn="assistant"]');
            if (!(runTwoAssistantRoot instanceof HTMLElement)) throw new Error('scheduled task assistant root is missing');
            expect(result.anchor).toBe(runTwoAssistantRoot);
            expect(result.round.position).toBe(2);
            expect(result.round.userMessageId).toBeNull();
            expect(result.round.assistantMessageId).toBe('assistant-message-2');
            expect(surface.readFrame().obtainedTurns[1]?.materialization?.assistantElement).toBe(runTwoAssistantRoot);
        } finally {
            surface.dispose();
            disposeChatGPTPageIndex(adapter);
        }
    });
});
