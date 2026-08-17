import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BRIDGE_PATH = 'public/page-bridges/chatgpt-conversation-bridge.js';
const REQUEST_EVENT = 'aimd:chatgpt-conversation-bridge:request';
const RESPONSE_EVENT = 'aimd:chatgpt-conversation-bridge:response';

function installBridge(): void {
    window.eval(readFileSync(BRIDGE_PATH, 'utf-8'));
}

function message(id: string, role: string, text: string): Record<string, unknown> {
    return {
        id,
        author: { role },
        content: { content_type: 'text', parts: [text] },
    };
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
                    message: message('assistant-message-2', 'assistant', 'Day 2 brief'),
                },
                'assistant-node-3': {
                    id: 'assistant-node-3',
                    parent: 'assistant-node-2',
                    message: message('assistant-message-3', 'assistant', 'Day 3 brief'),
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
    });
});


function buildScheduledTaskSurfaceFrame() {
    const documentRef = {
        key: 'chatgpt:scheduled-task-conversation-12345678',
        platformId: 'chatgpt',
        identityKind: 'canonical' as const,
        conversationId: 'scheduled-task-conversation-12345678',
        canonicalUrl: 'https://chatgpt.com/c/scheduled-task-conversation-12345678',
    };
    const turns = [
        {
            key: 'user-node:assistant-message-1',
            ordinal: 1,
            identity: {
                turnId: 'user-node',
                userMessageId: 'user-message',
                assistantMessageId: 'assistant-message-1',
            },
            userText: 'Send the daily research brief',
            assistantMarkdown: 'Day 1 brief',
        },
        {
            key: 'assistant-node-2:assistant-message-2',
            ordinal: 2,
            identity: {
                turnId: 'assistant-node-2',
                userMessageId: null,
                assistantMessageId: 'assistant-message-2',
            },
            userText: 'Send the daily research brief',
            assistantMarkdown: 'Day 2 brief',
        },
        {
            key: 'assistant-node-3:assistant-message-3',
            ordinal: 3,
            identity: {
                turnId: 'assistant-node-3',
                userMessageId: null,
                assistantMessageId: 'assistant-message-3',
            },
            userText: 'Send the daily research brief',
            assistantMarkdown: 'Day 3 brief',
        },
    ];
    return {
        document: documentRef,
        turns,
        frame: {
            projectionId: 'scheduled-task-projection',
            obtainedTurns: turns.map((turn) => ({
                status: 'obtained' as const,
                turn,
                target: {
                    documentKey: documentRef.key,
                    turnId: turn.identity.turnId,
                    userMessageId: turn.identity.userMessageId,
                    assistantMessageId: turn.identity.assistantMessageId,
                },
                materialization: null,
            })),
        },
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
            <div id="scheduled-run-2" data-turn-id-container="assistant-message-2">
              <section data-turn="assistant">
                <div data-message-author-role="assistant" data-message-id="assistant-message-2"></div>
              </section>
            </div>
            <div data-turn-id-container="assistant-message-3">
              <section data-turn="assistant">
                <div data-message-author-role="assistant" data-message-id="assistant-message-3"></div>
              </section>
            </div>
          </main>
        `;
    });

    it('uses the assistant slot for an unmounted scheduled-task round and completes when it hydrates', async () => {
        const { materializeChatGPTConversationTarget } = await import(
            '@/drivers/content/chatgpt/ChatGPTConversationNavigation'
        );
        const {
            collectChatGPTDomRoundRefs,
            disposeChatGPTPageIndex,
        } = await import('@/drivers/content/chatgpt/domConversationDiscovery');
        const { frame: initialFrame } = buildScheduledTaskSurfaceFrame();
        const runTwoSlot = document.getElementById('scheduled-run-2') as HTMLElement;
        runTwoSlot.scrollIntoView = vi.fn();

        let frame: any = initialFrame;
        const listeners = new Set<(next: any) => void>();
        const adapter = {
            getObserverContainer: () => document.querySelector('main'),
            getMessageSelector: () => '[data-message-author-role="assistant"]',
            getMessageId: (element: HTMLElement) => element.dataset.messageId ?? null,
            getToolbarAnchorElement: () => null,
            isStreamingMessage: () => false,
        } as any;
        const domRounds = collectChatGPTDomRoundRefs(adapter);
        expect(domRounds).toMatchObject([
            { identity: { assistantMessageId: 'assistant-message-1', userMessageId: 'user-message' } },
            { identity: { assistantMessageId: 'assistant-message-2', userMessageId: null }, source: 'assistant-only' },
            { identity: { assistantMessageId: 'assistant-message-3', userMessageId: null }, source: 'assistant-only' },
        ]);

        const surface = {
            readFrame: () => frame,
            subscribeFrame: (listener: (next: any) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            refreshSurface: () => {
                const hydrated = {
                    anchorElement: runTwoSlot,
                    messageElement: runTwoSlot,
                    jumpAnchorElement: runTwoSlot,
                    userElement: null,
                    assistantElement: runTwoSlot,
                    groupElements: [runTwoSlot],
                };
                frame = {
                    ...frame,
                    obtainedTurns: frame.obtainedTurns.map((entry: any) => (
                        entry.turn.identity.assistantMessageId === 'assistant-message-2'
                            ? { ...entry, materialization: hydrated }
                            : entry
                    )),
                };
                listeners.forEach((listener) => listener(frame));
            },
        } as any;

        try {
            const result = await materializeChatGPTConversationTarget(adapter, {
                position: 2,
                roundId: 'assistant-node-2',
                userMessageId: null,
                assistantMessageId: 'assistant-message-2',
            }, {
                surface,
                timeoutMs: 100,
            });

            expect(runTwoSlot.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
            expect(result).toMatchObject({
                ok: true,
                anchor: runTwoSlot,
                round: {
                    position: 2,
                    userMessageId: null,
                    assistantMessageId: 'assistant-message-2',
                },
            });
        } finally {
            disposeChatGPTPageIndex(adapter);
        }
    });
});
