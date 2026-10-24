'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

/* =============================================================
   1. CONFIG
   ============================================================= */
const env = (key, fallback = '') => String(process.env[key] ?? fallback).trim();

function required(key) {
  const v = env(key);
  if (!v) {
    console.error(`[config] ${key} is not set (add it in Railway Variables or .env)`);
    process.exit(1);
  }
  return v;
}

const BOT_TOKEN = required('BOT_TOKEN');
const SUPABASE_URL = required('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = required('SUPABASE_SERVICE_KEY');
const OWNER_IDS = required('OWNER_IDS')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
if (!OWNER_IDS.length) {
  console.error('[config] OWNER_IDS needs at least one valid Telegram user ID');
  process.exit(1);
}

const DEFAULT_VIP_CHANNEL_ID = env('VIP_CHANNEL_ID');
const ENV_APPROVAL_CHANNEL_ID = env('APPROVAL_CHANNEL_ID');
const INVITE_TTL_MIN = Number(env('INVITE_TTL_MIN', '30'));
const MAX_LINKS_PER_DAY = Number(env('MAX_LINKS_PER_DAY', '3'));
const MAX_LINKS_TOTAL = Number(env('MAX_LINKS_TOTAL', '6'));
const MAX_STRIKES = Number(env('MAX_STRIKES', '3'));
const ALLOWED_DOMAINS = env('ALLOWED_DOMAINS')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const MOD_CHAT_IDS = env('MODERATED_CHAT_IDS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Default referral links are the official sites (placeholders). Change them from /settings.
const PLATFORMS = [
  { key: 'blofin', name: 'BloFin', defaultRef: 'https://blofin.com' },
  { key: 'txflow', name: 'Txflow', defaultRef: 'https://txflow.com' },
  { key: 'bybit', name: 'Bybit', defaultRef: 'https://www.bybit.com' },
  { key: 'okx', name: 'OKX', defaultRef: 'https://www.okx.com' },
  { key: 'hyperliquid', name: 'Hyperliquid', defaultRef: 'https://hyperliquid.xyz' },
];
const P = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));

const DEFAULT_STEPS = 'Complete KYC verification.\nMake a deposit if required.';

const DEFAULT_MSG = {
  welcome:
    'Welcome to Vigil Access.\n\nGet verified for private VIP access in three steps:\n1. Choose your platform\n2. Sign up with our link and send your UID or wallet address\n3. Once approved, you receive a private one-time invite link\n\nChoose your platform below.',
  submitted:
    'Thank you. Your {platform} details have been submitted for review.\n\nYou will receive a message here as soon as a decision is made.',
  approved:
    'You are approved for {platform}.\n\nTap the button below to join the VIP channel. This link works for one person only and expires after you join, or in {minutes} minutes.',
  rejected:
    'Sorry, you are rejected. Your {platform} request was not approved.\n\nIf you believe this is a mistake, please contact the team.',
};

const MSG_LABELS = {
  welcome: 'Welcome message',
  submitted: 'Submitted message',
  approved: 'Approved message',
  rejected: 'Rejected message',
};

/* =============================================================
   2. HELPERS
   ============================================================= */
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const bot = new Telegraf(BOT_TOKEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

async function countRows(table, filter) {
  let q = db.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

const userLabel = (u) => (u?.username ? `@${u.username}` : u?.first_name || String(u?.telegram_id ?? 'unknown'));
const stamp = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const render = (t, vars) => String(t).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));

let lastAlertAt = 0;
async function alertOwners(text, throttle = false) {
  if (throttle) {
    if (Date.now() - lastAlertAt < 60_000) return;
    lastAlertAt = Date.now();
  }
  for (const id of OWNER_IDS) {
    await bot.telegram.sendMessage(id, text).catch((e) => console.error(`[alert] owner ${id}:`, e.message));
  }
}

/* ---- Settings (stored in DB, cached in memory) ---- */
const settings = new Map();

async function loadSettings() {
  const rows = unwrap(await db.from('settings').select('key, value'));
  settings.clear();
  rows.forEach((r) => settings.set(r.key, r.value));
}
const getSetting = (k, d = '') => (settings.has(k) ? settings.get(k) : d);

async function setSetting(k, v) {
  unwrap(
    await db.from('settings').upsert({ key: k, value: v, updated_at: new Date().toISOString() }, { onConflict: 'key' }).select()
  );
  settings.set(k, v);
}
async function resetSetting(k) {
  unwrap(await db.from('settings').delete().eq('key', k).select());
  settings.delete(k);
}

const getRef = (k) => getSetting(`ref:${k}`, P[k].defaultRef);
const getSteps = (k) => getSetting(`steps:${k}`, DEFAULT_STEPS);
const getVip = (k) => getSetting(`vip:${k}`) || env(`${k.toUpperCase()}_VIP_CHANNEL_ID`) || DEFAULT_VIP_CHANNEL_ID;
const getApproval = () => getSetting('approval_channel') || ENV_APPROVAL_CHANNEL_ID;
const getTtl = () => Number(getSetting('link_ttl_min', String(INVITE_TTL_MIN)));
const getMsg = (name, vars = {}) => render(getSetting(`msg:${name}`, DEFAULT_MSG[name]), vars);

/* ---- Staff (owners from env, admins from DB) ---- */
const staff = new Set();
async function loadStaff() {
  const rows = unwrap(await db.from('staff').select('telegram_id'));
  staff.clear();
  rows.forEach((r) => staff.add(Number(r.telegram_id)));
}
const isOwner = (id) => OWNER_IDS.includes(Number(id));
const isStaff = (id) => isOwner(id) || staff.has(Number(id));

