import { Server as SocketIOServer } from "socket.io";
import { Server as HttpServer } from "http";

let io: SocketIOServer | null = null;

/**
 * Initialize Socket.io server with the HTTP server
 */
export function initializeSocketServer(httpServer: HttpServer, allowedOrigins: string[]) {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[Socket.io] Client disconnected: ${socket.id}, reason: ${reason}`);
    });

    socket.on("error", (error) => {
      console.error(`[Socket.io] Socket error: ${socket.id}`, error);
    });
  });

  console.log("[Socket.io] Server initialized successfully");
  return io;
}

/**
 * Get the Socket.io server instance
 */
export function getSocketServer(): SocketIOServer | null {
  return io;
}

/**
 * Emit order created event to all connected clients
 */
export function emitOrderCreated(order: any) {
  if (!io) {
    console.warn("[Socket.io] Cannot emit order:created - server not initialized");
    return;
  }
  io.emit("order:created", order);
  console.log(`[Socket.io] Emitted order:created for order ${order._id || order.orderNumber}`);
}

/**
 * Emit order updated event to all connected clients
 */
export function emitOrderUpdated(order: any) {
  if (!io) {
    console.warn("[Socket.io] Cannot emit order:updated - server not initialized");
    return;
  }
  io.emit("order:updated", order);
  console.log(`[Socket.io] Emitted order:updated for order ${order._id || order.orderNumber}`);
}

/**
 * Emit order status changed event to all connected clients
 */
export function emitOrderStatusChanged(order: any, previousStatus?: string) {
  if (!io) {
    console.warn("[Socket.io] Cannot emit order:statusChanged - server not initialized");
    return;
  }
  io.emit("order:statusChanged", { 
    order, 
    previousStatus,
    newStatus: order.status 
  });
  console.log(`[Socket.io] Emitted order:statusChanged for order ${order._id || order.orderNumber} (${previousStatus} → ${order.status})`);
}
