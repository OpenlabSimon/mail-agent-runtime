import type { InboundMessage, OutboundMessage, MessageTransport } from "./mail-transport.js";
export type ImapTransportOptions = {
    user: string;
    password: string;
    imapHost?: string;
    imapPort?: number;
    smtpHost?: string;
    smtpPort?: number;
    skipBacklog?: boolean;
    toAliasFilter?: string;
    ignoreSenderRe?: RegExp;
};
export declare class ImapTransport implements MessageTransport {
    private imap;
    private smtp;
    private user;
    private imapOpts;
    private skipBacklog;
    private toAliasFilter;
    private ignoreSenderRe;
    private baselineUid;
    private connected;
    constructor(opts: ImapTransportOptions);
    private rebuildImap;
    private ensureConnected;
    /**
     * Run an IMAP operation with one automatic reconnect on failure. A
     * long-running driver will hit transient network errors (Gmail closes idle
     * connections after ~29 minutes, Wi-Fi blips, etc.); rather than bubbling
     * them up as fatal, we flush the connection state and try once more.
     */
    private withReconnect;
    poll(): Promise<InboundMessage[]>;
    private pollOnce;
    send(msg: OutboundMessage): Promise<{
        message_id: string;
    }>;
    private sendOnce;
    ack(messageId: string): Promise<void>;
    private ackOnce;
    close(): Promise<void>;
}