const staffOnly = (fn) => async (ctx) => {
  if (ctx.chat?.type !== 'private' || !isStaff(ctx.from?.id)) return;
  return fn(ctx);
};
const ownerOnly = (fn) => async (ctx) => {
  if (ctx.chat?.type !== 'private' || !isOwner(ctx.from?.id)) return;
  return fn(ctx);
};
const staffAction = (fn) => async (ctx) => {
  if (ctx.chat?.type !== 'private' || !isStaff(ctx.from?.id)) {
    return ctx.answerCbQuery('Not allowed.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
  return fn(ctx);
};

// Show text by editing the current message (if button tap) or sending a new one
async function show(ctx, text, extra = {}) {
  const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra };
  if (ctx.callbackQuery?.message) {
    try {
      return await ctx.editMessageText(text, opts);
    } catch (e) {
      if (/not modified/i.test(e.message)) return;
    }
  }
  return ctx.reply(text, opts);
}

/* =============================================================
   3. DATABASE
   ============================================================= */
async function upsertUser(from) {
  return unwrap(
    await db
      .from('bot_users')
      .upsert(
        {
          telegram_id: from.id,
          username: from.username || null,
          first_name: from.first_name || null,
          blocked: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'telegram_id' }
      )
      .select()
      .single()
  );
}

async function setState(telegramId, state) {
  unwrap(await db.from('bot_users').update({ state }).eq('telegram_id', telegramId).select());
}

async function findSubmission(telegramId, platform, statuses) {
  return unwrap(
    await db
      .from('submissions')
      .select('*')
      .eq('telegram_id', telegramId)
      .eq('platform', platform)
      .in('status', statuses)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

/* =============================================================
   4. INVITE LINKS (new link for every approval: 1 member, short expiry)
   ============================================================= */
async function isChannelMember(channelId, userId) {
  try {
    const m = await bot.telegram.getChatMember(channelId, userId);
    return ['member', 'administrator', 'creator', 'restricted'].includes(m.status) && m.is_member !== false;
  } catch {
    return false;
  }
}

// Returns true if the user was messaged successfully
async function deliverInvite(userId, pk) {
  const p = P[pk];
  const channelId = getVip(pk);
  try {
    if (!channelId) throw new Error(`No VIP channel is set for ${p.name}`);

    if (await isChannelMember(channelId, userId)) {
      await bot.telegram.sendMessage(userId, `You are already in the ${p.name} VIP channel.`);
      return true;
    }

    const daySince = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const perDay = await countRows('invites', (q) =>
      q.eq('telegram_id', userId).eq('platform', pk).gte('created_at', daySince)
    );
    const total = await countRows('invites', (q) => q.eq('telegram_id', userId).eq('platform', pk));
    if (perDay >= MAX_LINKS_PER_DAY || total >= MAX_LINKS_TOTAL) {
      await bot.telegram.sendMessage(userId, 'You have reached the invite link limit. Please contact the team.');
      return true;
    }

    const ttl = getTtl();
    const expireUnix = Math.floor(Date.now() / 1000) + ttl * 60;
    const invite = await bot.telegram.createChatInviteLink(channelId, {
      member_limit: 1,
      expire_date: expireUnix,
      name: `${pk}-${userId}`.slice(0, 32),
    });

    unwrap(
      await db
        .from('invites')
        .insert({
          telegram_id: userId,
          platform: pk,
          link: invite.invite_link,
          expires_at: new Date(expireUnix * 1000).toISOString(),
        })
        .select()
    );

    await bot.telegram.sendMessage(userId, esc(getMsg('approved', { platform: p.name, minutes: ttl })), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.url(`Join ${p.name} VIP channel`, invite.invite_link)]]),
    });
    return true;
  } catch (e) {
    console.error('[invite] failed:', e);
    const delivered = await bot.telegram
      .sendMessage(
        userId,
        'You are approved, but we could not create your invite link right now. The team has been notified. Please try again in a few minutes.'
      )
      .then(() => true)
      .catch(() => false);
    await alertOwners(
      `Invite link failed (${p.name}, user ${userId}): ${e.message}\nCheck that the bot is an admin of the VIP channel with the "Invite users via link" permission.`,
      true
    );
    return delivered;
  }
}

/* =============================================================
   5. APPROVAL CARDS
   ============================================================= */
function approvalButtons(id) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Accept', `ac:${id}`), Markup.button.callback('Reject', `rj:${id}`)],
  ]);
}

function cardText(row, user, prev, statusHtml) {
  const kindLabel = row.kind === 'uid' ? 'UID' : 'Wallet address';
  return (
    `<b>New sign-up #${row.id}</b>\n\n` +
    `Platform: <b>${esc(P[row.platform]?.name || row.platform)}</b>\n` +
    `${kindLabel}: <code>${esc(row.value)}</code>\n\n` +
    `User: <a href="tg://user?id=${row.telegram_id}">${esc(user?.first_name || 'User')}</a> (${
      user?.username ? '@' + esc(user.username) : 'no username'
    })\n` +
    `Telegram ID: <code>${row.telegram_id}</code>\n` +
    `Submitted: ${stamp(row.created_at)}\n` +
    `Earlier requests: ${prev}\n\n` +
    statusHtml
  );
}

async function prevCount(row) {
  return countRows('submissions', (q) => q.eq('telegram_id', row.telegram_id).neq('id', row.id));
}

async function getUserRow(id) {
  return unwrap(await db.from('bot_users').select('*').eq('telegram_id', id).maybeSingle());
}

async function canDecide(userId) {
  if (isStaff(userId)) return true;
  const ch = getApproval();
  if (!ch) return false;
  try {
    const m = await bot.telegram.getChatMember(ch, userId);
    return ['member', 'administrator', 'creator'].includes(m.status);
  } catch {
    return false;
  }
}

