import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { authRouter } from "./routes/auth";
import { adminRouter } from "./routes/admin";
import { driverRouter } from "./routes/driver";
import { guestRouter } from "./routes/guest";
import { stripeWebhookRouter } from "./routes/stripeWebhook";
import { initSocket } from "./realtime/socket";
import { startDispatchLoop } from "./engine/matchingEngine";
import { isAllowedOrigin } from "./lib/corsOrigins";

const app = express();

// credentials: true is required so the browser sends/accepts the httpOnly
// session cookie cross-origin (frontend and backend run on different ports
// in dev) - which in turn requires naming specific origins, not "*".
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(cookieParser());

// Stripe webhook needs the raw request body to verify its signature, so it
// must be mounted with express.raw() BEFORE the global express.json() below
// - once express.json() has consumed the body, the raw bytes are gone.
app.use("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookRouter);

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/driver", driverRouter);
app.use("/guest", guestRouter);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const httpServer = createServer(app);
initSocket(httpServer);
startDispatchLoop();

const port = Number(process.env.PORT ?? 4000);
httpServer.listen(port, () => {
  console.log(`Smart Cab Dispatch backend listening on :${port}`);
});
