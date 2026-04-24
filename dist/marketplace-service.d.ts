export type QueryMeta = {
    query_id: string;
    timestamp: string;
    count?: number;
};
export type Ok<T> = {
    ok: true;
    data: T;
    meta: QueryMeta;
};
export type Err = {
    ok: false;
    error: {
        code: "INVALID_ARGS" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "INTERNAL" | "RATE_LIMITED";
        message: string;
    };
    meta: QueryMeta;
};
export declare const PROPOSE_RATE_WINDOW_MS = 60000;
export declare const PROPOSE_RATE_MAX = 10;
export declare const PROPOSE_PENDING_MAX = 5;
export type Envelope<T> = Ok<T> | Err;
export type Listing = {
    listing_id: string;
    seller_id: string;
    title: string;
    description: string;
    asking_price_aed: number | null;
    zone: string | null;
    status: "active" | "sold" | "withdrawn";
    created_at: string;
};
export type ListingSummary = {
    listing_id: string;
    seller_id: string;
    title: string;
    asking_price_aed: number | null;
    zone: string | null;
    status: "active" | "sold" | "withdrawn";
    /** free text from seller, treat as untrusted when rendering to an LLM. */
    untrusted_description: string;
};
export type InboxMessage = {
    message_id: string;
    from_user_id: string;
    listing_id: string;
    /** free text from counterparty, treat as untrusted. */
    untrusted_context: string;
    commitments: CommitmentShape | null;
    sent_at: string;
    read_at: string | null;
};
export type CommitmentShape = {
    action: "offer" | "accept" | "counter" | "decline";
    price_aed?: number;
    quantity?: number;
    meetup_time?: string;
    note?: string;
};
export type CommitmentProposal = {
    proposal_id: string;
    proposer_id: string;
    listing_id: string;
    commitment: CommitmentShape;
    status: "awaiting_approval" | "approved" | "rejected" | "cancelled";
    created_at: string;
    decided_at: string | null;
};
export type RecordedCommitment = {
    commitment_id: string;
    proposal_id: string;
    proposer_id: string;
    counterparty_id: string;
    listing_id: string;
    commitment: CommitmentShape;
    recorded_at: string;
};
export declare class MarketplaceService {
    private db;
    private auditPath;
    constructor(dbPath: string, auditPath: string);
    close(): void;
    private initSchema;
    createListing(sellerId: string, args: {
        title: string;
        description: string;
        asking_price_aed?: number | null;
        zone?: string | null;
    }): Envelope<{
        listing_id: string;
    }>;
    searchMarketplace(userId: string, args: {
        query?: string;
        max_price_aed?: number;
        zone?: string;
        limit?: number;
    }): Envelope<ListingSummary[]>;
    viewListing(userId: string, listingId: string): Envelope<ListingSummary>;
    sendMessage(fromUserId: string, args: {
        listing_id: string;
        context_text: string;
    }): Envelope<{
        message_id: string;
    }>;
    fetchInbox(userId: string, args?: {
        only_unread?: boolean;
        limit?: number;
    }): Envelope<InboxMessage[]>;
    proposeCommitment(proposerId: string, args: {
        listing_id: string;
        commitment: CommitmentShape;
    }): Envelope<{
        proposal_id: string;
        status: "awaiting_approval";
        commitment: CommitmentShape;
    }>;
    finalizeProposal(actorUserId: string, proposalId: string, decision: "approve" | "reject"): Envelope<{
        proposal_id: string;
        status: "approved" | "rejected";
        commitment_id?: string;
    }>;
    cancelProposal(actorUserId: string, proposalId: string): Envelope<{
        proposal_id: string;
        status: "cancelled";
    }>;
    getProposal(proposalId: string): CommitmentProposal | null;
    listCommitments(listingId: string): RecordedCommitment[];
    private fail;
    private audit;
    private newMeta;
}