async function decideSubmission(id, status, byId, byName) {
  return unwrap(
    await db
      .from('submissions')
      .update({ status, decided_by: byId, decided_by_name: byName, decided_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .maybeSingle()
  );
}

async function refreshCard(row, notified) {
  if (!row.approval_chat_id || !row.approval_message_id) return;
  const user = await getUserRow(row.telegram_id);
  const prev = await prevCount(row);
  const verdict = row.status === 'approved' ? 'ACCEPTED' : 'REJECTED';
  const status =
    `Status: <b>${verdict}</b> by ${esc(row.decided_by_name)}\n${stamp(row.decided_at)}` +
    (notified ? '' : '\nNote: the user could not be messaged (they may have blocked the bot).');
  await bot.telegram
    .editMessageText(row.approval_chat_id, row.approval_message_id, undefined, cardText(row, user, prev, status), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    .catch((e) => console.error('[card] edit failed:', e.message));
}

bot.action(/^(ac|rj):(\d+)$/, async (ctx) => {
  if (!(await canDecide(ctx.from.id))) {
    return ctx.answerCbQuery('You are not allowed to do this.', { show_alert: true });
  }
  const accept = ctx.match[1] === 'ac';
  const id = Number(ctx.match[2]);
  const byName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || String(ctx.from.id);

  const row = await decideSubmission(id, accept ? 'approved' : 'rejected', ctx.from.id, byName);
  if (!row) return ctx.answerCbQuery('This request was already decided.', { show_alert: true });
  await ctx.answerCbQuery(accept ? 'Accepted' : 'Rejected').catch(() => {});

  let notified;
  if (accept) {
    notified = await deliverInvite(row.telegram_id, row.platform);
  } else {
    notified = await bot.telegram
      .sendMessage(row.telegram_id, esc(getMsg('rejected', { platform: P[row.platform].name })), { parse_mode: 'HTML' })
      .then(() => true)
      .catch(() => false);
  }

  await refreshCard(row, notified);

  // If the button was tapped from a private chat copy (/pending), update that copy too
  const msg = ctx.callbackQuery.message;
  if (msg && msg.chat.id !== Number(row.approval_chat_id)) {
    await ctx.editMessageText(`Request #${row.id} ${accept ? 'ACCEPTED' : 'REJECTED'} by ${byName}.`).catch(() => {});
  }
});

/* =============================================================
   6. USER FLOW
   ============================================================= */
const attempts = new Map();
function allowAttempt(id) {
  const now = Date.now();
  const list = (attempts.get(id) || []).filter((t) => now - t < 10 * 60_000);
  if (list.length >= 6) {
    attempts.set(id, list);
    return false;
  }
  list.push(now);
  attempts.set(id, list);
  return true;
}

function homeKeyboard() {
  const buttons = PLATFORMS.map((p) => Markup.button.callback(p.name, `pf:${p.key}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return Markup.inlineKeyboard(rows);
}

async function showHome(ctx) {
  await show(
    ctx,
    `${esc(getMsg('welcome'))}\n\n<i>Trading involves risk. Nothing here is financial advice.</i>`,
    homeKeyboard()
  );
}

function platformText(pk) {
  const p = P[pk];
  const ref = getRef(pk);
  const link = ref ? `<a href="${esc(ref)}">Sign up on ${esc(p.name)}</a>` : 'The sign-up link will be shared soon.';
  const steps = getSteps(pk)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `• ${esc(s)}`)
    .join('\n');
  return (
    `<b>${esc(p.name)}</b>\n\n` +
    `<b>Step 1.</b> Create your account with our link:\n${link}\n\n` +
    (steps ? `<b>Step 2.</b>\n${steps}\n\n` : '') +
    `<b>Step 3.</b> Submit your UID or wallet address using the buttons below.\n\n` +
    `<i>Never share passwords, OTP codes, seed phrases or private keys.</i>`
  );
}

bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await setState(ctx.from.id, 'idle');
  await showHome(ctx);
});

bot.help(async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  let text = 'Send /start to begin. Use /cancel to stop what you are doing.';
  if (isStaff(ctx.from.id)) {
    text +=
      '\n\nStaff commands:\n' +
      '/settings - edit links, channels and messages\n' +
      '/stats - summary numbers\n' +
      '/pending - pending sign-ups\n' +
      '/export [platform] - download CSV (opens in Excel)\n' +
      '/find <uid, wallet or telegram id>\n' +
      '/user <telegram id>\n' +
      '/ban <id> and /unban <id>\n' +
      '/broadcast <text>\n' +
      '/health - setup check\n' +
      '/admins - list admins';
    if (isOwner(ctx.from.id)) {
      text += '\n\nOwner commands:\n/addadmin <id>\n/removeadmin <id>\n/setapproval - choose the approval channel';
    }
  }
  await ctx.reply(text);
});

bot.command('cancel', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await setState(ctx.from.id, 'idle');
  await ctx.reply('Cancelled. Send /start to begin again.');
});

bot.command('chatid', async (ctx) => {
  if (ctx.chat.type === 'channel') return; // handled in the channel_post handler
  await ctx.reply(`Chat ID: ${ctx.chat.id}`);
});

bot.action('home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat?.type !== 'private') return;
  await setState(ctx.from.id, 'idle');
  await showHome(ctx);
});

bot.action(/^pf:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat?.type !== 'private') return;
  const pk = ctx.match[1];
  const p = P[pk];
  if (!p) return;
  await setState(ctx.from.id, 'idle');

  const approved = await findSubmission(ctx.from.id, pk, ['approved']);
  if (approved) {
    return show(
      ctx,
      `You are already approved for <b>${esc(p.name)}</b>.\n\nIf you did not join yet or your link expired, you can request a new one.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Send me a new invite link', `lk:${pk}`)],
        [Markup.button.callback('Back', 'home')],
      ])
    );
  }

  const pending = await findSubmission(ctx.from.id, pk, ['pending']);
  if (pending) {
    return show(
      ctx,
      `Your <b>${esc(p.name)}</b> request is under review. You will get a message here as soon as there is a decision.`,
      Markup.inlineKeyboard([[Markup.button.callback('Back', 'home')]])
    );
  }

  await show(
    ctx,
    platformText(pk),
    Markup.inlineKeyboard([
      [Markup.button.callback('Enter UID', `in:${pk}:uid`), Markup.button.callback('Enter wallet address', `in:${pk}:wallet`)],
      [Markup.button.callback('Back', 'home')],
    ])
  );
});

