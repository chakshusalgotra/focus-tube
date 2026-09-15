'use strict';

const nodemailer = require('nodemailer');

function serviceFailure(code) {
  return Object.assign(new Error(code), { code });
}

function createAuthServices(environment = process.env, dependencies = {}) {
  const { SMTP_HOST: host, SMTP_FROM: from, SMTP_USER: user, SMTP_PASSWORD: pass,
    TURNSTILE_SITE_KEY: siteKey, TURNSTILE_SECRET_KEY: secretKey } = environment;
  const smtpConfigured = !!(host && from);
  if ((host || from || user || pass) && !smtpConfigured) throw new Error('Set both SMTP_HOST and SMTP_FROM to enable email verification.');
  if (!!user !== !!pass) throw new Error('Set both SMTP_USER and SMTP_PASSWORD for authenticated SMTP.');
  if (!!siteKey !== !!secretKey) throw new Error('Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither.');
  const port = Number(environment.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid port number.');
  if (smtpConfigured && (/[\s<>\r\n]/.test(from) || !/^[^@]+@[^@]+\.[^@]+$/.test(from))) throw new Error('SMTP_FROM must be a single sender email address.');
  const transport = smtpConfigured ? (dependencies.createTransport || nodemailer.createTransport)({
    host, port, secure: environment.SMTP_SECURE === '1' || port === 465,
    requireTLS: true, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    ...(user ? { auth: { user, pass } } : {}),
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, dnsTimeout: 10000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  }) : null;
  const request = dependencies.fetch || globalThis.fetch;
  const observe = dependencies.observe || (() => {});
  let pendingMail = 0;
  let pendingCaptcha = 0;

  return {
    emailConfigured: smtpConfigured,
    captchaSiteKey: siteKey || null,
    async sendVerification({ email, code, origin }) {
      if (!transport) throw serviceFailure('EMAIL_NOT_CONFIGURED');
      if (pendingMail >= 4) throw serviceFailure('AUTH_UNAVAILABLE');
      pendingMail++;
      const started = Date.now();
      try {
        const result = await transport.sendMail({
          from: { name: 'FocusTube', address: from }, to: { address: email },
          subject: 'Verify your FocusTube email',
          text: `Your FocusTube verification code is ${code}.\n\nEnter it in the page where you requested it (${origin}). It expires in 10 minutes and can be used only once.\n\nIf you did not request this code, ignore this email. Do not share the code.`,
          disableFileAccess: true, disableUrlAccess: true,
        });
        if (!result.accepted?.some(address => String(address).toLowerCase() === email)) throw serviceFailure('EMAIL_DELIVERY_FAILED');
        observe('smtp', 'accepted', (Date.now() - started) / 1000);
      } catch {
        observe('smtp', 'failed', (Date.now() - started) / 1000);
        throw serviceFailure('EMAIL_DELIVERY_FAILED');
      } finally { pendingMail--; }
    },
    async verifyCaptcha(token, { origin, action, remoteAddress }) {
      if (!siteKey) return;
      if (typeof token !== 'string' || !token || token.length > 2048) throw serviceFailure('CAPTCHA_REQUIRED');
      if (pendingCaptcha >= 4) throw serviceFailure('AUTH_UNAVAILABLE');
      pendingCaptcha++;
      const started = Date.now();
      try {
        const response = await request('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: secretKey, response: token, remoteip: remoteAddress }),
          redirect: 'error', signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw serviceFailure('CAPTCHA_UNAVAILABLE');
        const result = await response.json();
        const age = Date.now() - Date.parse(result.challenge_ts);
        if (result.success !== true || result.action !== action || result.hostname !== new URL(origin).hostname ||
            !Number.isFinite(age) || age < -60000 || age > 300000) throw serviceFailure('CAPTCHA_FAILED');
          observe('captcha', 'success', (Date.now() - started) / 1000);
      } catch (error) {
          observe('captcha', error.code === 'CAPTCHA_FAILED' ? 'rejected' : 'unavailable', (Date.now() - started) / 1000);
        if (error.code === 'CAPTCHA_FAILED') throw error;
        throw serviceFailure('CAPTCHA_UNAVAILABLE');
      } finally { pendingCaptcha--; }
    },
  };
}

module.exports = { createAuthServices };