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
  send(msg: OutboundMessage): Promise<{ message_id: string }>;

  /** Mark an inbound message as fully processed so it isn't re-delivered. */
  ack(messageId: string): Promise<void>;

  close(): Promise<void>;
}

// ----- FileTransport --------------------------------------------------------

export class FileTransport implements MessageTransport {
  private inboxDir: string;
  private outboxDir: string;
  private processedDir: string;

  constructor(rootDir: string) {
    this.inboxDir = resolve(rootDir, "inbox");
    this.outboxDir = resolve(rootDir, "outbox");
    this.processedDir = resolve(rootDir, "processed");
    for (const d of [this.inboxDir, this.outboxDir, this.processedDir]) {
      mkdirSync(d, { recursive: true });
    }
  }

  async poll(): Promise<InboundMessage[]> {
    const files = readdirSync(this.inboxDir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort(); // lexical = chronological if the producer uses ISO timestamps in the filename
    const out: InboundMessage[] = [];
    for (const f of files) {
      const path = join(this.inboxDir, f);
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw) as Partial<InboundMessage>;
        if (!parsed.from || !parsed.to || !parsed.body_text) {
          // malformed — leave it in the inbox so the user can fix it
          continue;
        }
        const msg: InboundMessage = {
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
      } catch {
        // skip unreadable files
      }
    }
    return out;
  }

  async send(msg: OutboundMessage): Promise<{ message_id: string }> {
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

  async ack(messageId: string): Promise<void> {
    const files = readdirSync(this.inboxDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const path = join(this.inboxDir, f);
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw) as Partial<InboundMessage>;
        const id = parsed.message_id ?? basename(f, ".json");
        if (id === messageId) {
          if (!existsSync(this.processedDir)) mkdirSync(this.processedDir, { recursive: true });
          renameSync(path, join(this.processedDir, f));
          return;
        }
      } catch {
        // skip
      }
    }
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