bot.action(/^lk:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat?.type !== 'private') return;
  const pk = ctx.match[1];
  if (!P[pk]) return;
  const approved = await findSubmission(ctx.from.id, pk, ['approved']);
  if (!approved) return;
  await deliverInvite(ctx.from.id, pk);
});

bot.action(/^in:(\w+):(uid|wallet)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat?.type !== 'private') return;
  const [, pk, kind] = ctx.match;
  const p = P[pk];
  if (!p) return;
  await setState(ctx.from.id, `input:${pk}:${kind}`);
  const prompt =
    kind === 'uid'
      ? `Send your <b>${esc(p.name)} UID</b> (numbers only).`
      : `Send your <b>public wallet address</b> for ${esc(p.name)}.\n\n<i>Never send a private key or seed phrase.</i>`;
  await show(ctx, prompt, Markup.inlineKeyboard([[Markup.button.callback('Cancel', `pf:${pk}`)]]));
});

function looksLikeSecret(t) {
  const s = t.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return true; // private key
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s)) return true; // WIF key
  const words = s.split(/\s+/);
  return words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]{3,8}$/i.test(w)); // seed phrase
}

function parseValue(kind, raw) {
  const s = raw.trim();
  if (kind === 'uid') {
    const v = s.replace(/\s+/g, '');
    if (!/^\d{4,20}$/.test(v)) return { ok: false, error: 'A UID contains digits only (4 to 20 digits). Please send it again.' };
    return { ok: true, value: v, norm: v };
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return { ok: true, value: s, norm: s.toLowerCase() };
  if (/^[A-Za-z0-9]{26,64}$/.test(s)) return { ok: true, value: s, norm: s };
  return { ok: false, error: 'That does not look like a valid wallet address. Please send your public address only.' };
}

async function handleInput(ctx, pk, kind) {
  const p = P[pk];
  const raw = ctx.message.text || '';

  if (looksLikeSecret(raw)) {
    await ctx.deleteMessage().catch(() => {});
    return ctx.reply(
      'Stop. That looks like a private key or seed phrase. Never share it with anyone, including us. I deleted your message. If it was real, move your funds to a new wallet.\n\nSend your public wallet address or UID instead.'
    );
  }

  const parsed = parseValue(kind, raw);
  if (!parsed.ok) return ctx.reply(parsed.error);
  if (!allowAttempt(ctx.from.id)) return ctx.reply('Too many attempts. Please try again in 10 minutes.');

  const approvalChat = getApproval();
  if (!approvalChat) {
    await alertOwners('A user tried to sign up but no approval channel is set. Use /setapproval.', true);
    return ctx.reply('Sign-ups are temporarily unavailable. Please try again later.');
  }

  const owner = unwrap(
    await db
      .from('submissions')
      .select('id, telegram_id')
      .eq('platform', pk)
      .eq('value_norm', parsed.norm)
      .in('status', ['pending', 'approved'])
      .maybeSingle()
  );
  if (owner && owner.telegram_id !== ctx.from.id) {
    return ctx.reply('This UID or wallet is already linked to another account. If you think this is a mistake, please contact the team.');
  }

  let row;
  try {
    row = unwrap(
      await db
        .from('submissions')
        .insert({ telegram_id: ctx.from.id, platform: pk, kind, value: parsed.value, value_norm: parsed.norm })
        .select()
        .single()
    );
  } catch (e) {
    if (e.code === '23505') return ctx.reply(`You already have a request for ${p.name}.`);
    throw e;
  }

  try {
    const prev = await prevCount(row);
    const sent = await bot.telegram.sendMessage(
      approvalChat,
      cardText(row, ctx.state.user, prev, 'Status: <b>PENDING</b>'),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...approvalButtons(row.id) }
    );
    unwrap(
      await db
        .from('submissions')
        .update({ approval_chat_id: sent.chat.id, approval_message_id: sent.message_id })
        .eq('id', row.id)
        .select()
    );
  } catch (e) {
    console.error('[approval] could not post card:', e.message);
    await db.from('submissions').delete().eq('id', row.id);
    await alertOwners(
      `Could not post a sign-up to the approval channel: ${e.message}\nMake sure the bot is an admin there with permission to post. You can set the channel again with /setapproval.`,
      true
    );
    return ctx.reply('Sign-ups are temporarily unavailable. Please try again later.');
  }

  await setState(ctx.from.id, 'idle');
  await ctx.reply(esc(getMsg('submitted', { platform: p.name })), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('Back to menu', 'home')]]),
  });
}

/* =============================================================
   7. SETTINGS (edited from inside the bot by owners and admins)
   ============================================================= */
function settingMeta(key) {
  const [type, part] = key.split(':');
  if (type === 'ref' && P[part]) {
    return { label: `${P[part].name} referral link`, check: (v) => (/^https:\/\/\S+$/i.test(v) ? null : 'Send a full link starting with https://') };
  }
  if (type === 'vip' && P[part]) {
    return { label: `${P[part].name} VIP channel ID`, check: (v) => (/^-100\d{6,}$/.test(v) ? null : 'A channel ID looks like -1001234567890') };
  }
  if (type === 'steps' && P[part]) {
    return { label: `${P[part].name} sign-up steps (one step per line)`, check: (v) => (v.length <= 800 ? null : 'Maximum 800 characters') };
  }
  if (type === 'msg' && DEFAULT_MSG[part]) {
    return { label: MSG_LABELS[part], check: (v) => (v.length <= 1000 ? null : 'Maximum 1000 characters') };
  }
  if (key === 'link_ttl_min') {
    return { label: 'invite link expiry (minutes)', check: (v) => (/^\d+$/.test(v) && Number(v) >= 5 && Number(v) <= 1440 ? null : 'Send a number between 5 and 1440') };
  }
  return null;
}

function currentValue(key) {
  const [type, part] = key.split(':');
  if (type === 'ref') return getRef(part) || '(empty)';
  if (type === 'vip') return getVip(part) || '(not set)';
  if (type === 'steps') return getSteps(part);
  if (type === 'msg') return getSetting(`msg:${part}`, DEFAULT_MSG[part]);
  if (key === 'link_ttl_min') return String(getTtl());
  return '';
}

