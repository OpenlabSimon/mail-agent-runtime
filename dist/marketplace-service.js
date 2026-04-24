// Marketplace service — step 3 of the three-agent architecture.
//
// Owns a small sqlite marketplace (listings, messages, commitment proposals,
// recorded commitments) and enforces the approval gate that is the security
// boundary for bilateral agent interactions:
//
//   Agent calls proposeCommitment(...)  → row inserted with status
//                                         'awaiting_approval'. NO commitment
//                                         is recorded yet.
//
//   Harness calls finalizeProposal(...) → status moves to 'approved' and a
//                                         row is written into mp_commitments.
//                                         finalizeProposal is NOT exposed to
//                                         any agent tool — only the harness
//                                         (representing the real human) can
//                                         call it. An injected or misaligned
//                                         agent cannot bypass this gate
//                                         regardless of what its prompt says.
//
// All free-text fields from counterparties (listing description, message
// context) are returned inside clear untrusted-content markers so the
// receiving agent's prompt can refuse to treat them as instructions.
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Per-user limits on proposeCommitment. These cap the blast radius of a
// hijacked or looping agent — without them, an injected agent could flood
// the human's approval inbox or leave the mailbox stuck on dozens of pending
// proposals. Not meant to be tight on a well-behaved caller.
export const PROPOSE_RATE_WINDOW_MS = 60000; // 1 minute
export const PROPOSE_RATE_MAX = 10; // at most N proposals per window per user
export const PROPOSE_PENDING_MAX = 5; // at most N concurrent awaiting_approval per user
// ---- service ----------------------------------------------------------
export class MarketplaceService {
    constructor(dbPath, auditPath) {
        this.db = new DatabaseSync(dbPath);
        this.auditPath = auditPath;
        mkdirSync(dirname(auditPath), { recursive: true });
        this.initSchema();
    }
    close() {
        this.db.close();
    }
    initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS mp_listings (
        listing_id TEXT PRIMARY KEY,
        seller_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        asking_price_aed REAL,
        zone TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mp_messages (
        message_id TEXT PRIMARY KEY,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        context_text TEXT NOT NULL,
        commitments_json TEXT,
        sent_at TEXT NOT NULL,
        read_at TEXT
      );

      CREATE TABLE IF NOT EXISTS mp_commitment_proposals (
        proposal_id TEXT PRIMARY KEY,
        proposer_id TEXT NOT NULL,
        counterparty_id TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        commitment_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting_approval',
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS mp_commitments (
        commitment_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        proposer_id TEXT NOT NULL,
        counterparty_id TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        commitment_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mp_messages_to ON mp_messages(to_user_id, read_at);
      CREATE INDEX IF NOT EXISTS idx_mp_listings_status ON mp_listings(status);
      CREATE INDEX IF NOT EXISTS idx_mp_proposals_status ON mp_commitment_proposals(status);
    `);
    }
    // ---- agent-callable surface -----------------------------------------
    createListing(sellerId, args) {
        const meta = this.newMeta();
        if (!args.title?.trim())
            return this.fail(sellerId, "create_listing", args, meta, "INVALID_ARGS", "title required");
        if (!args.description?.trim())
            return this.fail(sellerId, "create_listing", args, meta, "INVALID_ARGS", "description required");
        const listingId = "lst_" + cryptoish();
        try {
            this.db.prepare(`
        INSERT INTO mp_listings (listing_id, seller_id, title, description, asking_price_aed, zone, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(listingId, sellerId, args.title, args.description, args.asking_price_aed ?? null, args.zone ?? null, new Date().toISOString());
            this.audit({ user_id: sellerId, tool: "create_listing", args: { ...args, description_len: args.description.length }, meta, ok: true, listing_id: listingId });
            return { ok: true, data: { listing_id: listingId }, meta };
        }
        catch (err) {
            return this.fail(sellerId, "create_listing", args, meta, "INTERNAL", err.message);
        }
    }
    searchMarketplace(userId, args) {
        const meta = this.newMeta();
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);
        const where = ["status = 'active'"];
        const params = [];
        if (args.query) {
            where.push("(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)");
            params.push(`%${args.query.toLowerCase()}%`, `%${args.query.toLowerCase()}%`);
        }
        if (args.max_price_aed != null) {
            where.push("asking_price_aed IS NOT NULL AND asking_price_aed <= ?");
            params.push(args.max_price_aed);
        }
        if (args.zone) {
            where.push("zone = ?");
            params.push(args.zone);
        }
        params.push(limit);
        try {
            const rows = this.db.prepare(`
        SELECT listing_id, seller_id, title, description, asking_price_aed, zone, status
        FROM mp_listings
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...params);
            const summaries = rows.map((r) => ({
                listing_id: r.listing_id,
                seller_id: r.seller_id,
                title: r.title,
                asking_price_aed: r.asking_price_aed,
                zone: r.zone,
                status: r.status,
                untrusted_description: r.description,
            }));
            const okMeta = { ...meta, count: summaries.length };
            this.audit({ user_id: userId, tool: "search_marketplace", args, meta: okMeta, ok: true });
            return { ok: true, data: summaries, meta: okMeta };
        }
        catch (err) {
            return this.fail(userId, "search_marketplace", args, meta, "INTERNAL", err.message);
        }
    }
    viewListing(userId, listingId) {
        const meta = this.newMeta();
        try {
            const r = this.db.prepare(`
        SELECT listing_id, seller_id, title, description, asking_price_aed, zone, status
        FROM mp_listings WHERE listing_id = ?
      `).get(listingId);
            if (!r)
                return this.fail(userId, "view_listing", { listing_id: listingId }, meta, "NOT_FOUND", `listing ${listingId} not found`);
            this.audit({ user_id: userId, tool: "view_listing", args: { listing_id: listingId }, meta, ok: true });
            return {
                ok: true,
                data: {
                    listing_id: r.listing_id,
                    seller_id: r.seller_id,
                    title: r.title,
                    asking_price_aed: r.asking_price_aed,
                    zone: r.zone,
                    status: r.status,
                    untrusted_description: r.description,
                },
                meta,
            };
        }
        catch (err) {
            return this.fail(userId, "view_listing", { listing_id: listingId }, meta, "INTERNAL", err.message);
        }
    }
    sendMessage(fromUserId, args) {
        const meta = this.newMeta();
        if (!args.context_text?.trim())
            return this.fail(fromUserId, "send_message", args, meta, "INVALID_ARGS", "context_text required");
        try {
            const listing = this.db.prepare(`SELECT seller_id FROM mp_listings WHERE listing_id = ?`).get(args.listing_id);
            if (!listing)
                return this.fail(fromUserId, "send_message", args, meta, "NOT_FOUND", `listing ${args.listing_id} not found`);
            let toUserId;
            if (listing.seller_id === fromUserId) {
                // seller replying on their own listing — route to the most recent buyer who messaged
                const lastBuyer = this.db.prepare(`
          SELECT from_user_id FROM mp_messages
          WHERE listing_id = ? AND to_user_id = ?
          ORDER BY sent_at DESC LIMIT 1
        `).get(args.listing_id, fromUserId);
                if (!lastBuyer)
                    return this.fail(fromUserId, "send_message", args, meta, "FORBIDDEN", "no buyer has messaged this listing yet — wait for a buyer before replying");
                toUserId = lastBuyer.from_user_id;
            }
            else {
                toUserId = listing.seller_id;
            }
            const messageId = "msg_" + cryptoish();
            this.db.prepare(`
        INSERT INTO mp_messages (message_id, from_user_id, to_user_id, listing_id, context_text, commitments_json, sent_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
      `).run(messageId, fromUserId, toUserId, args.listing_id, args.context_text, new Date().toISOString());
            this.audit({ user_id: fromUserId, tool: "send_message", args: { listing_id: args.listing_id, context_len: args.context_text.length }, meta, ok: true, message_id: messageId, to_user_id: toUserId });
            return { ok: true, data: { message_id: messageId }, meta };
        }
        catch (err) {
            return this.fail(fromUserId, "send_message", args, meta, "INTERNAL", err.message);
        }
    }
    fetchInbox(userId, args = {}) {
        const meta = this.newMeta();
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
        const where = ["to_user_id = ?"];
        const params = [userId];
        if (args.only_unread)
            where.push("read_at IS NULL");
        params.push(limit);
        try {
            const rows = this.db.prepare(`
        SELECT message_id, from_user_id, listing_id, context_text, commitments_json, sent_at, read_at
        FROM mp_messages
        WHERE ${where.join(" AND ")}
        ORDER BY sent_at ASC
        LIMIT ?
      `).all(...params);
            const now = new Date().toISOString();
            const markRead = this.db.prepare(`UPDATE mp_messages SET read_at = ? WHERE message_id = ? AND read_at IS NULL`);
            const messages = rows.map((r) => {
                if (!r.read_at)
                    markRead.run(now, r.message_id);
                return {
                    message_id: r.message_id,
                    from_user_id: r.from_user_id,
                    listing_id: r.listing_id,
                    untrusted_context: r.context_text,
                    commitments: r.commitments_json ? JSON.parse(r.commitments_json) : null,
                    sent_at: r.sent_at,
                    read_at: r.read_at ?? now,
                };
            });
            const okMeta = { ...meta, count: messages.length };
            this.audit({ user_id: userId, tool: "fetch_inbox", args, meta: okMeta, ok: true });
            return { ok: true, data: messages, meta: okMeta };
        }
        catch (err) {
            return this.fail(userId, "fetch_inbox", args, meta, "INTERNAL", err.message);
        }
    }
    proposeCommitment(proposerId, args) {
        const meta = this.newMeta();
        if (!args.commitment?.action)
            return this.fail(proposerId, "propose_commitment", args, meta, "INVALID_ARGS", "commitment.action required");
        const allowed = ["offer", "accept", "counter", "decline"];
        if (!allowed.includes(args.commitment.action))
            return this.fail(proposerId, "propose_commitment", args, meta, "INVALID_ARGS", `unknown action: ${args.commitment.action}`);
        try {
            const listing = this.db.prepare(`SELECT seller_id, status FROM mp_listings WHERE listing_id = ?`).get(args.listing_id);
            if (!listing)
                return this.fail(proposerId, "propose_commitment", args, meta, "NOT_FOUND", `listing ${args.listing_id} not found`);
            if (listing.status !== "active")
                return this.fail(proposerId, "propose_commitment", args, meta, "CONFLICT", `listing status is ${listing.status}`);
            const counterpartyId = listing.seller_id === proposerId
                ? null // seller cannot propose on their own listing directly (but can counter-accept via a separate flow)
                : listing.seller_id;
            if (!counterpartyId)
                return this.fail(proposerId, "propose_commitment", args, meta, "FORBIDDEN", "cannot propose commitment on your own listing");
            // Rate limit: cap blast radius of a hijacked / looping agent.
            const windowStart = new Date(Date.now() - PROPOSE_RATE_WINDOW_MS).toISOString();
            const recent = this.db.prepare(`SELECT COUNT(*) AS n FROM mp_commitment_proposals WHERE proposer_id = ? AND created_at > ?`).get(proposerId, windowStart);
            if (recent.n >= PROPOSE_RATE_MAX) {
                return this.fail(proposerId, "propose_commitment", args, meta, "RATE_LIMITED", `proposal rate limit: ${PROPOSE_RATE_MAX} per ${PROPOSE_RATE_WINDOW_MS / 1000}s — slow down`);
            }
            const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM mp_commitment_proposals WHERE proposer_id = ? AND status = 'awaiting_approval'`).get(proposerId);
            if (pending.n >= PROPOSE_PENDING_MAX) {
                return this.fail(proposerId, "propose_commitment", args, meta, "RATE_LIMITED", `too many pending proposals: ${PROPOSE_PENDING_MAX} already awaiting approval — have the human decide on them first`);
            }
            const proposalId = "prop_" + cryptoish();
            this.db.prepare(`
        INSERT INTO mp_commitment_proposals (proposal_id, proposer_id, counterparty_id, listing_id, commitment_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'awaiting_approval', ?)
      `).run(proposalId, proposerId, counterpartyId, args.listing_id, JSON.stringify(args.commitment), new Date().toISOString());
            this.audit({ user_id: proposerId, tool: "propose_commitment", args, meta, ok: true, proposal_id: proposalId });
            return {
                ok: true,
                data: { proposal_id: proposalId, status: "awaiting_approval", commitment: args.commitment },
                meta,
            };
        }
        catch (err) {
            return this.fail(proposerId, "propose_commitment", args, meta, "INTERNAL", err.message);
        }
    }
    // ---- NOT exposed to agents ------------------------------------------
    // finalizeProposal is the authority gate. It is called by the harness
    // (which represents the real human) after the human approves or rejects
    // the proposal. No agent tool surface ever reaches this method.
    finalizeProposal(actorUserId, proposalId, decision) {
        const meta = this.newMeta();
        try {
            const row = this.db.prepare(`
        SELECT proposal_id, proposer_id, counterparty_id, listing_id, commitment_json, status
        FROM mp_commitment_proposals WHERE proposal_id = ?
      `).get(proposalId);
            if (!row)
                return this.fail(actorUserId, "finalize_proposal", { proposalId, decision }, meta, "NOT_FOUND", `proposal ${proposalId} not found`);
            if (row.status !== "awaiting_approval")
                return this.fail(actorUserId, "finalize_proposal", { proposalId, decision }, meta, "CONFLICT", `proposal status is ${row.status}`);
            if (row.proposer_id !== actorUserId) {
                return this.fail(actorUserId, "finalize_proposal", { proposalId, decision }, meta, "FORBIDDEN", "only the proposer's human can finalize a proposal");
            }
            const now = new Date().toISOString();
            if (decision === "reject") {
                this.db.prepare(`UPDATE mp_commitment_proposals SET status = 'rejected', decided_at = ? WHERE proposal_id = ?`).run(now, proposalId);
                this.audit({ user_id: actorUserId, tool: "finalize_proposal", args: { proposalId, decision }, meta, ok: true });
                return { ok: true, data: { proposal_id: proposalId, status: "rejected" }, meta };
            }
            this.db.prepare(`UPDATE mp_commitment_proposals SET status = 'approved', decided_at = ? WHERE proposal_id = ?`).run(now, proposalId);
            const commitmentId = "cmt_" + cryptoish();
            this.db.prepare(`
        INSERT INTO mp_commitments (commitment_id, proposal_id, proposer_id, counterparty_id, listing_id, commitment_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(commitmentId, proposalId, row.proposer_id, row.counterparty_id, row.listing_id, row.commitment_json, now);
            // delivery to counterparty inbox is part of the commitment effect
            const messageId = "msg_" + cryptoish();
            this.db.prepare(`
        INSERT INTO mp_messages (message_id, from_user_id, to_user_id, listing_id, context_text, commitments_json, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(messageId, row.proposer_id, row.counterparty_id, row.listing_id, `[commitment approved] ${row.commitment_json}`, row.commitment_json, now);
            this.audit({ user_id: actorUserId, tool: "finalize_proposal", args: { proposalId, decision }, meta, ok: true, commitment_id: commitmentId });
            return { ok: true, data: { proposal_id: proposalId, status: "approved", commitment_id: commitmentId }, meta };
        }
        catch (err) {
            return this.fail(actorUserId, "finalize_proposal", { proposalId, decision }, meta, "INTERNAL", err.message);
        }
    }
    // cancelProposal is also harness-only. It lets the human clear a stuck
    // 'awaiting_approval' row without approving it — needed so the
    // PROPOSE_PENDING_MAX cap can't strand an agent if the human ignores a
    // batch of pending proposals. Not reachable from any agent tool surface.
    cancelProposal(actorUserId, proposalId) {
        const meta = this.newMeta();
        try {
            const row = this.db.prepare(`SELECT proposer_id, status FROM mp_commitment_proposals WHERE proposal_id = ?`).get(proposalId);
            if (!row)
                return this.fail(actorUserId, "cancel_proposal", { proposalId }, meta, "NOT_FOUND", `proposal ${proposalId} not found`);
            if (row.status !== "awaiting_approval") {
                return this.fail(actorUserId, "cancel_proposal", { proposalId }, meta, "CONFLICT", `proposal status is ${row.status}`);
            }
            if (row.proposer_id !== actorUserId) {
                return this.fail(actorUserId, "cancel_proposal", { proposalId }, meta, "FORBIDDEN", "only the proposer's human can cancel a proposal");
            }
            const now = new Date().toISOString();
            this.db.prepare(`UPDATE mp_commitment_proposals SET status = 'cancelled', decided_at = ? WHERE proposal_id = ?`).run(now, proposalId);
            this.audit({ user_id: actorUserId, tool: "cancel_proposal", args: { proposalId }, meta, ok: true });
            return { ok: true, data: { proposal_id: proposalId, status: "cancelled" }, meta };
        }
        catch (err) {
            return this.fail(actorUserId, "cancel_proposal", { proposalId }, meta, "INTERNAL", err.message);
        }
    }
    // ---- read helpers for the harness ------------------------------------
    getProposal(proposalId) {
        const r = this.db.prepare(`
      SELECT proposal_id, proposer_id, listing_id, commitment_json, status, created_at, decided_at
      FROM mp_commitment_proposals WHERE proposal_id = ?
    `).get(proposalId);
        if (!r)
            return null;
        return {
            proposal_id: r.proposal_id,
            proposer_id: r.proposer_id,
            listing_id: r.listing_id,
            commitment: JSON.parse(r.commitment_json),
            status: r.status,
            created_at: r.created_at,
            decided_at: r.decided_at,
        };
    }
    listCommitments(listingId) {
        const rows = this.db.prepare(`
      SELECT commitment_id, proposal_id, proposer_id, counterparty_id, listing_id, commitment_json, recorded_at
      FROM mp_commitments WHERE listing_id = ? ORDER BY recorded_at ASC
    `).all(listingId);
        return rows.map((r) => ({
            commitment_id: r.commitment_id,
            proposal_id: r.proposal_id,
            proposer_id: r.proposer_id,
            counterparty_id: r.counterparty_id,
            listing_id: r.listing_id,
            commitment: JSON.parse(r.commitment_json),
            recorded_at: r.recorded_at,
        }));
    }
    // ---- internals -------------------------------------------------------
    fail(userId, tool, args, meta, code, message) {
        this.audit({ user_id: userId, tool, args, meta, ok: false, error_code: code, error_message: message });
        return { ok: false, error: { code, message }, meta };
    }
    audit(entry) {
        try {
            appendFileSync(this.auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
        }
        catch {
            // best-effort
        }
    }
    newMeta() {
        return {
            query_id: "mq_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
            timestamp: new Date().toISOString(),
        };
    }
}
function cryptoish() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
