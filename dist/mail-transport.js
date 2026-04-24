// Mail transport — abstraction layer between the user-facing email channel
// and the agent runtime. The MessageTransport interface is deliberately
// minimal so a future ImapTransport / GmailTransport drops in without
// touching the agent or the driver.
//
// FileTransport is the offline implementation: messages are JSON files in
// data/mail/{inbox,outbox,processed}. Drop a file in inbox/, run the driver,
// see a response file appear in outbox/ and the original moved to processed/.
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
// ----- FileTransport --------------------------------------------------------
export class FileTransport {
    constructor(rootDir) {
        this.inboxDir = resolve(rootDir, "inbox");
        this.outboxDir = resolve(rootDir, "outbox");
        this.processedDir = resolve(rootDir, "processed");
        for (const d of [this.inboxDir, this.outboxDir, this.processedDir]) {
            mkdirSync(d, { recursive: true });
        }
    }
    async poll() {
        const files = readdirSync(this.inboxDir)
            .filter((f) => f.endsWith(".json") && !f.startsWith("."))
            .sort(); // lexical = chronological if the producer uses ISO timestamps in the filename
        const out = [];
        for (const f of files) {
            const path = join(this.inboxDir, f);
            try {
                const raw = readFileSync(path, "utf-8");
                const parsed = JSON.parse(raw);
                if (!parsed.from || !parsed.to || !parsed.body_text) {
                    // malformed — leave it in the inbox so the user can fix it
                    continue;
                }
                const msg = {
                    message_id: parsed.message_id ?? basename(f, ".json"),
                    from: parsed.from,
                    to: parsed.to,
                    subject: parsed.subject ?? "(no subject)",
                    body_text: parsed.body_text,
                    received_at: parsed.received_at ?? new Date().toISOString(),
                    thread_id: parsed.thread_id,
                    in_reply_to: parsed.in_reply_to,
                };
                out.push(msg);
            }
            catch {
                // skip unreadable files
            }
        }
        return out;
    }
    async send(msg) {
        const messageId = "out_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${messageId}.json`;
        const path = join(this.outboxDir, filename);
        const payload = {
            message_id: messageId,
            to: msg.to,
            subject: msg.subject,
            body_text: msg.body_text,
            thread_id: msg.thread_id,
            in_reply_to: msg.in_reply_to,
            sent_at: new Date().toISOString(),
        };
        writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
        return { message_id: messageId };
    }
    async ack(messageId) {
        const files = readdirSync(this.inboxDir).filter((f) => f.endsWith(".json"));
        for (const f of files) {
            const path = join(this.inboxDir, f);
            try {
                const raw = readFileSync(path, "utf-8");
                const parsed = JSON.parse(raw);
                const id = parsed.message_id ?? basename(f, ".json");
                if (id === messageId) {
                    if (!existsSync(this.processedDir))
                        mkdirSync(this.processedDir, { recursive: true });
                    renameSync(path, join(this.processedDir, f));
                    return;
                }
            }
            catch {
                // skip
            }
        }
    }
    async close() {
        // nothing to release
    }
}