const back = (data) => Markup.button.callback('Back', data);

async function settingsHome(ctx) {
  const ch = getApproval();
  await show(
    ctx,
    `<b>Settings</b>\n\nApproval channel: ${ch ? `<code>${esc(ch)}</code>` : '<b>not set</b>'}\nInvite link expiry: ${getTtl()} minutes\n\nChoose what to edit.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Platforms', 'st:pl')],
      [Markup.button.callback('Messages', 'st:ms'), Markup.button.callback('Link expiry', 'st:ln')],
      [Markup.button.callback('Approval channel', 'st:ac'), Markup.button.callback('Admins', 'st:ad')],
    ])
  );
}

bot.command('settings', staffOnly(settingsHome));

bot.action(
  /^st:(.+)$/,
  staffAction(async (ctx) => {
    const arg = ctx.match[1];

    if (arg === 'home') return settingsHome(ctx);

    if (arg === 'pl') {
      const buttons = PLATFORMS.map((p) => Markup.button.callback(p.name, `st:p:${p.key}`));
      const rows = [];
      for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
      rows.push([back('st:home')]);
      return show(ctx, '<b>Platforms</b>\n\nChoose a platform to edit.', Markup.inlineKeyboard(rows));
    }

    if (arg.startsWith('p:')) {
      const pk = arg.slice(2);
      const p = P[pk];
      if (!p) return;
      const vip = getVip(pk);
      return show(
        ctx,
        `<b>${esc(p.name)} settings</b>\n\n` +
          `Referral link:\n<code>${esc(getRef(pk) || '(empty)')}</code>\n\n` +
          `VIP channel ID: <code>${esc(vip || 'not set')}</code>\n\n` +
          `Steps:\n${esc(getSteps(pk))}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Edit referral link', `se:ref:${pk}`)],
          [Markup.button.callback('Edit VIP channel', `se:vip:${pk}`)],
          [Markup.button.callback('Edit steps', `se:steps:${pk}`)],
          [back('st:pl')],
        ])
      );
    }

    if (arg === 'ms') {
      const rows = Object.keys(DEFAULT_MSG).map((k) => [Markup.button.callback(MSG_LABELS[k], `se:msg:${k}`)]);
      rows.push([back('st:home')]);
      return show(ctx, '<b>Messages</b>\n\nChoose a message to edit. You can use {platform} and {minutes} inside messages.', Markup.inlineKeyboard(rows));
    }

    if (arg === 'ln') {
      return show(
        ctx,
        `<b>Invite link expiry</b>\n\nCurrent: ${getTtl()} minutes.\nA link also stops working as soon as one person joins.`,
        Markup.inlineKeyboard([[Markup.button.callback('Change expiry', 'se:link_ttl_min')], [back('st:home')]])
      );
    }

    if (arg === 'ac') {
      const ch = getApproval();
      return show(
        ctx,
        `<b>Approval channel</b>\n\nCurrent: ${ch ? `<code>${esc(ch)}</code>` : '<b>not set</b>'}\n\nTo change it, an owner sends /setapproval to me in private and follows the steps.`,
        Markup.inlineKeyboard([[back('st:home')]])
      );
    }

    if (arg === 'ad') {
      const admins = [...staff].filter((id) => !isOwner(id));
      return show(
        ctx,
        `<b>Admins</b>\n\nOwners: ${OWNER_IDS.map((i) => `<code>${i}</code>`).join(', ')}\nAdmins: ${
          admins.length ? admins.map((i) => `<code>${i}</code>`).join(', ') : 'none'
        }\n\nAdmins can edit settings, export data and ban users. Owners can also add or remove admins with /addadmin and /removeadmin.\n\nAnyone inside the approval channel can Accept or Reject.`,
        Markup.inlineKeyboard([[back('st:home')]])
      );
    }
  })
);

bot.action(
  /^se:(.+)$/,
  staffAction(async (ctx) => {
    const key = ctx.match[1];
    const meta = settingMeta(key);
    if (!meta) return;
    await setState(ctx.from.id, `edit:${key}`);
    const cur = currentValue(key);
    await show(
      ctx,
      `<b>Edit ${esc(meta.label)}</b>\n\nCurrent value:\n<code>${esc(cur)}</code>\n\nSend the new value now.\nSend <code>reset</code> to restore the default, or /cancel to stop.`,
      Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'st:home')]])
    );
  })
);

async function handleEdit(ctx, key) {
  if (!isStaff(ctx.from.id)) {
    await setState(ctx.from.id, 'idle');
    return;
  }
  const meta = settingMeta(key);
  if (!meta) {
    await setState(ctx.from.id, 'idle');
    return ctx.reply('That setting no longer exists.');
  }
  const value = (ctx.message.text || '').trim();

  if (value.toLowerCase() === 'reset') {
    await resetSetting(key);
  } else {
    const err = meta.check(value);
    if (err) return ctx.reply(`${err}\n\nTry again, or send /cancel.`);
    await setSetting(key, value);
  }
  await setState(ctx.from.id, 'idle');
  await ctx.reply(`Saved: ${meta.label}.`, Markup.inlineKeyboard([[Markup.button.callback('Back to settings', 'st:home')]]));
}

/* ---- Admin management and approval channel binding ---- */
bot.command(
  'addadmin',
  ownerOnly(async (ctx) => {
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!Number.isFinite(id) || id <= 0) return ctx.reply('Use: /addadmin <telegram user id>');
    unwrap(await db.from('staff').upsert({ telegram_id: id, added_by: ctx.from.id }, { onConflict: 'telegram_id' }).select());
    staff.add(id);
    await ctx.reply(`User ${id} is now an admin.`);
  })
);

