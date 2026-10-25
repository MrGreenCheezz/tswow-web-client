// The players' site in front of the game (bat\32, tools/start-server.mjs): the page server's routes.
//   /               the landing page (site/index.html): download the app, register, play in the browser
//   /site/…         its stylesheet and scripts (site/)
//   /play/          the game (dist/web/index.html); the bundles stay at /assets/…, other paths under
//                   /play/ are the game's own with the prefix dropped
//   /api/register   POST, open registration (tools/account-register.mjs)
//   anything else   the game's server as before: /assets/…, /player/… (the app and its updates)
// The player app's server.json names the server root, and an installed app keeps its server.json
// through updates, so a request for / from the app (an Electron user agent) is sent to /play/.

import { staticHandler } from "../electron/static-server.cjs";

const MAX_BODY_BYTES = 1024;
const ELECTRON = /\bElectron\//;

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  }).end(text);
}

function redirect(response, status, location) {
  response.writeHead(status, { Location: location, "Cache-Control": "no-cache" }).end();
}

/**
 * The body as JSON, `undefined` when it is not JSON, or `null` when it was too large or too slow
 * and the request has been dropped (nothing more can be answered on it).
 */
function readJson(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      resolve(null);
      request.destroy();
    }, 10_000);
    request.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer);
        resolve(null);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(value === null ? undefined : value);
      } catch {
        resolve(undefined);
      }
    });
    request.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Path and query of a request URL as sent (not decoded), or undefined. */
function splitUrl(requestUrl) {
  try {
    const url = new URL(requestUrl ?? "/", "http://127.0.0.1");
    return { path: url.pathname, query: url.search };
  } catch {
    return undefined;
  }
}

/**
 * The handler: `webRoot` is dist/web, `siteRoot` site/, `files` the extra mapped files (the player
 * app, as before), `register` the registrar or undefined when registration is off.
 */
export function playerSiteHandler({ webRoot, siteRoot, files, register }) {
  const game = staticHandler(webRoot, { compress: true, publicPages: ["/", "/index.html"], files });
  const site = staticHandler(siteRoot, { compress: true, publicPages: ["/index.html"] });
  return async (request, response) => {
    const url = splitUrl(request.url);
    if (url === undefined) {
      response.writeHead(400).end();
      return;
    }
    const { path, query } = url;
    if (path === "/api/register") {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      if (!register) {
        sendJson(response, 403, { error: "closed" });
        return;
      }
      if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
        sendJson(response, 415, { error: "bad-request" });
        return;
      }
      const body = await readJson(request);
      if (body === null) return;
      if (body === undefined) {
        sendJson(response, 400, { error: "bad-request" });
        return;
      }
      const result = await register(request.socket.remoteAddress ?? "", body);
      sendJson(response, result.status, result.body);
      return;
    }
    if (path === "/" || path === "/index.html") {
      if (ELECTRON.test(request.headers["user-agent"] ?? "")) {
        redirect(response, 302, `/play/${query}`);
        return;
      }
      request.url = `/index.html${query}`;
      site(request, response);
      return;
    }
    if (path === "/api/site") {
      sendJson(response, 200, { registration: Boolean(register) });
      return;
    }
    if (path === "/play") {
      redirect(response, 301, `/play/${query}`);
      return;
    }
    if (path.startsWith("/play/")) {
      request.url = `${path.slice("/play".length)}${query}`;
      game(request, response);
      return;
    }
    if (path.startsWith("/site/")) {
      request.url = `${path.slice("/site".length)}${query}`;
      site(request, response);
      return;
    }
    game(request, response);
  };
}
