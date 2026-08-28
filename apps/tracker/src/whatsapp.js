/**
 * Sending the reminders over WhatsApp.
 *
 * **What is actually free, stated plainly, because it decides the design.**
 *
 * WhatsApp has no free way for a program to message people on its own. Meta's
 * Cloud API charges per business-initiated message, and a message a business
 * starts must use a template the company has had approved in advance. There is
 * no free tier that a plant tracker can sit on and no unofficial library worth
 * trusting — the ones that drive WhatsApp Web get accounts banned, and the
 * number that would be banned is somebody's personal phone.
 *
 * So this module has two modes, and the free one is the default:
 *
 *  * **`link` — free, works today, needs no account and no approval.** The
 *    server writes each person's message and hands back a `wa.me` link with the
 *    text already in it. Whoever is running the reminder taps the link, WhatsApp
 *    opens on that person's chat with the message written, and they press send.
 *    One tap per person. No approval, no cost, and nothing to be banned for,
 *    because the message is sent by a human from their own WhatsApp.
 *  * **`cloud` / `twilio` — automatic, and not free.** If the company ever gets
 *    a WhatsApp Business number approved, setting the environment variables
 *    turns the same digests into an unattended send. Nothing else changes.
 *
 * The honest consequence: with no paid account, WhatsApp reminders are one tap
 * rather than none. Email is the channel that goes out by itself, and that is
 * why both exist rather than one replacing the other.
 *
 * As with the mailer, **credentials come from the environment only** — never
 * from the database, never returned by the API.
 */

import { DEFAULT_COUNTRY, normalisePhone } from './phone.js';

const PROVIDERS = ['cloud', 'twilio'];

/**
 * How much prefilled text a `wa.me` link carries.
 *
 * WhatsApp itself accepts far more, but the text travels inside a URL and a URL
 * is passed through the browser's address bar, the operating system's link
 * handler and WhatsApp's own parser — the shortest of which is the one that
 * matters. Two thousand characters is comfortably under every one of them, and
 * the digest is written to fit anyway; the cap is a guard, not the plan.
 */
export const MAX_LINK_TEXT = 1800;

/** The free click-to-send link: opens that person's chat, message written. */
export function whatsappLink(phone, text, country = DEFAULT_COUNTRY) {
  const digits = normalisePhone(phone, country);
  if (!digits) return null;
  const body = String(text ?? '').slice(0, MAX_LINK_TEXT);
  return `https://wa.me/${digits}?text=${encodeURIComponent(body)}`;
}

function detectProvider(env) {
  const named = String(env.TRACKER_WHATSAPP_PROVIDER ?? '').trim().toLowerCase();
  if (PROVIDERS.includes(named)) return named;
  if (env.TRACKER_WHATSAPP_TOKEN) return 'cloud';
  if (env.TRACKER_TWILIO_SID) return 'twilio';
  return 'link';
}

/**
 * Meta's WhatsApp Cloud API.
 *
 * Two shapes of message, and which one is allowed depends on who spoke last.
 * Inside the twenty-four hours after a person messages the business number,
 * anything may be sent — that is the `text` shape, and it carries the whole
 * digest. Outside that window, which is where a 5am reminder always falls, only
 * an approved **template** may be sent.
 *
 * Template parameters cannot contain newlines, so the template carries the
 * counts and the link rather than the list itself; the list is in the app, and
 * a WhatsApp message that reproduced it would be scrolled past anyway. Set
 * `TRACKER_WHATSAPP_TEMPLATE` to the approved name and give it four body
 * parameters: name, overdue count, due-soon count, and the number of days.
 */
