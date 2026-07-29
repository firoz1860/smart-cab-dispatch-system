import type { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { AUTH_COOKIE_NAME } from "../middleware/auth";
import { isAllowedOrigin } from "../lib/corsOrigins";

let io: Server | null = null;

/** Extracts a single cookie's value from a raw `Cookie` header string.
 * Avoids depending on the `cookie` package here, whose published types don't
 * resolve under this project's `moduleResolution: "node"` - not worth
 * changing a global compiler setting just to parse one cookie name out of a
 * simple "a=b; c=d" string. */
function getCookieValue(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

interface SocketAuthPayload {
  userId: string;
  role: "ADMIN" | "DRIVER" | "GUEST";
  driverId?: string;
  guestId?: string;
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        callback(isAllowedOrigin(origin) ? null : new Error("Not allowed by CORS"), true);
      },
      credentials: true,
    },
  });

  // Same httpOnly session cookie as the REST API (see middleware/auth.ts) -
  // the browser attaches it to the socket handshake automatically as long as
  // the client connects with withCredentials, so there's no separate token
  // for client-side JavaScript to ever handle or leak.
  io.use((socket: Socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    const token = cookieHeader ? getCookieValue(cookieHeader, AUTH_COOKIE_NAME) : undefined;
    if (!token) return next(new Error("unauthorized"));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET as string) as SocketAuthPayload;
      (socket.data as SocketAuthPayload) = payload;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const auth = socket.data as SocketAuthPayload;
    // Room-based fan-out: admins see everything, drivers/guests only their own.
    if (auth.role === "ADMIN") socket.join("role:admin");
    if (auth.role === "DRIVER" && auth.driverId) socket.join(`driver:${auth.driverId}`);
    if (auth.role === "GUEST" && auth.guestId) socket.join(`guest:${auth.guestId}`);

    socket.on("driver:location", (data: { lat: number; lng: number }) => {
      if (auth.role !== "DRIVER" || !auth.driverId) return;
      io?.to("role:admin").emit("driver:location", { driverId: auth.driverId, ...data });
    });
  });

  return io;
}

export function emitDispatchEvent(event: string, payload: unknown): void {
  io?.to("role:admin").emit(event, payload);
}

export function emitToDriver(driverId: string, event: string, payload: unknown): void {
  io?.to(`driver:${driverId}`).emit(event, payload);
}

export function emitToGuest(guestId: string, event: string, payload: unknown): void {
  io?.to(`guest:${guestId}`).emit(event, payload);
}
