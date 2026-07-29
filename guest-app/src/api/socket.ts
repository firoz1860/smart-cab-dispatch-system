import { io, type Socket } from "socket.io-client";
import { API_URL } from "./client";

let socket: Socket | null = null;

export function getSocket(token: string): Socket {
  if (socket) return socket;
  socket = io(API_URL, { auth: { token } });
  return socket;
}

export function closeSocket(): void {
  socket?.disconnect();
  socket = null;
}
