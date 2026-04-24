// IMAP/SMTP MessageTransport for Gmail.
//
// poll()  — fetches UNSEEN messages from INBOX via imapflow, parses MIME
//           bodies via mailparser, returns InboundMessage[]. The IMAP UID
//           becomes our message_id (so ack() knows which message to mark).
// send()  — nodemailer over smtp.gmail.com:465 (SSL). Threading via
//           in-reply-to / references headers so Gmail keeps the conversation
//           grouped.
// ack()   — adds the \Seen flag, which is what makes Gmail / mail clients
//           treat the message as "read" and (more importantly) what causes
//           our next poll() to skip it.
// close() — logs out of IMAP and closes the SMTP pool.
//
// Authentication is via app password (a 16-char single-purpose credential
// generated at https://myaccount.google.com/apppasswords). Two-step
// verification must be enabled on the Google account before the entry
// becomes available. See .env.example for the env vars this transport
// reads.

import { ImapFlow, type ImapFlowOptions } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { simpleParser } from "mailparser";
import type { InboundMessage, OutboundMessage, MessageTransport } from "./mail-transport.js";

export type ImapTransportOptions = {
  user: string;
  password: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  // If true (default), poll() ignores any messages whose UID is <= the
  // mailbox's highest UID at connection time, so a long-running driver does
  // not retroactively process inbox backlog. Set to false to process all
  // unseen mail, including pre-existing backlog (useful for one-shot cleanup
  // or tests).
  skipBacklog?: boolean;
  // If set, poll() only returns messages whose `To:` header contains this
  // substring. Intended for Gmail plus-addressing (e.g. "+marketplace" so
  // only mail sent to shellparkliu+marketplace@gmail.com is picked up, and
  // unrelated inbox traffic — system notifications, OTPs, etc — is ignored).
  toAliasFilter?: string;
  // Sender addresses matching this regex are always skipped, even if the
  // toAliasFilter matches. Intended to avoid bouncing on delivery-status
  // notifications and automated mailers. Defaults to common no-reply forms.
  ignoreSenderRe?: RegExp;
};

const DEFAULT_IGNORE_SENDER = /(^|[._-])(no[._-]?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)([._-]|@)/i;

export class ImapTransport implements MessageTransport {
  private imap!: ImapFlow;
  private smtp: Transporter;
  private user: string;
  private imapOpts: ImapFlowOptions;
  private skipBacklog: boolean;
  private toAliasFilter: string | undefined;
  private ignoreSenderRe: RegExp;
  private baselineUid: number | undefined;
  private connected = false;

  constructor(opts: ImapTransportOptions) {
    this.user = opts.user;
    this.skipBacklog = opts.skipBacklog ?? true;
    this.toAliasFilter = opts.toAliasFilter;
    this.ignoreSenderRe = opts.ignoreSenderRe ?? DEFAULT_IGNORE_SENDER;
    // App passwords from Google's UI come space-separated (e.g. "abcd efgh ...").
    // Strip whitespace defensively so callers don't have to.
    const pass = opts.password.replace(/\s+/g, "");

    this.imapOpts = {
      host: opts.imapHost ?? "imap.gmail.com",
      port: opts.imapPort ?? 993,
      secure: true,
      auth: { user: opts.user, pass },
      logger: false,
    };
    this.rebuildImap();

    this.smtp = nodemailer.createTransport({
      host: opts.smtpHost ?? "smtp.gmail.com",
      port: opts.smtpPort ?? 465,
      secure: true,
      auth: { user: opts.user, pass },
    });
  }