bot.command(
  'removeadmin',
  ownerOnly(async (ctx) => {
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!Number.isFinite(id) || id <= 0) return ctx.reply('Use: /removeadmin <telegram user id>');
    if (isOwner(id)) return ctx.reply('Owners cannot be removed here.');
    unwrap(await db.from('staff').delete().eq('telegram_id', id).select());
    staff.delete(id);
    await ctx.reply(`User ${id} is no longer an admin.`);
  })
);

bot.command(
  'admins',
  staffOnly(async (ctx) => {
    const admins = [...staff].filter((id) => !isOwner(id));
    await ctx.reply(`Owners: ${OWNER_IDS.join(', ')}\nAdmins: ${admins.length ? admins.join(', ') : 'none'}`);
  })
);

const bindCodes = new Map();
bot.command(
  'setapproval',
  ownerOnly(async (ctx) => {
    const code = crypto.randomBytes(4).toString('hex');
    bindCodes.set(code, { by: ctx.from.id, exp: Date.now() + 10 * 60_000 });
    await ctx.reply(
      `1. Add me to your approval channel as an admin (with permission to post messages).\n2. Within 10 minutes, post this exact text in that channel:\n\n/bind ${code}\n\nI will detect the channel and save it.`
    );
  })
);

bot.on('channel_post', async (ctx) => {
  const post = ctx.channelPost;
  const text = (post?.text || '').trim();

  if (/^\/chatid(@\w+)?$/i.test(text)) {
    return ctx.telegram.sendMessage(ctx.chat.id, `Chat ID: ${ctx.chat.id}`).catch(() => {});
  }

  const m = text.match(/^\/bind(@\w+)?\s+([a-f0-9]{8})$/i);
  if (!m) return;
  const code = m[2].toLowerCase();
  const entry = bindCodes.get(code);
  if (!entry || entry.exp < Date.now()) return;
  bindCodes.delete(code);

  await setSetting('approval_channel', String(ctx.chat.id));
  await ctx.telegram.deleteMessage(ctx.chat.id, post.message_id).catch(() => {});
  await ctx.telegram
    .sendMessage(ctx.chat.id, 'This channel is now the approval channel. New sign-ups will appear here with Accept and Reject buttons.')
    .catch(() => {});
  await bot.telegram.sendMessage(entry.by, `Approval channel saved: ${ctx.chat.title || ctx.chat.id}`).catch(() => {});
});

bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.chat;
  if (!['channel', 'group', 'supergroup'].includes(chat.type)) return;
  if (ctx.myChatMember.new_chat_member.status !== 'administrator') return;
  await alertOwners(`I was made an admin in "${chat.title}".\nChat ID: ${chat.id}`, true);
});

/* =============================================================
   8. STAFF TOOLS: stats, pending, export, find, user, ban, broadcast, health
   ============================================================= */
bot.command(
  'stats',
  staffOnly(async (ctx) => {
    const total = await countRows('bot_users');
    const banned = await countRows('bot_users', (q) => q.eq('banned', true));
    const lines = [`Users: ${total}`, `Banned: ${banned}`, ''];
    for (const p of PLATFORMS) {
      const [pending, approved, rejected] = await Promise.all(
        ['pending', 'approved', 'rejected'].map((s) =>
          countRows('submissions', (q) => q.eq('platform', p.key).eq('status', s))
        )
      );
      lines.push(`${p.name}: ${approved} approved, ${pending} pending, ${rejected} rejected`);
    }
    await ctx.reply(lines.join('\n'));
  })
);

bot.command(
  'pending',
  staffOnly(async (ctx) => {
    const rows = unwrap(
      await db.from('submissions').select('*').eq('status', 'pending').order('id', { ascending: true }).limit(10)
    );
    if (!rows.length) return ctx.reply('There are no pending sign-ups.');
    for (const row of rows) {
      const user = await getUserRow(row.telegram_id);
      const prev = await prevCount(row);
      await ctx.reply(cardText(row, user, prev, 'Status: <b>PENDING</b>'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...approvalButtons(row.id),
      });
    }
  })
);

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
}

bot.command(
  'export',
  staffOnly(async (ctx) => {
    const arg = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
    const platform = P[arg] ? arg : null;

    const rows = [];
    for (let from = 0; from < 50000; from += 1000) {
      let q = db
        .from('submissions')
        .select('id, created_at, platform, kind, value, status, telegram_id, decided_by_name, decided_at, bot_users(username, first_name)')
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (platform) q = q.eq('platform', platform);
      const page = unwrap(await q);
      rows.push(...page);
      if (page.length < 1000) break;
    }
    if (!rows.length) return ctx.reply('There is no data to export yet.');

    const header = ['ID', 'Submitted (UTC)', 'Platform', 'Type', 'Value', 'Status', 'Telegram ID', 'Username', 'Name', 'Decided by', 'Decided at (UTC)'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          stamp(r.created_at),
          P[r.platform]?.name || r.platform,
          r.kind === 'uid' ? 'UID' : 'Wallet',
          r.value,
          r.status,
          r.telegram_id,
          r.bot_users?.username ? `@${r.bot_users.username}` : '',
          r.bot_users?.first_name || '',
          r.decided_by_name || '',
          r.decided_at ? stamp(r.decided_at) : '',
        ]
          .map(csvCell)
          .join(',')
      );
    }
    const csv = '\uFEFF' + lines.join('\n');
    const date = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      { source: Buffer.from(csv, 'utf8'), filename: `vigil-export-${platform || 'all'}-${date}.csv` },
      { caption: `${rows.length} rows` }
    );
  })
);

bot.command(
  'find',
  staffOnly(async (ctx) => {
    const q = (ctx.message.text.split(/\s+/)[1] || '').trim();
    if (!/^[A-Za-z0-9]{4,64}$/.test(q)) return ctx.reply('Use: /find <uid, wallet or telegram id>');
    const conds = [`value_norm.eq.${q.toLowerCase()}`, `value_norm.eq.${q}`];
    if (/^\d+$/.test(q)) conds.push(`telegram_id.eq.${q}`);
    const rows = unwrap(await db.from('submissions').select('*').or(conds.join(',')).order('id').limit(10));
    if (!rows.length) return ctx.reply('Nothing found.');
    await ctx.reply(
      rows
        .map((r) => `#${r.id} ${P[r.platform]?.name || r.platform} ${r.kind}: ${r.value}\nStatus: ${r.status} | Telegram ID: ${r.telegram_id}`)
        .join('\n\n')
    );
  })
);

