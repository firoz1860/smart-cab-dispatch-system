import type { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";

let io: Server | null = null;

interface SocketAuthPayload {
  userId: string;
  role: "ADMIN" | "DRIVER" | "GUEST";
  driverId?: string;
  guestId?: string;
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, { cors: { origin: "*" } });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
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
