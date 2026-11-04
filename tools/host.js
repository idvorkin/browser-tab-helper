#!/usr/bin/env node
// R7. The native messaging host: gives local tools the page in front and its selected text.
//
//   node tools/host.js install [extension id] [--dir <manifest dir>]   write Edge's host manifest
//   (the browser starts it with the extension's origin as an argument) run as the host
//
// Socket contract, documented in the README: one line of JSON in, {"type":"front"}, and one line out,
// {"title":str,"url":str,"selection":str|null} or {"error":str}, then close.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint, requireMacOS } from './entry.js';

export const HOST_NAME = 'browser_tab_helper';
const ANSWER_TIMEOUT_MS = 2000;
const MAX_REQUEST_BYTES = 64 * 1024;

const SELF = fileURLToPath(import.meta.url);
const CHECKOUT = dirname(dirname(SELF));

export function socketPath(env = process.env, platform = process.platform) {
  if (env.BROWSER_TAB_HELPER_SOCK) return env.BROWSER_TAB_HELPER_SOCK;
  requireMacOS('The socket path', platform);
  return join(homedir(), 'Library', 'Caches', 'browser-tab-helper', 'host.sock');
}

/** The id Chromium browsers give an unpacked extension: the path's SHA-256, first 16 bytes, hex digits mapped onto a to p. */
export function extensionIdForPath(path) {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16))).join('');
}

export function defaultManifestDir(platform = process.platform) {
  requireMacOS("Edge's host manifest directory", platform);
  return join(homedir(), 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts');
}

const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Writes the manifest and a launcher beside it. The browser starts the host with a bare environment where
 * `#!/usr/bin/env node` often finds no node, so the launcher names the node running this install.
 */
export function installHost({ platform = process.platform, dir = defaultManifestDir(platform), extensionId = extensionIdForPath(realpathSync(CHECKOUT)), nodePath = process.execPath } = {}) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error(`not an extension id: ${extensionId}`);
  mkdirSync(dir, { recursive: true });

  const launcherPath = join(dir, `${HOST_NAME}.sh`);
  writeFileSync(launcherPath, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(SELF)} "$@"\n`);
  chmodSync(launcherPath, 0o755);

  const manifestPath = join(dir, `${HOST_NAME}.json`);
  const manifest = {
    name: HOST_NAME,
    description: 'Browser tab helper: the front page for local tools',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, launcherPath, extensionId };
}

/** Native messaging's framing: a 4-byte native-endian length, then that much JSON. */
export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** Feed it chunks in any sizes; it calls onMessage once per whole frame. */
export function frameReader(onMessage) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32LE(0);
      if (buffered.length < 4 + size) return;
      const body = buffered.subarray(4, 4 + size);
      buffered = buffered.subarray(4 + size);
      onMessage(JSON.parse(body.toString()));
    }
  };
}

function answerLine(reply) {
  const answer = reply.error !== undefined
    ? { error: String(reply.error) }
    : { title: reply.title ?? '', url: reply.url ?? '', selection: reply.selection ?? null };
  return `${JSON.stringify(answer)}\n`;
}

function runHost(path = socketPath()) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // ponytail: a second browser or profile's host takes the socket over and the last one started answers. If two
  // profiles ever matter, name the socket per profile, which changes the contract in the README.
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const pending = new Map();
  let nextId = 1;

  const reply = (socket, line) => {
    if (!socket.destroyed) socket.end(line);
  };

  const server = net.createServer((socket) => {
    let received = '';
    const giveUp = setTimeout(() => reply(socket, answerLine({ error: 'no request line' })), ANSWER_TIMEOUT_MS);
    socket.on('error', () => {});
    socket.on('close', () => clearTimeout(giveUp));
    socket.on('data', (chunk) => {
      if (received === null) return;
      received += chunk.toString();
      const end = received.indexOf('\n');
      if (end < 0) {
        if (received.length > MAX_REQUEST_BYTES) {
          received = null;
          reply(socket, answerLine({ error: 'request too long' }));
        }
        return;
      }
      const line = received.slice(0, end);
      received = null;
      clearTimeout(giveUp);

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        reply(socket, answerLine({ error: 'request is not JSON' }));
        return;
      }
      if (request?.type !== 'front') {
        reply(socket, answerLine({ error: `unknown request type: ${request?.type}` }));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reply(socket, answerLine({ error: 'the extension did not answer' }));
      }, ANSWER_TIMEOUT_MS);
      pending.set(id, { socket, timer });
      process.stdout.write(encodeFrame({ type: 'front', id }));
    });
  });

  const read = frameReader((message) => {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    reply(waiting.socket, answerLine(message));
  });

  let socketInode = null;
  const stop = () => {
    // Only remove the socket if it is still ours; a newer host may have replaced it.
    try {
      if (socketInode !== null && statSync(path).ino === socketInode) unlinkSync(path);
    } catch {
      // Already gone.
    }
    process.exit(0);
  };

  process.stdin.on('data', read);
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdout.on('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  // The directory is already 0700; the umask makes the socket 0600 from the moment it exists.
  process.umask(0o177);
  server.listen(path, () => {
    chmodSync(path, 0o600);
    socketInode = statSync(path).ino;
    process.stderr.write(`browser-tab-helper host listening on ${path}\n`);
  });
}

function runInstall(argv) {
  const args = [...argv];
  let dir;
  const at = args.indexOf('--dir');
  if (at >= 0) {
    [, dir] = args.splice(at, 2);
    if (!dir) throw new Error('--dir needs a directory');
    dir = resolve(dir);
  }
  const { manifestPath, extensionId } = installHost({ dir, extensionId: args[0] });
  console.log(`Wrote ${manifestPath}`);
  console.log(`Allows chrome-extension://${extensionId}/`);
  console.log('Reload the extension so the browser starts the host.');
}

const USAGE = `usage: host install [extension id] [--dir <manifest dir>]

With no id it allows the id Chromium browsers give an unpacked extension loaded from this checkout.
Otherwise the browser starts this script itself, passing the extension's origin.`;

if (isEntryPoint(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'install') {
    try {
      runInstall(rest);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else if (command?.startsWith('chrome-extension://')) {
    runHost();
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}
