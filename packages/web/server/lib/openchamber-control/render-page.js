import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { inspectLocalImage } from '../markdown-image-grants/inspect-image.js';
import { isString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

// The page travels in the tool call's input or, for a page the agent names by
// file, in the call's metadata. OpenCode stores both with the message and
// streams them to every client, and the page crosses the callback request,
// whose JSON body is capped at 1 MB. 200,000 characters stays under that cap
// even for text that encodes to several bytes per character, and is far more
// than a chart or table page needs.
export const RENDER_PAGE_MAX_HTML_LENGTH = 200_000;
// What 200,000 characters take as UTF-8 at most (three bytes each), plus a BOM.
// A file past this cannot hold a page within the limit, so it is refused
// before it is read.
const RENDER_PAGE_MAX_FILE_BYTES = RENDER_PAGE_MAX_HTML_LENGTH * 3 + 3;
export const RENDER_PAGE_MAX_TITLE_LENGTH = 120;
// An answer is a choice and a few values, never a document: the page sends
// what the user picked and the agent builds the rest itself.
const RENDER_PAGE_MAX_SUMMARY_LENGTH = 500;
const RENDER_PAGE_MAX_ANSWER_DATA_LENGTH = 16_000;

// A local image a page names by its absolute path: a quoted string (an src
// attribute, a CSS url("..."), a string in the page's script) or an unquoted
// CSS url(...). The chat swaps each for the file's contents before drawing the
// page, which cannot read files itself. The UI reads pages with the same rule
// (packages/ui/src/components/chat/message/parts/renderPageImages.ts).
// A quoted path may hold spaces (macOS names screenshots that way); an
// unquoted url() ends at the first space or parenthesis.
const LOCAL_IMAGE_RE = /(["'`])((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>\n]*?\.(?:png|jpe?g|gif|webp))\1|url\(\s*((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>()\s]*?\.(?:png|jpe?g|gif|webp))\s*\)/gi;
// How much the local images a page shows may weigh together, in file bytes.
// The chat reads each one into the page as a data URL, and the browser holds
// it decoded on top, so the weight of a page is what bounds the chat's memory.
export const RENDER_PAGE_IMAGE_BUDGET_BYTES = 25 * 1024 * 1024;

/** The local image paths a page names, in order, once each. */
export const renderPageImageSources = (html) => {
  const sources = new Set();
  for (const match of html.matchAll(LOCAL_IMAGE_RE)) sources.add(match[2] ?? match[3]);
  return [...sources];
};

/**
 * Checks every local image a page names and decides which the chat shows: in
 * page order, while their sizes add up to at most the budget. From the first
 * image that does not fit on, none does (`too-heavy`), so the page shows a
 * run from its top. A missing or unreadable image weighs nothing.
 * `inspect(source)` resolves to what `inspectLocalImage` does. The image grant
 * route serves a page with this rule and the agent is told with it, so both
 * agree on what the user sees.
 */
export const fitRenderPageImages = async (html, inspect) => {
  const images = [];
  let shownBytes = 0;
  let totalBytes = 0;
  let full = false;
  for (const source of renderPageImageSources(html)) {
    const inspected = await inspect(source);
    if (inspected.status !== 'ready') {
      images.push({ source, ...inspected });
      continue;
    }
    totalBytes += inspected.size;
    full = full || shownBytes + inspected.size > RENDER_PAGE_IMAGE_BUDGET_BYTES;
    if (full) {
      images.push({ source, status: 'too-heavy', size: inspected.size });
      continue;
    }
    shownBytes += inspected.size;
    images.push({ source, ...inspected });
  }
  return { images, totalBytes };
};

const NOT_SHOWN_REASONS = {
  'too-heavy': 'past the page budget',
  missing: 'file not found',
  error: 'not a readable PNG, JPEG, GIF or WebP of at most 10 MB',
};
const toMegabytes = (bytes) => Math.round(bytes / (1024 * 1024) * 10) / 10;

/**
 * What the agent hears about the page's local images the user will not see,
 * or null when every one shows. Without it the agent heard "shown" and
 * reported a gallery whose later images were broken.
 */
const describeHiddenImages = async (html, directory) => {
  const { images, totalBytes } = await fitRenderPageImages(html, (source) => (
    inspectLocalImage({ source, directory, fsPromises: fs, path }).catch(() => ({ status: 'error' }))
  ));
  const hidden = images.filter((image) => image.status !== 'ready');
  if (hidden.length === 0) return null;
  const tooHeavy = hidden.some((image) => image.status === 'too-heavy');
  return {
    images: {
      shown: images.length - hidden.length,
      notShown: hidden.map((image) => ({ src: image.source, reason: NOT_SHOWN_REASONS[image.status] })),
      ...(tooHeavy && { weightMB: toMegabytes(totalBytes), budgetMB: toMegabytes(RENDER_PAGE_IMAGE_BUDGET_BYTES) }),
    },
    note: tooHeavy
      ? 'Some local images on the page do not show; images.notShown says which. A page shows its images in page order while their files add up to at most budgetMB, and these weigh weightMB: split the page or use smaller images.'
      : 'Some local images on the page do not show; images.notShown says which and why.',
  };
};

// A page sent without a title is named after its own <title>, else its first
// h1 to h3, else "Page". Weaker models sent title and html in separate calls,
// and every call refused for a missing title cost the whole page again. The
// chat names such a page with the same rule (pageTitleFromHtml in
// packages/ui/src/lib/opencode/tools.ts); change both together.
const TITLE_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const elementText = (html, pattern) => (pattern.exec(html)?.[1] ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, entity) => TITLE_ENTITIES[entity])
  .replace(/\s+/g, ' ')
  .trim();
const renderPageTitleFromHtml = (html) => (
  elementText(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)
  || elementText(html, /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)
).slice(0, RENDER_PAGE_MAX_TITLE_LENGTH).trim();
const RENDER_PAGE_FALLBACK_TITLE = 'Page';

const SHOWN_NOTE = "Shown to the user in the chat above your reply. Don't announce, describe or restate the page; reply with only what it doesn't already say.";

const ANSWERED_NOTE = "The user answered on the page. summary is their choice in words, data is what the page sent. Continue the task from it; the chat already shows the summary under the page, so don't repeat it back.";

/**
 * What the agent reads when the user wrote in the chat instead of answering on
 * the page. The plugin builds that result itself (see ../agent-tool/runtime.js),
 * because the wait ends there, before this server hears of it.
 */
export const RENDER_PAGE_CLOSED_IN_CHAT_NOTE = "The user did not answer on the page and wrote in the chat instead; their message follows this result. Continue from that message and don't ask the same question on a page again unless they want it.";

const htmlTooLong = (length) => new OpenChamberControlError(`html is ${length} characters; the limit is ${RENDER_PAGE_MAX_HTML_LENGTH}. Make the page smaller, for example by drawing data with a script instead of writing out every element`, 400);

const HTML_FILE_RE = /\.html?$/i;
const NOT_AN_HTML_FILE = 'path must name an .html or .htm file';

/**
 * The page held by an .html file the agent named, read once when its call runs.
 * The file may be anywhere the server can read, as the local images a page
 * names may be, and only the agent's own call reaches this. The name and the
 * file it resolves to must both be HTML, so a link cannot present another file
 * as a page, and the handle that is checked is the one that is read.
 */
const readPageFile = async (filePath) => {
  const requested = isString(filePath) ? filePath.trim() : '';
  if (!requested) {
    throw new OpenChamberControlError('path is required: the absolute path of an .html or .htm file', 400);
  }
  if (!path.isAbsolute(requested)) {
    throw new OpenChamberControlError(`path must be absolute, such as /tmp/page.html; "${requested}" is not (a relative path, "~" and file:// are not accepted)`, 400);
  }
  if (!HTML_FILE_RE.test(requested)) {
    throw new OpenChamberControlError(NOT_AN_HTML_FILE, 400);
  }
  const unreadable = (error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return new OpenChamberControlError(`No file at ${requested}`, 404);
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ELOOP') {
      return new OpenChamberControlError(`${requested} cannot be read`, 403);
    }
    return error;
  };
  let handle;
  try {
    const target = await fs.realpath(requested);
    if (!HTML_FILE_RE.test(target)) {
      throw new OpenChamberControlError(`${NOT_AN_HTML_FILE}; ${requested} points to ${target}`, 400);
    }
    handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new OpenChamberControlError(`${requested} is not a regular file`, 400);
    }
    if (stat.size > RENDER_PAGE_MAX_FILE_BYTES) {
      throw new OpenChamberControlError(`${requested} is too large: ${stat.size} bytes; a page is at most ${RENDER_PAGE_MAX_HTML_LENGTH} characters`, 400);
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const html = buffer.toString('utf8', 0, bytesRead).replace(/^﻿/, '');
    if (!html.trim()) {
      throw new OpenChamberControlError(`${requested} is empty`, 400);
    }
    if (html.length > RENDER_PAGE_MAX_HTML_LENGTH) throw htmlTooLong(html.length);
    return html;
  } catch (error) {
    throw error instanceof OpenChamberControlError ? error : unreadable(error);
  } finally {
    await handle?.close();
  }
};

const pageKey = (sessionId, callId) => `${sessionId}\u0000${callId}`;

const requirePageIds = (input = {}) => {
  const sessionId = isString(input.sessionId) ? input.sessionId.trim() : '';
  const callId = isString(input.callId) ? input.callId.trim() : '';
  if (!sessionId || !callId) {
    throw new OpenChamberControlError('sessionId and callId are required', 400);
  }
  return { sessionId, callId };
};

const NOT_WAITING = 'This page is no longer waiting for an answer';

/**
 * Pages that wait for the user's answer, keyed by session and tool call. The
 * call's request stays open while its page waits: an answer resolves it, and an
 * aborted request (the user stopped the turn, wrote in the chat, or OpenCode
 * went away) drops it. Nothing is kept once a call ends, so a page answers at
 * most once and a stale answer finds nothing to resolve.
 *
 * A waiting call also holds its page and title, only until the wait ends. The
 * stored copy of a running call has no metadata, so a client that reloads or
 * connects during the wait asks `page` for what to draw (a page named by file
 * is not in the call's input).
 *
 * `onWaitChange` hears when a page starts and stops waiting, so the server can
 * show the session as waiting for the user the way it does for a form.
 */
export const createPageAnswers = ({ onWaitChange = () => {} } = {}) => {
  const waiting = new Map();

  // A listener failure must not break the call the user is answering.
  const announce = (change) => {
    try {
      onWaitChange(change);
    } catch (error) {
      console.warn('[render.page] wait listener failed:', error?.message ?? error);
    }
  };

  const wait = ({ sessionId, callId, title, html, directory, signal }) => new Promise((resolve, reject) => {
    const key = pageKey(sessionId, callId);
    if (waiting.has(key)) {
      reject(new OpenChamberControlError('This call already shows a page that waits for an answer', 409));
      return;
    }
    if (signal?.aborted) {
      reject(new OpenChamberControlError('The page stopped waiting before the user answered', 499));
      return;
    }
    const onAbort = () => {
      waiting.delete(key);
      announce({ type: 'settled', sessionId, callId });
      reject(new OpenChamberControlError('The page stopped waiting before the user answered', 499));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.set(key, {
      html,
      title,
      resolve: (answer) => {
        waiting.delete(key);
        signal?.removeEventListener('abort', onAbort);
        announce({ type: 'settled', sessionId, callId });
        resolve(answer);
      },
    });
    announce({ type: 'waiting', sessionId, callId, title, directory: directory || null });
  });

  const page = (input) => {
    const { sessionId, callId } = requirePageIds(input);
    const held = waiting.get(pageKey(sessionId, callId));
    if (!held) throw new OpenChamberControlError(NOT_WAITING, 404);
    return { html: held.html, title: held.title };
  };

  const answer = (input = {}) => {
    const { sessionId, callId } = requirePageIds(input);
    const summary = isString(input.summary) ? input.summary.trim() : '';
    if (!summary) {
      throw new OpenChamberControlError('summary is required: what the user chose, in a few words', 400);
    }
    if (summary.length > RENDER_PAGE_MAX_SUMMARY_LENGTH) {
      throw new OpenChamberControlError(`summary is ${summary.length} characters; the limit is ${RENDER_PAGE_MAX_SUMMARY_LENGTH}`, 400);
    }
    const data = input.data === undefined ? null : input.data;
    const dataLength = JSON.stringify(data).length;
    if (dataLength > RENDER_PAGE_MAX_ANSWER_DATA_LENGTH) {
      throw new OpenChamberControlError(`data is ${dataLength} characters as JSON; the limit is ${RENDER_PAGE_MAX_ANSWER_DATA_LENGTH}`, 413);
    }
    const held = waiting.get(pageKey(sessionId, callId));
    if (!held) {
      throw new OpenChamberControlError(NOT_WAITING, 404);
    }
    held.resolve({ answered: true, summary, data });
    return { answered: true };
  };

  return { wait, answer, page };
};

/**
 * `render.page`: the chat draws the page from the call's input, or from the
 * call's metadata when the agent named a file, so this checks that the page is
 * one the chat will draw and that the tool is still on (a plugin generated
 * before it was switched off must not keep drawing). In the `load` stage it
 * reads the file the agent named and hands its HTML back for the plugin to
 * send; the page is then checked like any other. With `awaitAnswer` the call
 * waits for the user's answer.
 */
export const createRenderPageAction = ({ isEnabled, pageAnswers }) => async (input, { sessionId, callId, directory, signal, stage } = {}) => {
  if (!await isEnabled()) {
    throw new OpenChamberControlError('The render tool is turned off in OpenChamber settings', 403);
  }
  if (stage === 'load') {
    return { html: await readPageFile(input.path) };
  }
  const html = isString(input.html) ? input.html : '';
  // The plugin swaps a path for the html it loaded, so a path that arrives here
  // came from a connection that cannot load files.
  if (isString(input.path) && input.path.trim()) {
    throw new OpenChamberControlError(html
      ? 'Send html or path, not both'
      : 'This connection cannot load a file; send html', 400);
  }
  if (!html.trim()) {
    throw new OpenChamberControlError('html or path is required: one complete, self-contained HTML document, or the absolute path of an .html file holding one. Send it and the title in one call', 400);
  }
  if (html.length > RENDER_PAGE_MAX_HTML_LENGTH) throw htmlTooLong(html.length);
  const title = (isString(input.title) ? input.title.trim() : '')
    || renderPageTitleFromHtml(html)
    || RENDER_PAGE_FALLBACK_TITLE;
  if (title.length > RENDER_PAGE_MAX_TITLE_LENGTH) {
    throw new OpenChamberControlError(`title is ${title.length} characters; the limit is ${RENDER_PAGE_MAX_TITLE_LENGTH}`, 400);
  }
  const hidden = await describeHiddenImages(html, directory);
  if (input.awaitAnswer !== true) {
    return hidden
      ? { shown: true, title, note: `${SHOWN_NOTE} ${hidden.note}`, images: hidden.images }
      : { shown: true, title, note: SHOWN_NOTE };
  }
  // A plugin generated before pages could wait sends no call id.
  if (!sessionId || !callId) {
    throw new OpenChamberControlError('This connection cannot wait for an answer on a page; show the page without awaitAnswer and ask in text', 400);
  }
  const answer = await pageAnswers.wait({ sessionId, callId, title, html, directory, signal });
  return hidden
    ? { title, answer, note: `${ANSWERED_NOTE} ${hidden.note}`, images: hidden.images }
    : { title, answer, note: ANSWERED_NOTE };
};
