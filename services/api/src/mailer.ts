import type { Logger } from './logging.js';

export interface OutboundMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Set for magic links so dev tooling and tests can complete the flow. */
  readonly magicLinkToken?: string;
}

/**
 * Email boundary. There is NO email provider configured for this project — see
 * README "Blockers". Everything goes through this interface so that swapping in
 * Postmark/SES later is a one-file change and nothing else moves.
 */
export interface Mailer {
  readonly name: string;
  send(mail: OutboundMail): Promise<void>;
  /** Messages sent in this process, newest last. Dev + tests only. */
  readonly outbox: readonly OutboundMail[];
}

export function createConsoleMailer(logger: Logger, options: { keep?: number } = {}): Mailer {
  const keep = options.keep ?? 100;
  const outbox: OutboundMail[] = [];
  return {
    name: 'console',
    outbox,
    async send(mail) {
      outbox.push(mail);
      if (outbox.length > keep) outbox.splice(0, outbox.length - keep);
      logger.warn('mailer.console.send', {
        to: mail.to,
        subject: mail.subject,
        note: 'No email provider is configured; this message was logged, not delivered.',
      });
    },
  };
}