async function sendCloud(env, message) {
  const version = String(env.TRACKER_WHATSAPP_VERSION ?? 'v21.0').trim();
  const id = encodeURIComponent(String(env.TRACKER_WHATSAPP_PHONE_ID ?? '').trim());
  const template = String(env.TRACKER_WHATSAPP_TEMPLATE ?? '').trim();

  const body = template
    ? {
        messaging_product: 'whatsapp',
        to: message.to,
        type: 'template',
        template: {
          name: template,
          language: { code: String(env.TRACKER_WHATSAPP_TEMPLATE_LANG ?? 'en').trim() },
          components: [
            {
              type: 'body',
              parameters: templateParameters(message).map((text) => ({ type: 'text', text })),
            },
          ],
        },
      }
    : {
        messaging_product: 'whatsapp',
        to: message.to,
        type: 'text',
        text: { preview_url: false, body: message.text },
      };

  const response = await fetch(`https://graph.facebook.com/${version}/${id}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.TRACKER_WHATSAPP_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(explainCloudFailure(response.status, detail));
  }
}

/** The four body parameters, in the order the template is expected to use them. */
export function templateParameters(message) {
  const counts = message.counts ?? {};
  return [
    message.name || 'colleague',
    String(counts.overdue ?? 0),
    String(counts.urgent ?? 0),
    String(message.dailyWithinDays ?? 7),
  ];
}

/**
 * Say what Meta's refusal means.
 *
 * Their errors are numbered and the numbers are not self-explanatory; `131047`
 * in particular reads as a generic failure and is in fact the single most
 * common thing to hit, because it is what you get for sending free-form text
 * outside the 24-hour window — which is every scheduled reminder.
 */
export function explainCloudFailure(status, detail) {
  const raw = String(detail ?? '').slice(0, 400);
  const hint = (() => {
    if (/131047|Re-engagement message/i.test(raw)) {
      return 'WhatsApp only allows free-form text within 24 hours of that person messaging your business number. A scheduled reminder is always outside it — set TRACKER_WHATSAPP_TEMPLATE to an approved template name.';
    }
    if (/132001|template name does not exist|Template not found/i.test(raw)) {
      return 'No approved template by that name in this language. Check TRACKER_WHATSAPP_TEMPLATE and TRACKER_WHATSAPP_TEMPLATE_LANG against the WhatsApp Manager, where a template also has to be Approved rather than Pending.';
    }
    if (/132000|number of parameters/i.test(raw)) {
      return 'The template expects a different number of body parameters. This app sends four: name, overdue count, due-soon count, days.';
    }
    if (status === 401 || /190|access token/i.test(raw)) {
      return 'The access token was rejected. A temporary token from the Meta dashboard lasts 24 hours — a permanent one comes from a System User.';
    }
    if (/131030|not in allowed list/i.test(raw)) {
      return 'That number is not on the test-number allow-list. An unverified WhatsApp app may only message numbers you have added in the Meta dashboard.';
    }
    return null;
  })();

  return hint ? `WhatsApp refused the message (${status}): ${raw}\n\n${hint}` : `WhatsApp refused the message (${status}): ${raw}`;
}

/**
 * Twilio, which is the usual way in before a company number is approved.
 *
 * Its sandbox number is free to test with, and each person joins by sending a
 * code word to it once. That opt-in expires after 72 hours, so the sandbox is
 * for proving the plumbing, not for running a department on.
 */
async function sendTwilio(env, message) {
  const sid = String(env.TRACKER_TWILIO_SID ?? '').trim();
  const from = String(env.TRACKER_TWILIO_FROM ?? '').trim();
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${env.TRACKER_TWILIO_TOKEN}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      From: from.startsWith('whatsapp:') ? from : `whatsapp:+${normalisePhone(from) ?? from}`,
      To: `whatsapp:+${message.to}`,
      Body: message.text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Twilio refused the message (${response.status}): ${detail.slice(0, 300)}`);
  }
}

const SENDERS = { cloud: sendCloud, twilio: sendTwilio };

/** What is missing before this transport could send anything by itself. */
function problemWith(provider, env) {
  if (provider === 'link') {
    return 'WhatsApp messages are prepared as links for you to tap and send. Sending them automatically needs a WhatsApp Business account, which Meta charges for — set TRACKER_WHATSAPP_TOKEN and TRACKER_WHATSAPP_PHONE_ID once you have one.';
  }
  if (provider === 'cloud') {
    for (const [key, name] of [
      ['TRACKER_WHATSAPP_TOKEN', 'access token'],
      ['TRACKER_WHATSAPP_PHONE_ID', 'phone number ID'],
    ]) {
      if (!String(env[key] ?? '').trim()) return `Set ${key} — the ${name} from the Meta app dashboard.`;
    }
  }
  if (provider === 'twilio') {
    for (const [key, name] of [
      ['TRACKER_TWILIO_SID', 'account SID'],
      ['TRACKER_TWILIO_TOKEN', 'auth token'],
      ['TRACKER_TWILIO_FROM', 'WhatsApp sender number'],
    ]) {
      if (!String(env[key] ?? '').trim()) return `Set ${key} — the ${name} from the Twilio console.`;
    }
  }
  return null;
}

/**
 * Build the WhatsApp sender.
 *
 * Like the mailer, it never throws on a missing transport: `link` is a working
 * mode rather than a broken one, so `configured` is false — nothing sends
 * unattended — while `links` are produced regardless.
 */
export function createWhatsapp(env = process.env) {
  const provider = detectProvider(env);
  const problem = problemWith(provider, env);
  const country = String(env.TRACKER_WHATSAPP_COUNTRY ?? DEFAULT_COUNTRY).replace(/\D/g, '') || DEFAULT_COUNTRY;

  return {
    provider,
    country,
    /** True only when messages can go out with nobody watching. */
    configured: !problem,
    /** True in every mode: the free links are always available. */
    canPrepareLinks: true,
    problem,
    templated: Boolean(String(env.TRACKER_WHATSAPP_TEMPLATE ?? '').trim()),

    link: (phone, text) => whatsappLink(phone, text, country),

    async send(message) {
      if (problem) throw new Error(problem);
      await SENDERS[provider](env, message);
    },

    /** Serial, collecting failures — one bad number must not cost the rest. */
    async sendAll(messages) {
      const sent = [];
      const failed = [];
      for (const message of messages) {
        try {
          await this.send(message);
          sent.push(message.to);
        } catch (error) {
          failed.push({ to: message.to, error: String(error?.message ?? error) });
        }
      }
      return { sent, failed };
    },
  };
}
