export type InboundMessage = {
    message_id: string;
    from: string;
    to: string;
    subject: string;
    body_text: string;
    received_at: string;
    /** Optional threading hints. The driver echoes them back on responses
     *  so that real mail clients (and the future ImapTransport) can stitch
     *  conversations together. */
    thread_id?: string;
    in_reply_to?: string;
};
export type OutboundMessage = {
    to: string;
    subject: string;
    body_text: string;
    thread_id?: string;
    in_reply_to?: string;
};
export interface MessageTransport {
    /** Fetch any messages waiting in the user-side inbox. May return [] when idle.
     *  Implementations should NOT mark messages as processed here — that is
     *  ack()'s job, called by the driver after the agent has fully handled a
     *  message and any errors have surfaced. */
    poll(): Promise<InboundMessage[]>;
    /** Deliver an outbound message. Returns the assigned message_id. */
    send(msg: OutboundMessage): Promise<{
        message_id: string;
    }>;
    /** Mark an inbound message as fully processed so it isn't re-delivered. */
    ack(messageId: string): Promise<void>;
    close(): Promise<void>;
}
export declare class FileTransport implements MessageTransport {
    private inboxDir;
    private outboxDir;
    private processedDir;
    constructor(rootDir: string);
    poll(): Promise<InboundMessage[]>;
    send(msg: OutboundMessage): Promise<{
        message_id: string;
    }>;
    ack(messageId: string): Promise<void>;
    close(): Promise<void>;
}