bot.command(
  'user',
  staffOnly(async (ctx) => {
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!id) return ctx.reply('Use: /user <telegram id>');
    const u = await getUserRow(id);
    if (!u) return ctx.reply('User not found.');
    const subs = unwrap(await db.from('submissions').select('*').eq('telegram_id', id).order('id'));
    const links = await countRows('invites', (q) => q.eq('telegram_id', id));
    await ctx.reply(
      [
        `User: ${userLabel(u)} (ID ${u.telegram_id})`,
        `Banned: ${u.banned ? 'yes' : 'no'}`,
        `Invite links created: ${links}`,
        '',
        ...(subs.length
          ? subs.map((s) => `${P[s.platform]?.name || s.platform} ${s.kind} ${s.value}: ${s.status}`)
          : ['No sign-ups']),
      ].join('\n')
    );
  })
);

function allVipChannels() {
  return [...new Set(PLATFORMS.map((p) => getVip(p.key)).filter(Boolean))];
}

bot.command(
  'ban',
  staffOnly(async (ctx) => {
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!id || isStaff(id)) return ctx.reply('Use: /ban <telegram id> (staff cannot be banned)');
    unwrap(
      await db.from('bot_users').upsert({ telegram_id: id, banned: true, updated_at: new Date().toISOString() }, { onConflict: 'telegram_id' }).select()
    );
    let removed = 0;
    for (const ch of allVipChannels()) {
      try {
        await bot.telegram.banChatMember(ch, id);
        removed++;
      } catch (e) {
        console.error('[ban]', e.message);
      }
    }
    await ctx.reply(`User ${id} is banned. Removed from ${removed} VIP channel(s).`);
  })
);

bot.command(
  'unban',
  staffOnly(async (ctx) => {
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!id) return ctx.reply('Use: /unban <telegram id>');
    unwrap(await db.from('bot_users').update({ banned: false }).eq('telegram_id', id).select());
    for (const ch of allVipChannels()) {
      await bot.telegram.unbanChatMember(ch, id, { only_if_banned: true }).catch(() => {});
    }
    await ctx.reply(`User ${id} is unbanned. They need a new approval to get a link again.`);
  })
);

bot.command(
  'health',
  staffOnly(async (ctx) => {
    const me = await bot.telegram.getMe();
    const lines = [`Bot: @${me.username}`, `Link expiry: ${getTtl()} min`, ''];

    const ch = getApproval();
    if (!ch) {
      lines.push('Approval channel: NOT SET (owner: /setapproval)');
    } else {
      try {
        const m = await bot.telegram.getChatMember(ch, me.id);
        const canPost = m.status === 'creator' || m.can_post_messages;
        lines.push(`Approval channel: ${m.status}${canPost ? ', can post' : ', CANNOT post'}`);
      } catch (e) {
        lines.push(`Approval channel: error (${e.message})`);
      }
    }

    for (const p of PLATFORMS) {
      const vip = getVip(p.key);
      let status = 'NOT SET';
      if (vip) {
        try {
          const m = await bot.telegram.getChatMember(vip, me.id);
          const canInvite = m.status === 'creator' || m.can_invite_users;
          status = `${m.status}${canInvite ? ', invite permission OK' : ', NO invite permission'}`;
        } catch (e) {
          status = `error (${e.message})`;
        }
      }
      lines.push(`${p.name}: referral ${getRef(p.key) ? 'set' : 'MISSING'}, VIP ${status}`);
    }
    await ctx.reply(lines.join('\n'));
  })
);

/* ---- Broadcast ---- */
const pendingBroadcast = new Map();

bot.command(
  'broadcast',
  staffOnly(async (ctx) => {
    const text = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/i, '').trim();
    if (!text) return ctx.reply('Use: /broadcast your message');
    pendingBroadcast.set(ctx.from.id, text);
    const total = await countRows('bot_users', (q) => q.eq('banned', false).eq('blocked', false));
    await ctx.reply(
      `Preview:\n\n${text}\n\nThis goes to ${total} users. Send it?`,
      Markup.inlineKeyboard([[Markup.button.callback('Yes, send', 'bc:yes'), Markup.button.callback('Cancel', 'bc:no')]])
    );
  })
);

async function sendWithRetry(userId, text) {
  try {
    await bot.telegram.sendMessage(userId, text);
    return 'ok';
  } catch (e) {
    const code = e.response?.error_code;
    if (code === 429) {
      await sleep(((e.response?.parameters?.retry_after || 5) + 1) * 1000);
      try {
        await bot.telegram.sendMessage(userId, text);
        return 'ok';
      } catch {
        return 'fail';
      }
    }
    if (code === 403) {
      await db.from('bot_users').update({ blocked: true }).eq('telegram_id', userId);
      return 'blocked';
    }
    return 'fail';
  }
}

async function runBroadcast(adminId, text) {
  let ok = 0;
  let blocked = 0;
  let fail = 0;
  try {
    for (let from = 0; ; from += 1000) {
      const rows = unwrap(
        await db
          .from('bot_users')
          .select('telegram_id')
          .eq('banned', false)
          .eq('blocked', false)
          .order('telegram_id')
          .range(from, from + 999)
      );
      if (!rows.length) break;
      for (const r of rows) {
        const res = await sendWithRetry(r.telegram_id, text);
        if (res === 'ok') ok++;
        else if (res === 'blocked') blocked++;
        else fail++;
        await sleep(50); // about 20 messages per second, under Telegram's limit
      }
      if (rows.length < 1000) break;
    }
  } catch (e) {
    console.error('[broadcast]', e);
  }
  await bot.telegram.sendMessage(adminId, `Broadcast finished.\nSent: ${ok}\nBlocked the bot: ${blocked}\nFailed: ${fail}`).catch(() => {});
}