  private rebuildImap(): void {
    this.imap = new ImapFlow(this.imapOpts);
    // A dropped connection leaves imapflow in a state where subsequent calls
    // hang or throw. Flipping `connected` on close/error triggers a rebuild
    // on the next operation, and `withReconnect` retries once.
    this.imap.on("close", () => {
      this.connected = false;
    });
    this.imap.on("error", (err: Error) => {
      console.warn(`[imap-transport] connection error: ${err.message}`);
      this.connected = false;
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    // imapflow instances are single-shot: after a close, we need a fresh one.
    this.rebuildImap();
    await this.imap.connect();
    this.connected = true;

    // Establish the UID baseline: anything with UID <= baselineUid was in
    // the mailbox before the driver started and should be ignored when
    // skipBacklog is on. UIDs in IMAP are monotonic per mailbox, so this is
    // immune to clock skew between our host and the mail server. Only set
    // on the FIRST connection — reconnects must preserve the baseline, or we
    // would re-expose already-processed mail.
    if (this.skipBacklog && this.baselineUid === undefined) {
      const lock = await this.imap.getMailboxLock("INBOX");
      try {
        const status = await this.imap.status("INBOX", { uidNext: true });
        if (typeof status.uidNext === "number" && status.uidNext > 0) {
          this.baselineUid = status.uidNext - 1;
        }
      } finally {
        lock.release();
      }
    }
  }

  /**
   * Run an IMAP operation with one automatic reconnect on failure. A
   * long-running driver will hit transient network errors (Gmail closes idle
   * connections after ~29 minutes, Wi-Fi blips, etc.); rather than bubbling
   * them up as fatal, we flush the connection state and try once more.
   */
  private async withReconnect<T>(op: () => Promise<T>, label: string): Promise<T> {
    try {
      await this.ensureConnected();
      return await op();
    } catch (err) {
      console.warn(`[imap-transport] ${label} failed, reconnecting: ${(err as Error).message}`);
      this.connected = false;
      try {
        await this.imap.logout();
      } catch {
        // best-effort; a broken connection can't be cleanly closed
      }
      await this.ensureConnected();
      return await op();
    }
  }

  async poll(): Promise<InboundMessage[]> {
    return this.withReconnect(() => this.pollOnce(), "poll");
  }

  private async pollOnce(): Promise<InboundMessage[]> {
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      const out: InboundMessage[] = [];
      for await (const msg of this.imap.fetch({ seen: false }, { envelope: true, source: true, uid: true })) {
        if (!msg.source) continue;
        if (this.skipBacklog && this.baselineUid !== undefined && msg.uid <= this.baselineUid) {
          continue;
        }
        let bodyText: string;
        let inReplyTo: string | undefined;
        let messageId: string | undefined;
        try {
          const parsed = await simpleParser(msg.source);
          bodyText = (parsed.text ?? "").trim();
          if (!bodyText && parsed.html) {
            // very rough HTML strip — only used as a fallback when there's no plain text part
            bodyText = String(parsed.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          }
          inReplyTo = Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo[0] : parsed.inReplyTo;
          messageId = parsed.messageId;
        } catch {
          // mailparser failed; skip this message rather than poison the loop
          continue;
        }

        const fromAddr = msg.envelope?.from?.[0]?.address ?? "(unknown)";
        const allToAddrs = (msg.envelope?.to ?? []).map((t) => t.address ?? "").filter(Boolean);
        const toAddr = allToAddrs[0] ?? this.user;
        const subject = msg.envelope?.subject ?? "(no subject)";
        const rawDate = msg.envelope?.date ?? new Date();
        const date = rawDate instanceof Date ? rawDate : new Date(rawDate);

        if (this.ignoreSenderRe.test(fromAddr)) continue;
        if (this.toAliasFilter) {
          const alias = this.toAliasFilter;
          if (!allToAddrs.some((addr) => addr.toLowerCase().includes(alias.toLowerCase()))) continue;
        }

        out.push({
          // IMAP UID is per-mailbox stable and what we need for ack(). Prefix
          // so we can recognize "uid:N" later if we want to be defensive.
          message_id: `uid:${msg.uid}`,
          from: fromAddr,
          to: toAddr,
          subject,
          body_text: bodyText,
          received_at: date.toISOString(),
          thread_id: messageId,
          in_reply_to: inReplyTo,
        });
      }
      return out;
    } finally {
      lock.release();
    }
  }

  async send(msg: OutboundMessage): Promise<{ message_id: string }> {
    // nodemailer occasionally fails with ETIMEDOUT / ESOCKET on IPv6 routes
    // even when the next attempt succeeds. One retry is enough to cover that.
    try {
      return await this.sendOnce(msg);
    } catch (err) {
      console.warn(`[imap-transport] smtp send failed, retrying once: ${(err as Error).message}`);
      return await this.sendOnce(msg);
    }
  }

  private async sendOnce(msg: OutboundMessage): Promise<{ message_id: string }> {
    const info = await this.smtp.sendMail({
      from: this.user,
      to: msg.to,
      subject: msg.subject,
      text: msg.body_text,
      inReplyTo: msg.in_reply_to,
      references: msg.in_reply_to ? [msg.in_reply_to] : undefined,
    });
    return { message_id: info.messageId ?? `smtp_${Date.now().toString(36)}` };
  }

  async ack(messageId: string): Promise<void> {
    const m = messageId.match(/^uid:(\d+)$/);
    if (!m) return; // not one of our IDs
    const uid = m[1];
    await this.withReconnect(() => this.ackOnce(uid), "ack");
  }

  private async ackOnce(uid: string): Promise<void> {
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      await this.imap.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  }

  async close(): Promise<void> {
    if (this.connected) {
      try {
        await this.imap.logout();
      } catch {
        // best-effort
      }
      this.connected = false;
    }
    try {
      this.smtp.close();
    } catch {
      // best-effort
    }
  }
}
