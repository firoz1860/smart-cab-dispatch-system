import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { authRouter } from "./routes/auth";
import { adminRouter } from "./routes/admin";
import { driverRouter } from "./routes/driver";
import { guestRouter } from "./routes/guest";
import { initSocket } from "./realtime/socket";
import { startDispatchLoop } from "./engine/matchingEngine";

const app = express();
app.use(cors());
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