bot.action(/^bc:(yes|no)$/, async (ctx) => {
  if (!isStaff(ctx.from.id)) return ctx.answerCbQuery('Not allowed.', { show_alert: true });
  const text = pendingBroadcast.get(ctx.from.id);
  pendingBroadcast.delete(ctx.from.id);
  if (!text) return ctx.answerCbQuery('This broadcast is no longer available.', { show_alert: true });
  if (ctx.match[1] === 'no') {
    await ctx.answerCbQuery('Cancelled');
    return ctx.editMessageText('Broadcast cancelled.').catch(() => {});
  }
  await ctx.answerCbQuery('Started');
  await ctx.editMessageText('Sending the broadcast. I will message you when it is done.').catch(() => {});
  runBroadcast(ctx.from.id, text); // runs in the background
});

/* =============================================================
   9. GROUP MODERATION (links from non-admins are removed)
   ============================================================= */
const adminCache = new Map();
async function isChatAdmin(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const hit = adminCache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60_000) return hit.v;
  try {
    const m = await bot.telegram.getChatMember(chatId, userId);
    const v = ['creator', 'administrator'].includes(m.status);
    adminCache.set(key, { v, t: Date.now() });
    return v;
  } catch {
    return false;
  }
}

function hostOf(raw) {
  try {
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    return new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isAllowedHost(raw) {
  const host = hostOf(raw);
  if (!host) return false;
  return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function extractUrls(text, entities) {
  const urls = [];
  for (const e of entities || []) {
    if (e.type === 'url') urls.push(text.substr(e.offset, e.length));
    if (e.type === 'text_link' && e.url) urls.push(e.url);
  }
  return urls;
}

const strikes = new Map();
const ANON_ADMIN_BOT_ID = 1087968824;

async function moderate(ctx) {
  const m = ctx.message || ctx.editedMessage;
  if (!m || !m.from || m.from.is_bot) return;
  if (m.sender_chat || m.from.id === ANON_ADMIN_BOT_ID || isStaff(m.from.id)) return;
  if (MOD_CHAT_IDS.length && !MOD_CHAT_IDS.includes(String(ctx.chat.id))) return;

  const text = m.text || m.caption || '';
  const urls = extractUrls(text, m.entities || m.caption_entities);
  if (!urls.length) return;
  if (urls.every(isAllowedHost)) return;
  if (await isChatAdmin(ctx.chat.id, m.from.id)) return;

  await ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {});

  const key = `${ctx.chat.id}:${m.from.id}`;
  const prev = strikes.get(key);
  const count = prev && Date.now() - prev.t < 24 * 3600 * 1000 ? prev.c + 1 : 1;
  strikes.set(key, { c: count, t: Date.now() });

  let notice;
  if (count >= MAX_STRIKES) {
    await ctx.telegram.banChatMember(ctx.chat.id, m.from.id).catch((e) => console.error('[mod] ban failed:', e.message));
    strikes.delete(key);
    notice = `${m.from.first_name || 'User'} was banned for posting spam links.`;
  } else {
    notice = `${m.from.first_name || 'User'}, links are not allowed in this group. Warning ${count}/${MAX_STRIKES}.`;
  }
  const sent = await ctx.telegram.sendMessage(ctx.chat.id, notice).catch(() => null);
  if (sent) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {}), 15_000);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of strikes) if (now - v.t > 24 * 3600 * 1000) strikes.delete(k);
  for (const [k, v] of adminCache) if (now - v.t > 5 * 60_000) adminCache.delete(k);
  for (const [k, v] of bindCodes) if (v.exp < now) bindCodes.delete(k);
}, 60 * 60_000).unref();

/* =============================================================
   10. MIDDLEWARE, TEXT HANDLER, STARTUP
   ============================================================= */
// Private chats: save the user and ignore banned users
bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'private' && ctx.from) {
    const u = await upsertUser(ctx.from);
    if (u.banned && !isStaff(ctx.from.id)) return;
    ctx.state.user = u;
  }
  return next();
});

// Groups: remove spam links
bot.use(async (ctx, next) => {
  if (['group', 'supergroup'].includes(ctx.chat?.type) && (ctx.message || ctx.editedMessage)) {
    await moderate(ctx).catch((e) => console.error('[mod] error:', e.message));
  }
  return next();
});

bot.on('text', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (ctx.message.text.startsWith('/')) return;

  const state = ctx.state.user?.state || 'idle';

  if (state.startsWith('input:')) {
    const [, pk, kind] = state.split(':');
    if (P[pk] && (kind === 'uid' || kind === 'wallet')) return handleInput(ctx, pk, kind);
  }
  if (state.startsWith('edit:')) return handleEdit(ctx, state.slice(5));

  return ctx.reply('Send /start to begin.');
});

bot.catch(async (err, ctx) => {
  console.error(`[bot] error (${ctx.updateType}):`, err);
  await alertOwners(`Bot error (${ctx.updateType}): ${err.message}`, true);
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  process.exit(1); // Railway restarts the app automatically
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => {
  try {
    await loadSettings();
    await loadStaff();
  } catch (e) {
    console.error('[startup] Database check failed. Did you run supabase.sql in Supabase? ->', e.message);
    process.exit(1);
  }

  const me = await bot.telegram.getMe();
  if (!getApproval()) console.warn('[config] Approval channel is not set yet. Owner: send /setapproval to the bot.');
  PLATFORMS.forEach((p) => {
    if (!getVip(p.key)) console.warn(`[config] No VIP channel set for ${p.name}`);
  });
  console.log(`[bot] @${me.username} is running. Owners: ${OWNER_IDS.join(', ')}`);

  bot
    .launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'edited_message', 'callback_query', 'channel_post', 'my_chat_member'],
    })
    .catch((e) => {
      console.error('[bot] launch failed:', e);
      process.exit(1);
    });
})().catch((e) => {
  console.error('[bot] startup failed:', e.message);
  process.exit(1);
});
