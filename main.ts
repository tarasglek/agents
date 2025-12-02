import { Hono } from "@hono/hono";
import type { Context } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { serveDir } from "@std/http/file-server";
import { emailRegexpChecker, getSecret, Locker } from "@tarasglek/locker";

let locker: typeof Locker | undefined;

const app = new Hono();

app.use("*", async (c, next) => {
  const host = c.req.header("x-forwarded-host");
  if (host) {
    if (!locker) {
      locker = await Locker.init({
        domain: host,
        secret: await getSecret(host + import.meta.url),
        oidc_issuer: "https://lastlogin.net/",
        checker: emailRegexpChecker([".*@glek.net$"]),
      });
    }
  }
  await next();
}).use(logger())
  .get("/logout", async (c) => {
    await locker!.revokeSession(c as Context);
    return c.html(
      `You have been successfully logged out! <a href="/">home</a>`,
    );
  })
  .use("*", (c, next) => locker!.oidcAuthMiddleware()(c, next))
  .use("*", (c, next) => locker!.check()(c, next))
  .get("/", async (c) => {
    // try to serve static/index.html or if it doesnt exist serve below as fallback AI!
    const auth = await locker!.getAuth(c);
    console.log("auth:", auth);
    return c.html(`Hello &lt;${auth?.email}&gt;! <a href="/logout">Logout</a>`);
  })
  .get(
    "/*",
    (c) => {
      // this actually includes content-length unlike hono's serveStatic
      return serveDir(c.req.raw, {
        fsRoot: "static",
      });
    },
  );

export default app;
