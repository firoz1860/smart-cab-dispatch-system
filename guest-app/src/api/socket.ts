import { io, type Socket } from "socket.io-client";
import { API_URL } from "./client";

let socket: Socket | null = null;

// withCredentials makes the browser attach the same httpOnly session cookie
// used for REST calls to the socket handshake - the backend authenticates the
// socket purely from that cookie (see backend/src/realtime/socket.ts), so no
// token is ever handled by client-side JavaScript.
export function getSocket(): Socket {
  if (socket) return socket;
  socket = io(API_URL, { withCredentials: true });
  return socket;
}

export function closeSocket(): void {
  socket?.disconnect();
  socket = null;
}
