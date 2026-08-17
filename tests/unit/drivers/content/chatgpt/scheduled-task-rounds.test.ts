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
